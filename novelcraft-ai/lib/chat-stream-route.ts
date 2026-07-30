import { consumeStream, streamText, type StopCondition, type ToolSet } from 'ai';
import { toModelMessages, type ChatMessage } from '@/lib/ai';
import type { GenerationPreset } from '@/lib/ai/generation-presets';
import type { Message } from '@/lib/db-types';
import { createAIStreamLifecycle, createUsageSettlement, type AIUsageSession } from '@/lib/ai-usage';
import { serializeAIError } from '@/lib/ai-error';
import { getUIMessageText, type NovelChatUIMessage } from '@/lib/chat-ui-message';

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
    stoppedLabel,
    headers,
    tools,
    stopWhen,
  } = args;

  const lifecycle = createAIStreamLifecycle(requestSignal);
  const usage = createUsageSettlement(aiUsage);
  let assistantMessage: Message | null = null;
  let userPersisted = false;
  let stoppedAssistantPersisted = false;

  const persistUserOnce = async () => {
    if (userPersisted) return;
    userPersisted = true;
    await persistence.persistUser(submittedUserMessage.id);
  };

  let result: ReturnType<typeof streamText>;
  try {
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
        aiUsage.addPartialOutput(text);
        if (lifecycle.isCancelled()) {
          await usage.cancelOnce(modelUsage);
          if (!text.trim()) {
            await persistence.markCancelled?.().catch((error) => {
              console.error('Failed to mark cancelled chat turn:', error);
            });
          }
          return;
        }
        if (text.trim()) {
          assistantMessage = await persistence.persistAssistant(responseMessageId, text);
        } else {
          await persistence.markFailed?.().catch((error) => {
            console.error('Failed to mark empty-provider chat turn failed:', error);
          });
        }
        await usage.recordOnce(modelUsage, finishReason);
      },
      onError: async () => {
        if (lifecycle.isCancelled()) {
          await usage.cancelOnce();
          await persistence.markCancelled?.().catch((error) => {
            console.error('Failed to mark cancelled chat turn:', error);
          });
        } else {
          await usage.failOnce();
          await persistence.markFailed?.().catch((error) => {
            console.error('Failed to mark failed chat turn:', error);
          });
        }
      },
    });
  } catch (error) {
    const wasCancelled = lifecycle.isCancelled();
    lifecycle.cancel();
    if (wasCancelled) {
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

  return result.toUIMessageStreamResponse<NovelChatUIMessage>({
    originalMessages,
    generateMessageId: () => responseMessageId,
    // AI SDK's UI stream transports errors as strings. Encode a versioned,
    // sanitized payload so the renderer can localize the category without
    // exposing provider response bodies or credentials.
    onError: error => serializeAIError(error),
    onFinish: async ({ responseMessage, isAborted }) => {
      if (!isAborted) return;
      await usage.cancelOnce();
      const stoppedText = getUIMessageText(responseMessage);
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
}
