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

    const { deleteNovelCascade, getMessagesForNovel } = await import('@/lib/db');
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
        { id: persisted[1]!.id, role: 'assistant', content: 'conversation reply', conversationId: conversation.id },
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

    const { deleteNovelCascade, getMessagesForNovel } = await import('@/lib/db');
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
      expect(usage.settle).toHaveBeenCalledWith({ outcome: 'failed' });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
