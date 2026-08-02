import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireNovelOwner: vi.fn(),
  resolveFullMessageChain: vi.fn(),
  verifyConversationOwnership: vi.fn(),
  getChatTurn: vi.fn(),
}));

vi.mock('@/lib/local-auth', () => ({ requireNovelOwner: mocks.requireNovelOwner }));
vi.mock('@/lib/conversations', () => ({
  resolveFullMessageChain: mocks.resolveFullMessageChain,
  verifyConversationOwnership: mocks.verifyConversationOwnership,
}));
vi.mock('@/lib/db', () => ({
  CHAT_TURN_STALE_LEASE_MS: 10 * 60 * 1_000,
  getChatTurn: mocks.getChatTurn,
}));

import { GET } from './route';

describe('conversation messages recovery status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireNovelOwner.mockResolvedValue({ user: { id: 'local-user' } });
    mocks.verifyConversationOwnership.mockResolvedValue(true);
  });

  it('reports the latest chained user turn status even when a partial assistant is last', async () => {
    mocks.resolveFullMessageChain.mockResolvedValue([
      {
        id: 'conversation-user',
        novelId: 'novel-1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Write a long answer',
        createdAt: 1,
      },
      {
        id: 'conversation-assistant',
        novelId: 'novel-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Partial answer without the legacy main-thread suffix',
        createdAt: 2,
      },
    ]);
    mocks.getChatTurn.mockReturnValue({ status: 'cancelled' });

    const response = await GET(new Request('http://localhost/api/novels/novel-1/conversations/conv-1/messages'), {
      params: Promise.resolve({ id: 'novel-1', convId: 'conv-1' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-InkMarshal-Chat-Turn-Status')).toBe('cancelled');
    expect(mocks.getChatTurn).toHaveBeenCalledWith('novel-1', 'conversation-user');
  });

  it('reports an exact pending claim before it appears in the conversation chain', async () => {
    mocks.resolveFullMessageChain.mockResolvedValue([]);
    mocks.getChatTurn.mockReturnValue({
      status: 'running',
      updatedAt: new Date().toISOString(),
    });

    const response = await GET(new Request(
      'http://localhost/api/novels/novel-1/conversations/conv-1/messages?pendingTurnId=pending-user',
    ), { params: Promise.resolve({ id: 'novel-1', convId: 'conv-1' }) });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-InkMarshal-Chat-Turn-Status')).toBe('running');
    expect(mocks.getChatTurn).toHaveBeenCalledWith('novel-1', 'pending-user');
  });
});
