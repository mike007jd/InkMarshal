import type { UIMessage } from 'ai';
import { PERSISTED_CHAT_STOP_MARKER } from '@/lib/chat-turn-recovery';
import type { Message } from '@/lib/db-types';

export interface NovelChatMessageMetadata {
  createdAt?: number;
  conversationId?: string | null;
  persisted?: boolean;
}

export type NovelChatUIMessage = UIMessage<NovelChatMessageMetadata>;

export function assistantChatMessageDisplayContent(content: string): string {
  const lines = content.split('\n');
  const markerIndex = lines.lastIndexOf(PERSISTED_CHAT_STOP_MARKER);
  if (markerIndex < 0) return content;

  // New durable Stop records end with the stable marker plus a localized
  // display label. The retry callout already renders that label, so hide both
  // suffix lines and keep the partial assistant prose visible exactly once.
  if (markerIndex === lines.length - 2) {
    return lines.slice(0, markerIndex).join('\n').trimEnd();
  }

  return lines.filter(line => line !== PERSISTED_CHAT_STOP_MARKER).join('\n');
}

export function messageToUIMessage(message: Message): NovelChatUIMessage {
  return {
    id: message.id,
    role: message.role,
    metadata: {
      createdAt: message.createdAt,
      conversationId: message.conversationId ?? null,
      persisted: true,
    },
    parts: [{
      type: 'text',
      text: message.role === 'assistant'
        ? assistantChatMessageDisplayContent(message.content)
        : message.content,
      state: 'done',
    }],
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
