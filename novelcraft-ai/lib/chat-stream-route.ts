import { consumeStream, streamText, type StopCondition, type ToolSet } from 'ai';
import { toModelMessages, type ChatMessage } from '@/lib/ai';
import type { GenerationPreset } from '@/lib/ai/generation-presets';
import type { Message } from '@/lib/db-types';
import { createAIStreamLifecycle, createUsageSettlement, type AIUsageSession } from '@/lib/ai-usage';
import { serializeAIError } from '@/lib/ai-error';
import { getUIMessageText, type NovelChatUIMessage } from '@/lib/chat-ui-message';
import {
  createChatTurnActiveClaimLease,
  type ChatTurnActiveClaim,
  type ChatTurnActiveClaimLeaseOptions,
} from '@/lib/chat-turn-lease';

export interface ChatTurnPersistence {
  persistUser(id: string): Promise<Message>;
  persistAssistant(id: string, text: string): Promise<Message>;
  persistStoppedAssistant?(id: string, text: string): Promise<Message | null>;
  /** Durable turn receipt: provider error while still running. */
  markFailed?(): Promise<void>;
  /** Durable turn receipt: aborted without a persisted assistant reply. */
  markCancelled?(): Promise<void>;
}

export interface StreamChatTurnArgs {
  aiUsage: AIUsageSession;
  requestSignal: AbortSignal;
  system: string;
  history: ChatMessage[];
  preset: GenerationPreset;
  persistence: ChatTurnPersistence;
  originalMessages: NovelChatUIMessage[];
  submittedUserMessage: NovelChatUIMessage;
  responseMessageId: string;
  /** Token-bound active claim shared by ordinary, brainstorm, and conversation streams. */
  activeClaim: ChatTurnActiveClaim;
  /** Optional lease overrides (tests / diagnostics). */
  claimLease?: Pick<ChatTurnActiveClaimLeaseOptions, 'deadlineMs' | 'heartbeatMs' | 'renewClaim'>;
  stoppedLabel?: string;
  headers?: HeadersInit;
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
}

export async function streamChatTurnResponse(args: StreamChatTurnArgs): Promise<Response> {
  const {
    aiUsage,
    requestSignal,
    system,
    history,
    preset,
    persistence,
    originalMessages,
    submittedUserMessage,
    responseMessageId,
    activeClaim,
    claimLease,
    stoppedLabel,
    headers,
    tools,
    stopWhen,
  } = args;

  const activeClaimLease = createChatTurnActiveClaimLease({
    ...activeClaim,
    requestSignal,
    ...claimLease,
  });
  const lifecycle = createAIStreamLifecycle(activeClaimLease.signal);
  const usage = createUsageSettlement(aiUsage);
  let assistantMessage: Message | null = null;
  let userPersisted = false;
  let stoppedAssistantPersisted = false;

  const persistUserOnce = async () => {
    if (userPersisted) return;
    userPersisted = true;
    await persistence.persistUser(submittedUserMessage.id);
  };

  const shouldSkipWorkerSideEffects = () => activeClaimLease.hasLostClaim();

  let result: ReturnType<typeof streamText>;
  try {
    activeClaimLease.start();
    await persistUserOnce();
    result = streamText({
      model: aiUsage.model,
      system,
      messages: toModelMessages(history),
      tools,
      stopWhen,
      ...preset,
      abortSignal: lifecycle.signal,
      onFinish: async ({ text, usage: modelUsage, finishReason }) => {
        try {
          if (shouldSkipWorkerSideEffects()) {
            await usage.cancelOnce(modelUsage);
            return;
          }
          aiUsage.addPartialOutput(text);
          if (lifecycle.isCancelled()) {
            // Durable claim/partial persist stays with UI-stream onFinish.
            // When core finish still runs on cancel, capture cumulative text and
            // settle provider usage here before the exactly-once latch.
            await usage.cancelOnce(modelUsage);
            return;
          }
          try {
            if (text.trim()) {
              assistantMessage = await persistence.persistAssistant(responseMessageId, text);
            } else {
              await persistence.markFailed?.().catch((error) => {
                console.error('Failed to mark empty-provider chat turn failed:', error);
              });
            }
            await usage.recordOnce(modelUsage, finishReason);
          } catch (error) {
            // SDK may swallow onFinish errors before onError. Guarantee one
            // terminal usage settlement for every assistant persistence outcome.
            if (shouldSkipWorkerSideEffects()) {
              await usage.cancelOnce(modelUsage);
            } else {
              await usage.failOnce();
              await persistence.markFailed?.().catch((markError) => {
                console.error('Failed to mark failed chat turn after persist error:', markError);
              });
            }
            console.error('Failed to persist assistant chat turn:', error);
          }
        } finally {
          activeClaimLease.dispose();
        }
      },
      // No onAbort settlement: AI SDK 6.0.208 invokes onAbort without awaiting it,
      // before UI onFinish has responseMessage. Request abort + consumeSseStream
      // already drive cleanup; cancelled usage settles from core/UI onFinish.
      onError: async () => {
        try {
          if (shouldSkipWorkerSideEffects()) {
            await usage.cancelOnce();
            return;
          }
          if (lifecycle.isCancelled()) {
            // Do not settle usage or markCancelled: packaged Stop often delivers
            // core onError before UI onFinish has the visible partial. Settling
            // here latches null output_tokens/generated_words; cancelling the
            // claim first drops persistStoppedAssistant.
            return;
          }
          await usage.failOnce();
          await persistence.markFailed?.().catch((error) => {
            console.error('Failed to mark failed chat turn:', error);
          });
        } finally {
          activeClaimLease.dispose();
        }
      },
    });
  } catch (error) {
    const wasCancelled = lifecycle.isCancelled();
    const lostClaim = shouldSkipWorkerSideEffects();
    lifecycle.cancel();
    activeClaimLease.dispose();
    if (lostClaim) {
      await usage.cancelOnce();
      throw error;
    }
    if (wasCancelled) {
      // streamText threw before a UI stream existed — no onFinish({ isAborted }).
      await usage.cancelOnce();
      await persistence.markCancelled?.().catch((markError) => {
        console.error('Failed to mark cancelled chat turn:', markError);
      });
    } else {
      await usage.failOnce();
      await persistence.markFailed?.().catch((markError) => {
        console.error('Failed to mark failed chat turn:', markError);
      });
    }
    throw error;
  }

  const persistStoppedAssistantOnce = async (text: string) => {
    if (stoppedAssistantPersisted) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    stoppedAssistantPersisted = true;
    const content = stoppedLabel?.trim() ? `${trimmed}\n\n${stoppedLabel.trim()}` : trimmed;
    const persistStopped = persistence.persistStoppedAssistant ?? persistence.persistAssistant;
    assistantMessage = await persistStopped(responseMessageId, content);
  };

  try {
    return result.toUIMessageStreamResponse<NovelChatUIMessage>({
      originalMessages,
      generateMessageId: () => responseMessageId,
      // AI SDK's UI stream transports errors as strings. Encode a versioned,
      // sanitized payload so the renderer can localize the category without
      // exposing provider response bodies or credentials.
      onError: error => serializeAIError(error),
      onFinish: async ({ responseMessage, isAborted }) => {
        try {
          if (shouldSkipWorkerSideEffects()) {
            await usage.cancelOnce();
            return;
          }
          if (!isAborted) return;
          // Capture visible stopped text before the exactly-once usage latch so
          // estimated output_tokens/generated_words are non-null for partials.
          const stoppedText = getUIMessageText(responseMessage);
          aiUsage.addPartialOutput(stoppedText);
          await usage.cancelOnce();
          try {
            await persistStoppedAssistantOnce(stoppedText);
            if (!stoppedText.trim()) {
              await persistence.markCancelled?.();
            }
          } catch (error) {
            console.error('Failed to persist stopped assistant message:', error);
            await persistence.markCancelled?.().catch((markError) => {
              console.error('Failed to mark cancelled chat turn:', markError);
            });
          }
        } finally {
          activeClaimLease.dispose();
        }
      },
      // Required by AI SDK abort handling: tee + independently consume the SSE
      // stream so onFinish({ isAborted: true }) still runs after the client Stop
      // cancels the response body (see ai docs stopping-streams / stream-abort-handling).
      consumeSseStream: consumeStream,
      messageMetadata: ({ part }) => {
        if (part.type === 'start') {
          return { persisted: false };
        }
        if (part.type === 'finish' && assistantMessage) {
          return {
            persisted: true,
            createdAt: assistantMessage.createdAt,
            conversationId: assistantMessage.conversationId ?? null,
          };
        }
        return undefined;
      },
      headers,
    });
  } catch (error) {
    activeClaimLease.dispose();
    throw error;
  }
}
