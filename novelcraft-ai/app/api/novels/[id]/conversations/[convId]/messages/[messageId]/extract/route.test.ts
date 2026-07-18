import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireNovelOwner: vi.fn(),
  verifyConversationOwnership: vi.fn(),
  resolveFullMessageChain: vi.fn(),
  createAIUsageSession: vi.fn(),
  aiUsageErrorResponse: vi.fn(),
  extractEntryFromMessageResult: vi.fn(),
  usageFail: vi.fn(),
  usageCancel: vi.fn(),
  usageRecord: vi.fn(),
}));

vi.mock('@/lib/local-auth', () => ({
  requireNovelOwner: mocks.requireNovelOwner,
}));

vi.mock('@/lib/conversations', () => ({
  verifyConversationOwnership: mocks.verifyConversationOwnership,
  resolveFullMessageChain: mocks.resolveFullMessageChain,
}));

vi.mock('@/lib/ai-usage', () => ({
  createAIUsageSession: mocks.createAIUsageSession,
  aiUsageErrorResponse: mocks.aiUsageErrorResponse,
}));

vi.mock('@/lib/ai/conversation-extract', () => ({
  buildExtractStub: vi.fn((messageContent: string, type = 'character') => ({
    type,
    title: '',
    summary: messageContent.slice(0, 400),
    data: {},
    suggestedWikilinks: [],
    suggestedRelations: [],
  })),
  extractEntryFromMessageResult: mocks.extractEntryFromMessageResult,
}));

beforeEach(() => {
  mocks.requireNovelOwner.mockReset();
  mocks.requireNovelOwner.mockResolvedValue({
    user: { id: 'local-user' },
    novel: { id: 'novel-1' },
  });
  mocks.verifyConversationOwnership.mockReset();
  mocks.verifyConversationOwnership.mockResolvedValue(true);
  mocks.resolveFullMessageChain.mockReset();
  mocks.resolveFullMessageChain.mockResolvedValue([{
    id: 'message-1',
    novelId: 'novel-1',
    conversationId: 'conversation-1',
    role: 'assistant',
    content: 'Long enough assistant message for extraction.',
    createdAt: 1,
  }]);
  mocks.createAIUsageSession.mockReset();
  mocks.createAIUsageSession.mockResolvedValue({
    model: {},
    addPromptText: vi.fn(),
    fail: mocks.usageFail,
    cancel: mocks.usageCancel,
    recordUsage: mocks.usageRecord,
  });
  mocks.aiUsageErrorResponse.mockReset();
  mocks.aiUsageErrorResponse.mockReturnValue(null);
  mocks.extractEntryFromMessageResult.mockReset();
  mocks.extractEntryFromMessageResult.mockResolvedValue({
    entry: {
      type: 'character',
      title: 'A',
      summary: 'summary',
      data: {},
      suggestedWikilinks: [],
      suggestedRelations: [],
    },
    ok: true,
  });
  mocks.usageFail.mockReset();
  mocks.usageCancel.mockReset();
  mocks.usageRecord.mockReset();
});

describe('conversation message extract route cancellation', () => {
  it('extracts assistant messages that are visible through the forked parent chain', async () => {
    const { POST } = await import('./route');
    mocks.resolveFullMessageChain.mockResolvedValueOnce([
      {
        id: 'parent-message',
        novelId: 'novel-1',
        conversationId: 'parent-conversation',
        role: 'assistant',
        content: 'Parent chain assistant detail.',
        createdAt: 1,
      },
      {
        id: 'child-message',
        novelId: 'novel-1',
        conversationId: 'conversation-1',
        role: 'user',
        content: 'Child turn.',
        createdAt: 2,
      },
    ]);

    const response = await POST(new Request(
      'http://localhost/api/novels/novel-1/conversations/conversation-1/messages/parent-message/extract',
      {
        method: 'POST',
        body: JSON.stringify({ targetType: 'character' }),
        headers: { 'content-type': 'application/json' },
      },
    ), {
      params: Promise.resolve({
        id: 'novel-1',
        convId: 'conversation-1',
        messageId: 'parent-message',
      }),
    });

    expect(response.status).toBe(200);
    expect(mocks.extractEntryFromMessageResult).toHaveBeenCalledWith(
      expect.objectContaining({ messageContent: 'Parent chain assistant detail.' }),
    );
    expect(mocks.usageRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects same-novel messages that are outside the resolved fork chain', async () => {
    const { POST } = await import('./route');
    mocks.resolveFullMessageChain.mockResolvedValueOnce([{
      id: 'visible-message',
      novelId: 'novel-1',
      conversationId: 'conversation-1',
      role: 'assistant',
      content: 'Visible assistant detail.',
      createdAt: 1,
    }]);

    const response = await POST(new Request(
      'http://localhost/api/novels/novel-1/conversations/conversation-1/messages/sibling-message/extract',
      {
        method: 'POST',
        body: JSON.stringify({ targetType: 'character' }),
        headers: { 'content-type': 'application/json' },
      },
    ), {
      params: Promise.resolve({
        id: 'novel-1',
        convId: 'conversation-1',
        messageId: 'sibling-message',
      }),
    });

    expect(response.status).toBe(404);
    expect(mocks.createAIUsageSession).not.toHaveBeenCalled();
    expect(mocks.extractEntryFromMessageResult).not.toHaveBeenCalled();
  });

  it('cancels usage instead of recording failure or success when the request aborts during extraction', async () => {
    const { POST } = await import('./route');
    const controller = new AbortController();
    mocks.extractEntryFromMessageResult.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({
        entry: {
          type: 'character',
          title: '',
          summary: 'manual fallback',
          data: {},
          suggestedWikilinks: [],
          suggestedRelations: [],
        },
        ok: true,
      });
    });

    const response = await POST(new Request(
      'http://localhost/api/novels/novel-1/conversations/conversation-1/messages/message-1/extract',
      {
        method: 'POST',
        body: JSON.stringify({ targetType: 'character' }),
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      },
    ), {
      params: Promise.resolve({
        id: 'novel-1',
        convId: 'conversation-1',
        messageId: 'message-1',
      }),
    });

    expect(response.status).toBe(499);
    expect(mocks.usageCancel).toHaveBeenCalledTimes(1);
    expect(mocks.usageFail).not.toHaveBeenCalled();
    expect(mocks.usageRecord).not.toHaveBeenCalled();
  });

  it('returns the manual prefill but marks usage failed when extraction degrades', async () => {
    const { POST } = await import('./route');
    mocks.extractEntryFromMessageResult.mockResolvedValueOnce({
      entry: {
        type: 'character',
        title: '',
        summary: 'manual fallback',
        data: {},
        suggestedWikilinks: [],
        suggestedRelations: [],
      },
      ok: false,
    });

    const response = await POST(new Request(
      'http://localhost/api/novels/novel-1/conversations/conversation-1/messages/message-1/extract',
      {
        method: 'POST',
        body: JSON.stringify({ targetType: 'character' }),
        headers: { 'content-type': 'application/json' },
      },
    ), {
      params: Promise.resolve({
        id: 'novel-1',
        convId: 'conversation-1',
        messageId: 'message-1',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: 'character',
      title: '',
      summary: 'manual fallback',
      data: {},
      suggestedWikilinks: [],
      suggestedRelations: [],
      _degraded: true,
    });
    expect(mocks.usageFail).toHaveBeenCalledTimes(1);
    expect(mocks.usageRecord).not.toHaveBeenCalled();
  });
});
