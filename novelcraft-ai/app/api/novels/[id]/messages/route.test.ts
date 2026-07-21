import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-messages-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterEach(() => {
  vi.doUnmock('ai');
  vi.doUnmock('@/lib/ai-context-builder');
  vi.doUnmock('@/lib/ai-usage');
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

function mockSuccessfulStream(text = 'assistant text') {
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

function mockCapturedStream(optionsLog: unknown[], text = 'assistant text') {
  vi.doMock('ai', async importOriginal => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
      ...actual,
      streamText: vi.fn((opts: { onFinish: (event: { text: string; usage: undefined }) => Promise<void> }) => {
        optionsLog.push(opts);
        return {
          toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
            mockUIMessageResponse(uiOptions, async () => {
              const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
              await opts.onFinish({ text, usage: undefined });
              return { type: 'text-delta', messageId: id, delta: text };
            }),
        };
      }),
    };
  });
}

describe('novel messages route helpers', () => {
  it('accepts only supported locale strings from the request body', async () => {
    const { normalizeLegacyChatLanguageInput } = await import('./route');

    expect(normalizeLegacyChatLanguageInput('zh-CN')).toBe('zh-CN');
    expect(normalizeLegacyChatLanguageInput('zh-TW')).toBe('zh-TW');
    expect(normalizeLegacyChatLanguageInput('zh')).toBe('zh-CN');
    expect(normalizeLegacyChatLanguageInput('fr')).toBe('en');
    expect(normalizeLegacyChatLanguageInput({ prompt: 'x'.repeat(10_000) })).toBe('en');
    expect(normalizeLegacyChatLanguageInput(null)).toBe('en');
  });
});

describe('novel messages API', () => {
  it('returns only global interview messages, not conversation-thread messages', async () => {
    const { addMessage, createConversation, createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { GET } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Message Scope' });

    try {
      const now = new Date().toISOString();
      const conversation = await createConversation({
        id: 'global-scope-conversation',
        novelId: novel.id,
        userId: 'local-user',
        topic: 'general',
        title: 'Side thread',
        parentMessageId: null,
        createdAt: now,
        updatedAt: now,
      });
      const globalMessage = await addMessage(novel.id, 'user', 'interview message');
      await addMessage(novel.id, 'assistant', 'side thread message', conversation.id);

      const response = await GET(new Request(`http://localhost/api/novels/${novel.id}/messages`), {
        params: Promise.resolve({ id: novel.id }),
      });

      expect((await response.json()).map((message: { id: string }) => message.id)).toEqual([globalMessage.id]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('accepts AI SDK UI messages, returns a UIMessage stream, and persists with SDK message ids', async () => {
    const usage = mockUsage();
    mockContext();
    mockSuccessfulStream('assistant text');

    const { createNovel, deleteNovelCascade, getMessages } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'UI Message Chat' });

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{ id: 'user-ui-1', role: 'user', parts: [{ type: 'text', text: 'hello from ui' }] }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const body = await response.text();

      expect(response.headers.get('Content-Type')).toContain('text/event-stream');
      expect(response.headers.get('X-Context-Pressure')).toBe('ok');
      expect(body).toContain('text-delta');
      expect(body).toContain('assistant text');

      const persisted = await getMessages(novel.id);
      expect(persisted.map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual([
        { id: 'user-ui-1', role: 'user', content: 'hello from ui' },
        { id: persisted[1]!.id, role: 'assistant', content: 'assistant text' },
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

  it('runs Brainstorm as an AI SDK agent with Story Deck tools', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions);

    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Agent Brainstorm' });

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{ id: 'brainstorm-user-1', role: 'user', parts: [{ type: 'text', text: 'A haunted archive mystery with two sisters.' }] }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await response.text();

      const options = streamOptions[0] as {
        system: string;
        tools: Record<string, unknown>;
        stopWhen: unknown;
        toolChoice?: unknown;
      };
      expect(options.system).toContain('You are running a novel Brainstorm');
      expect(Object.keys(options.tools)).toEqual([
        'updateBrainstormProfile',
        'upsertStoryDeckEntries',
        'finalizeBrainstorm',
      ]);
      expect(options.stopWhen).toBeDefined();
      expect(options.toolChoice).toBeUndefined();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('repairs an approved Story Deck deterministically without calling the model', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions, '');

    const {
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getMessages,
      updateNovel,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Repair Story Deck' });

    try {
      await updateNovel(novel.id, {
        stage: 'ready_for_greenlight',
        genre: 'Fantasy',
        storySummary: 'Two sisters uncover a haunted archive.',
        characterSummary: 'The sisters disagree about whether to trust the archive.',
        arcSummary: 'They reconcile while sealing the archive.',
      });
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          repairStoryDeck: true,
          messages: [{ id: 'repair-user-1', role: 'user', parts: [{ type: 'text', text: 'Complete the approved Story Deck.' }] }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('Story Deck completed');
      expect(streamOptions).toHaveLength(0);
      const entries = await getKnowledgeEntries(novel.id);
      expect(entries.map(entry => entry.type).sort()).toEqual(['character', 'outline', 'world']);
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual(['user', 'assistant']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not duplicate an already-persisted autostart user turn in model history', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions);

    const { addMessage, createNovel, deleteNovelCascade, getMessages } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Autostart History' });

    try {
      const opening = await addMessage(novel.id, 'user', 'A haunted archive mystery.');
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{
            id: opening.id,
            role: 'user',
            metadata: { persisted: true, conversationId: null },
            parts: [{ type: 'text', text: opening.content }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await response.text();

      const options = streamOptions[0] as { messages: Array<{ role: string; content: string }> };
      expect(options.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(options.messages[0]).toMatchObject({ role: 'user', content: opening.content });
      const persisted = await getMessages(novel.id);
      expect(persisted.filter(message => message.role === 'user')).toHaveLength(1);
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

    const { createNovel, deleteNovelCascade, getMessages } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Provider Failure Chat' });

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'failed-user-1', role: 'user', parts: [{ type: 'text', text: 'will fail' }] }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const body = await response.text();

      expect(body).toContain('INKMARSHAL_AI_ERROR:');
      expect(body).toContain('aiErrorUnknown');
      expect(body).not.toContain('raw provider failure');
      expect((await getMessages(novel.id)).map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual([
        { id: 'failed-user-1', role: 'user', content: 'will fail' },
      ]);
      expect(usage.settle).toHaveBeenCalledWith({ outcome: 'failed' });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
