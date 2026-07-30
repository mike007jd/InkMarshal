import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-conversation-chat-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterEach(() => {
  vi.doUnmock('@/lib/ai-context-builder');
  vi.doUnmock('@/lib/ai-usage');
  vi.doUnmock('ai');
  vi.resetModules();
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function mockUsage() {
  const recordUsage = vi.fn(async () => undefined);
  const fail = vi.fn(async () => undefined);
  const settle = vi.fn(async () => undefined);
  vi.doMock('@/lib/ai-usage', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/ai-usage')>();
    return {
      ...actual,
      createAIUsageSession: vi.fn(async () => ({
        model: {} as never,
        runtimeModel: { id: 'test-model', label: 'Test', provider: 'openai', modelId: 'test', contextWindow: 8192 },
        addPromptText: vi.fn(),
        addPartialOutput: vi.fn(),
        recordUsage,
        settle,
        fail,
      })),
    };
  });
  return { recordUsage, fail, settle };
}

function mockContext() {
  vi.doMock('@/lib/ai-context-builder', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/ai-context-builder')>();
    return {
      ...actual,
      buildAIContext: vi.fn(async () => ({
        systemPrompt: 'context',
        budget: { pressure: 'ok', estTokens: 1, ctxTokens: 8192 },
      })),
    };
  });
}

interface MockUIMessageResponseOptions {
  headers?: HeadersInit;
  generateMessageId?: () => string;
  onError?: (error: unknown) => string;
}

function mockUIMessageResponse(
  options: MockUIMessageResponseOptions,
  run: () => Promise<unknown>,
): Response {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  return new Response(new ReadableStream({
    async start(controller) {
      const payload = await run();
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      controller.close();
    },
  }), { headers });
}

function mockSuccessfulStream(text = 'conversation reply') {
  vi.doMock('ai', async importOriginal => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
      ...actual,
      streamText: vi.fn((opts: { onFinish: (event: { text: string; usage: undefined }) => Promise<void> }) => ({
        toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
          mockUIMessageResponse(uiOptions, async () => {
            const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
            await opts.onFinish({ text, usage: undefined });
            return { type: 'text-delta', messageId: id, delta: text };
          }),
      })),
    };
  });
}

function mockDeferredStream(args: {
  gate: { promise: Promise<void> };
  text?: string;
  callCount: { value: number };
}) {
  const text = args.text ?? 'conversation reply';
  vi.doMock('ai', async importOriginal => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
      ...actual,
      streamText: vi.fn((opts: {
        onFinish: (event: { text: string; usage: undefined }) => Promise<void>;
      }) => {
        args.callCount.value += 1;
        return {
          toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
            mockUIMessageResponse(uiOptions, async () => {
              await args.gate.promise;
              const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
              await opts.onFinish({ text, usage: undefined });
              return { type: 'text-delta', messageId: id, delta: text };
            }),
        };
      }),
    };
  });
}

async function createNovelConversation(title: string) {
  const { createConversation, createNovel } = await import('@/lib/db');
  const novel = await createNovel({ userId: 'local-user', title });
  const now = new Date().toISOString();
  const conversation = await createConversation({
    id: crypto.randomUUID(),
    novelId: novel.id,
    userId: 'local-user',
    topic: 'general',
    title: 'General',
    parentMessageId: null,
    createdAt: now,
    updatedAt: now,
  });
  return { novel, conversation };
}

describe('conversation chat API', () => {
  it('does not persist the user message when AI context construction fails', async () => {
    const usage = mockUsage();
    const buildAIContextMock = vi.fn(async () => {
      throw new Error('context unavailable');
    });
    vi.doMock('@/lib/ai-context-builder', async importOriginal => {
      const actual = await importOriginal<typeof import('@/lib/ai-context-builder')>();
      return { ...actual, buildAIContext: buildAIContextMock };
    });

    const { deleteNovelCascade, getMessagesForNovel, getChatTurn } = await import('@/lib/db');
    const { POST } = await import('./route');
    const { novel, conversation } = await createNovelConversation('Context Failure Chat');

    try {
      await expect(POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-im-recall-base-url': 'http://127.0.0.1:8081/v1',
          'x-im-recall-model': 'nomic-embed-text',
          'x-im-recall-secret': 'embed-secret',
        },
        body: JSON.stringify({ messages: [{ id: 'ctx-user-1', role: 'user', parts: [{ type: 'text', text: 'remember this' }] }] }),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) })).rejects.toThrow('context unavailable');

      expect(buildAIContextMock).toHaveBeenCalledWith(
        expect.objectContaining({
          embeddingHint: {
            baseUrl: 'http://127.0.0.1:8081/v1',
            modelId: 'nomic-embed-text',
            apiKey: 'embed-secret',
          },
        }),
      );
      expect(await getMessagesForNovel(novel.id)).toEqual([]);
      expect(getChatTurn(novel.id, 'ctx-user-1')?.status).toBe('failed');
      expect(usage.fail).toHaveBeenCalledTimes(1);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('accepts AI SDK UI messages and persists the conversation turn in scope', async () => {
    const usage = mockUsage();
    mockContext();
    mockSuccessfulStream('conversation reply');

    const { deleteNovelCascade, getMessagesForNovel } = await import('@/lib/db');
    const { deterministicAssistantMessageId } = await import('@/lib/chat-turn-helpers');
    const { POST } = await import('./route');
    const { novel, conversation } = await createNovelConversation('Conversation UI Message Chat');

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'conv-user-1', role: 'user', parts: [{ type: 'text', text: 'hello thread' }] }],
        }),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      const body = await response.text();

      expect(response.headers.get('Content-Type')).toContain('text/event-stream');
      expect(response.headers.get('X-Context-Pressure')).toBe('ok');
      expect(body).toContain('text-delta');
      expect(body).toContain('conversation reply');

      const persisted = await getMessagesForNovel(novel.id);
      expect(persisted.map(m => ({ id: m.id, role: m.role, content: m.content, conversationId: m.conversation_id }))).toEqual([
        { id: 'conv-user-1', role: 'user', content: 'hello thread', conversationId: conversation.id },
        {
          id: deterministicAssistantMessageId('conv-user-1'),
          role: 'assistant',
          content: 'conversation reply',
          conversationId: conversation.id,
        },
      ]);
      expect(usage.settle).toHaveBeenCalledWith({
        outcome: 'success',
        usage: undefined,
        finishReason: undefined,
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('keeps the user turn visible and sends a sanitized stream error when provider streaming fails', async () => {
    const usage = mockUsage();
    mockContext();
    vi.doMock('ai', async importOriginal => {
      const actual = await importOriginal<typeof import('ai')>();
      return {
        ...actual,
        streamText: vi.fn((opts: { onError: (event: { error: unknown }) => Promise<void> }) => ({
          toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
            mockUIMessageResponse(uiOptions, async () => {
              const error = new Error('raw provider failure');
              await opts.onError({ error });
              return { error: uiOptions.onError?.(error) };
            }),
        })),
      };
    });

    const { deleteNovelCascade, getMessagesForNovel, getChatTurn } = await import('@/lib/db');
    const { POST } = await import('./route');
    const { novel, conversation } = await createNovelConversation('Conversation Provider Failure Chat');

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'conv-failed-user-1', role: 'user', parts: [{ type: 'text', text: 'will fail' }] }],
        }),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      const body = await response.text();

      expect(body).toContain('INKMARSHAL_AI_ERROR:');
      expect(body).toContain('aiErrorUnknown');
      expect(body).not.toContain('raw provider failure');
      expect((await getMessagesForNovel(novel.id)).map(m => ({ id: m.id, role: m.role, content: m.content, conversationId: m.conversation_id }))).toEqual([
        { id: 'conv-failed-user-1', role: 'user', content: 'will fail', conversationId: conversation.id },
      ]);
      expect(getChatTurn(novel.id, 'conv-failed-user-1')?.status).toBe('failed');
      expect(usage.settle).toHaveBeenCalledWith({ outcome: 'failed' });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('allows only one deferred provider execution for concurrent conversation duplicates', async () => {
    mockUsage();
    mockContext();
    let release!: () => void;
    const gate = {
      promise: new Promise<void>(resolve => {
        release = resolve;
      }),
    };
    const callCount = { value: 0 };
    mockDeferredStream({ gate, callCount, text: 'only once' });

    const { deleteNovelCascade, getMessagesForNovel, getChatTurn } = await import('@/lib/db');
    const { deterministicAssistantMessageId } = await import('@/lib/chat-turn-helpers');
    const { POST } = await import('./route');
    const { novel, conversation } = await createNovelConversation('Conversation Concurrent');
    const userMessageId = 'conv-concurrent-user';
    const body = {
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'race the thread' }],
      }],
    };

    try {
      const started = Promise.all([
        POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) }),
        POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) }),
      ]);

      await vi.waitFor(() => {
        expect(callCount.value).toBe(1);
      });
      expect(getChatTurn(novel.id, userMessageId)?.status).toBe('running');

      release();
      const [first, second] = await started;
      const bodies = await Promise.all([first.text(), second.text()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(bodies.some(bodyText => bodyText.includes('only once'))).toBe(true);
      expect(bodies.some(bodyText => bodyText.includes('CHAT_TURN_IN_PROGRESS'))).toBe(true);

      const replay = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain('only once');
      expect(callCount.value).toBe(1);
      expect((await getMessagesForNovel(novel.id)).map(m => ({
        id: m.id,
        role: m.role,
        conversationId: m.conversation_id,
      }))).toEqual([
        { id: userMessageId, role: 'user', conversationId: conversation.id },
        {
          id: deterministicAssistantMessageId(userMessageId),
          role: 'assistant',
          conversationId: conversation.id,
        },
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('fails closed on content collision and wrong conversation binding', async () => {
    mockUsage();
    mockContext();
    mockSuccessfulStream('first reply');

    const { deleteNovelCascade, getMessagesForNovel } = await import('@/lib/db');
    const { POST } = await import('./route');
    const { novel, conversation } = await createNovelConversation('Conversation Collision');
    const other = await (async () => {
      const { createConversation } = await import('@/lib/db');
      const now = new Date().toISOString();
      return createConversation({
        id: crypto.randomUUID(),
        novelId: novel.id,
        userId: 'local-user',
        topic: 'plot',
        title: 'Other',
        parentMessageId: null,
        createdAt: now,
        updatedAt: now,
      });
    })();
    const userMessageId = 'conv-collision-user';

    try {
      const first = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: 'original content' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      await first.text();

      const contentCollision = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: 'mutated content' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      expect(contentCollision.status).toBe(409);
      expect(await contentCollision.json()).toMatchObject({ code: 'CHAT_TURN_REQUEST_COLLISION' });

      const wrongConversation = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${other.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: 'original content' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id, convId: other.id }) });
      expect(wrongConversation.status).toBe(409);
      expect(await wrongConversation.json()).toMatchObject({ code: 'CHAT_TURN_REQUEST_COLLISION' });

      expect((await getMessagesForNovel(novel.id)).map(m => m.content)).toEqual([
        'original content',
        'first reply',
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not stale-reclaim an active deferred conversation stream into a second paid call', async () => {
    mockUsage();
    mockContext();
    let release!: () => void;
    const gate = {
      promise: new Promise<void>(resolve => {
        release = resolve;
      }),
    };
    const callCount = { value: 0 };
    mockDeferredStream({ gate, callCount, text: 'live conversation lease' });

    const { deleteNovelCascade, getChatTurn, getMessagesForNovel } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { CHAT_TURN_STALE_LEASE_MS } = await import('@/lib/db/queries-chat-turns');
    const { __tickChatTurnClaimLeasesForTest } = await import('@/lib/chat-turn-lease');
    const { deterministicAssistantMessageId } = await import('@/lib/chat-turn-helpers');
    const { POST } = await import('./route');
    const { novel, conversation } = await createNovelConversation('Conversation Active Lease Race');
    const userMessageId = 'conv-active-lease-user';
    const body = {
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'keep conversation alive' }],
      }],
    };

    try {
      const firstPromise = POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });

      await vi.waitFor(() => {
        expect(callCount.value).toBe(1);
      });
      expect(getChatTurn(novel.id, userMessageId)?.status).toBe('running');

      getDb()
        .prepare(
          `UPDATE chat_turns
              SET updated_at = ?
            WHERE novel_id = ? AND user_message_id = ?`,
        )
        .run(
          new Date(Date.now() - CHAT_TURN_STALE_LEASE_MS - 5_000).toISOString(),
          novel.id,
          userMessageId,
        );

      __tickChatTurnClaimLeasesForTest();

      const duplicate = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: 'CHAT_TURN_IN_PROGRESS' });
      expect(callCount.value).toBe(1);

      release();
      const first = await firstPromise;
      expect(first.status).toBe(200);
      expect(await first.text()).toContain('live conversation lease');
      expect(callCount.value).toBe(1);

      const replay = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain('live conversation lease');
      expect(callCount.value).toBe(1);
      expect((await getMessagesForNovel(novel.id)).map(m => m.id)).toEqual([
        userMessageId,
        deterministicAssistantMessageId(userMessageId),
      ]);
    } finally {
      release();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('replays a succeeded conversation turn without a second provider call', async () => {
    mockUsage();
    mockContext();
    const callCount = { value: 0 };
    vi.doMock('ai', async importOriginal => {
      const actual = await importOriginal<typeof import('ai')>();
      return {
        ...actual,
        streamText: vi.fn((opts: { onFinish: (event: { text: string; usage: undefined }) => Promise<void> }) => {
          callCount.value += 1;
          return {
            toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
              mockUIMessageResponse(uiOptions, async () => {
                const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
                await opts.onFinish({ text: 'stable conversation reply', usage: undefined });
                return { type: 'text-delta', messageId: id, delta: 'stable conversation reply' };
              }),
          };
        }),
      };
    });

    const { deleteNovelCascade, getChatTurn } = await import('@/lib/db');
    const { POST } = await import('./route');
    const { novel, conversation } = await createNovelConversation('Conversation Replay');
    const body = {
      messages: [{
        id: 'conv-replay-user',
        role: 'user',
        parts: [{ type: 'text', text: 'replay me' }],
      }],
    };

    try {
      const first = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      expect(await first.text()).toContain('stable conversation reply');

      const second = await POST(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id, convId: conversation.id }) });
      expect(await second.text()).toContain('stable conversation reply');
      expect(callCount.value).toBe(1);
      expect(getChatTurn(novel.id, 'conv-replay-user')).toMatchObject({
        status: 'succeeded',
        responseText: 'stable conversation reply',
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
