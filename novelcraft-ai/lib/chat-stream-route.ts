import { streamText, type StopCondition, type ToolSet } from 'ai';
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
          return;
        }
        if (text.trim()) {
          assistantMessage = await persistence.persistAssistant(responseMessageId, text);
        }
        await usage.recordOnce(modelUsage, finishReason);
      },
      onError: async () => {
        if (lifecycle.isCancelled()) await usage.cancelOnce();
        else await usage.failOnce();
      },
    });
  } catch (error) {
    const wasCancelled = lifecycle.isCancelled();
    lifecycle.cancel();
    if (wasCancelled) await usage.cancelOnce();
    else await usage.failOnce();
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
      await persistStoppedAssistantOnce(getUIMessageText(responseMessage)).catch((error) => {
        console.error('Failed to persist stopped assistant message:', error);
      });
    },
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
