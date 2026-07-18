import type { UIMessage } from 'ai';
import type { Message } from '@/lib/db-types';

export interface NovelChatMessageMetadata {
  createdAt?: number;
  conversationId?: string | null;
  persisted?: boolean;
}

export type NovelChatUIMessage = UIMessage<NovelChatMessageMetadata>;

export function messageToUIMessage(message: Message): NovelChatUIMessage {
  return {
    id: message.id,
    role: message.role,
    metadata: {
      createdAt: message.createdAt,
      conversationId: message.conversationId ?? null,
      persisted: true,
    },
    parts: [{ type: 'text', text: message.content, state: 'done' }],
  };
}

export function messagesToUIMessages(messages: Message[]): NovelChatUIMessage[] {
  return messages.map(messageToUIMessage);
}

export function parseNovelChatUIMessages(value: unknown): NovelChatUIMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((message): message is NovelChatUIMessage => {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as Partial<NovelChatUIMessage>;
    return (
      typeof candidate.id === 'string' &&
      (candidate.role === 'system' || candidate.role === 'user' || candidate.role === 'assistant') &&
      Array.isArray(candidate.parts)
    );
  });
}

export function getUIMessageText(message: Pick<UIMessage, 'parts'>): string {
  return message.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

export function findLatestUserMessage(messages: NovelChatUIMessage[]): NovelChatUIMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message;
  }
  return null;
}
