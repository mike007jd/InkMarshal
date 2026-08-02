import { describe, expect, it } from 'vitest';

import { messageToUIMessage } from '@/lib/chat-ui-message';
import { PERSISTED_CHAT_STOP_MARKER } from '@/lib/chat-turn-recovery';
import type { Message } from '@/lib/db-types';

describe('chat UI message metadata rendering', () => {
  it('keeps the durable Stop suffix in storage but leaves its label to the retry callout', () => {
    const message: Message = {
      id: 'stopped-assistant',
      novelId: 'novel-1',
      conversationId: 'conversation-1',
      role: 'assistant',
      content: `Visible partial\n\n${PERSISTED_CHAT_STOP_MARKER}\n[Stopped]`,
      createdAt: 1,
    };

    const uiMessage = messageToUIMessage(message);

    expect(message.content).toContain(PERSISTED_CHAT_STOP_MARKER);
    expect(uiMessage.parts).toEqual([{
      type: 'text',
      text: 'Visible partial',
      state: 'done',
    }]);
  });

  it('preserves user content and non-exact assistant lines containing the marker', () => {
    const user: Message = {
      id: 'marker-user',
      novelId: 'novel-1',
      conversationId: null,
      role: 'user',
      content: `Quote this exactly:\n${PERSISTED_CHAT_STOP_MARKER}`,
      createdAt: 1,
    };
    const assistant: Message = {
      ...user,
      id: 'indented-marker-assistant',
      role: 'assistant',
      content: `  ${PERSISTED_CHAT_STOP_MARKER}`,
    };

    expect(messageToUIMessage(user).parts).toEqual([{
      type: 'text',
      text: user.content,
      state: 'done',
    }]);
    expect(messageToUIMessage(assistant).parts).toEqual([{
      type: 'text',
      text: assistant.content,
      state: 'done',
    }]);
  });
});
