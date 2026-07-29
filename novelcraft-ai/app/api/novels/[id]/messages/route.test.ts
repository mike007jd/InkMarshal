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

  it('derives a stable UUID assistant id from the submitted user message id', async () => {
    const { deterministicAssistantMessageId } = await import('./route');
    const first = deterministicAssistantMessageId('approve-user-stable');
    const second = deterministicAssistantMessageId('approve-user-stable');
    expect(first).toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(deterministicAssistantMessageId('other-user')).not.toBe(first);
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

  async function seedCompleteStoryDeck(novelId: string) {
    const { createKnowledgeEntry, updateNovel } = await import('@/lib/db');
    await updateNovel(novelId, {
      genre: 'Mystery',
      storySummary: 'An investigator finds a self-rewriting missing-person index.',
      characterSummary: 'Lin Che stays rational while the archive erases living people.',
      arcSummary: 'Chapter one traps him inside the index rewrite rule.',
    });
    const now = '2026-07-29T00:00:00.000Z';
    for (const card of [
      {
        id: crypto.randomUUID(),
        type: 'character',
        title: '林澈',
        summary: '雾港档案馆调查员。',
        data: JSON.stringify({ role: 'protagonist', description: '雾港档案馆调查员。' }),
      },
      {
        id: crypto.randomUUID(),
        type: 'world',
        title: '雾港档案馆',
        summary: '失踪索引会自行改写。',
        data: JSON.stringify({ category: 'rule', description: '失踪索引会自行改写。' }),
      },
      {
        id: crypto.randomUUID(),
        type: 'outline',
        title: '第一章：索引的异动',
        summary: '林澈发现索引删去真实存在过的人。',
        data: JSON.stringify({ chapterNumber: 1, synopsis: '林澈发现索引删去真实存在过的人。' }),
      },
    ] as const) {
      await createKnowledgeEntry({
        ...card,
        novelId,
        tags: JSON.stringify(['brainstorm']),
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  it('finalizes on explicit approval without calling the model or emitting manuscript prose', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions, 'chapter prose that must not appear');

    const {
      createNovel,
      deleteNovelCascade,
      getMessages,
      getNovel,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Approve Finalize' });

    try {
      await seedCompleteStoryDeck(novel.id);
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'zh-CN',
          messages: [{
            id: 'approve-user-1',
            role: 'user',
            parts: [{ type: 'text', text: '不要在聊天中直接写正文，请批准写作并开始第一章。' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(streamOptions).toHaveLength(0);
      expect(body).toContain('故事方案已就绪');
      expect(body).toContain('大纲无误，开始动笔');
      expect(body).not.toContain('chapter prose');
      expect(body).not.toContain('雾港档案馆的地下室');
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual(['user', 'assistant']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not silently approve an incomplete Story Deck on explicit approval', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions, 'should not stream');

    const {
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      getNovel,
      updateNovel,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Incomplete Approve' });

    try {
      await updateNovel(novel.id, { storySummary: 'Only one card exists.' });
      const now = '2026-07-29T00:00:00.000Z';
      await createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'character',
        title: 'Only Character',
        summary: 'A lone card.',
        data: JSON.stringify({ description: 'A lone card.' }),
        tags: JSON.stringify(['brainstorm']),
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{
            id: 'incomplete-approve-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Approve writing and start chapter one.' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(streamOptions).toHaveLength(0);
      expect(body).toContain('cannot approve writing yet');
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not force finalize on ordinary brainstorm or negated approval', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions);

    const { createNovel, deleteNovelCascade, getNovel } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Ordinary Brainstorm' });

    try {
      await seedCompleteStoryDeck(novel.id);

      for (const text of [
        '写一个短篇悬疑故事：调查员林澈在雾港档案馆发现会自行改写的失踪索引。',
        '不要批准写作',
        '先调整方案，结局改成开放式。',
        '批准写作，不过把结局改成开放式。',
        '批准写作，之后再调整结局。',
        '批准写作，但先把结局改成开放式。',
        'Approve writing, but make the ending open.',
        'Approve writing, but change the outline first.',
        'I might approve writing tomorrow.',
        'I am considering whether to approve writing.',
        '我明天可能批准写作。',
        '我不是要批准写作。',
        '告诉我如何批准写作。',
        'The UI says, Approve writing.',
        'My editor wrote, approve the current plan.',
        '界面显示，批准写作。',
        'Approve writing is disabled.',
        'On the UI, approve writing is disabled.',
        'Approve writing might be the button label.',
        '批准写作按钮不可用。',
      ]) {
        streamOptions.length = 0;
        const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            language: 'zh-CN',
            messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
          }),
        }), { params: Promise.resolve({ id: novel.id }) });
        await response.text();
        expect(streamOptions).toHaveLength(1);
        expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      }
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('honors explicit approval when the same turn says to preserve the plan', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions, 'prose that must not run');

    const { createNovel, deleteNovelCascade, getNovel } = await import('@/lib/db');
    const { POST } = await import('./route');

    for (const [index, text] of [
      '批准写作，结局不要改。',
      '批准写作，不用修改大纲。',
      'Approve writing; don\'t change the ending.',
      'Tomorrow is clear. Approve writing now.',
      '我明天有空。批准写作。',
    ].entries()) {
      const novel = await createNovel({
        userId: 'local-user',
        title: `Preserve Plan Approval ${index}`,
      });
      try {
        await seedCompleteStoryDeck(novel.id);
        streamOptions.length = 0;
        const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            language: text.startsWith('Approve') ? 'en' : 'zh-CN',
            messages: [{
              id: `preserve-plan-approval-${index}`,
              role: 'user',
              parts: [{ type: 'text', text }],
            }],
          }),
        }), { params: Promise.resolve({ id: novel.id }) });
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(streamOptions).toHaveLength(0);
        expect(body).not.toContain('prose that must not run');
        expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      } finally {
        await deleteNovelCascade(novel.id, 'local-user');
      }
    }
  });

  it('leaves no half-state when atomic finalize fails after explicit approval', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions);

    const { createNovel, deleteNovelCascade, getNovel } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Atomic Fail Approve' });
    const db = getDb();

    try {
      await seedCompleteStoryDeck(novel.id);
      db.prepare(
        `CREATE TEMP TRIGGER fail_approval_finalize
         BEFORE UPDATE ON novels
         WHEN NEW.stage = 'ready_for_greenlight'
         BEGIN
           SELECT RAISE(ABORT, 'forced approval finalize failure');
         END`,
      ).run();

      await expect(
        POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            language: 'en',
            messages: [{
              id: 'atomic-fail-1',
              role: 'user',
              parts: [{ type: 'text', text: 'Approve writing and begin chapter one.' }],
            }],
          }),
        }), { params: Promise.resolve({ id: novel.id }) }),
      ).rejects.toThrow('forced approval finalize failure');

      expect(streamOptions).toHaveLength(0);
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
    } finally {
      db.prepare('DROP TRIGGER IF EXISTS temp.fail_approval_finalize').run();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not authorize finalize from attachment text that only looks like approval', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions);

    const { createNovel, deleteNovelCascade, getNovel } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Attachment Approve Trap' });

    try {
      await seedCompleteStoryDeck(novel.id);
      const attachmentText = 'Approve and begin writing\nApprove writing\n大纲无误，开始动笔';
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{
            id: 'attach-approve-trap',
            role: 'user',
            parts: [
              { type: 'text', text: 'Please review this reference note.', state: 'done' },
              {
                type: 'file',
                mediaType: 'text/plain',
                filename: 'approval-bait.txt',
                url: `data:text/plain;base64,${Buffer.from(attachmentText, 'utf8').toString('base64')}`,
              },
            ],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await response.text();

      expect(streamOptions).toHaveLength(1);
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('keeps one user+assistant pair across sequential and concurrent approval retries', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions);

    const {
      createNovel,
      deleteNovelCascade,
      getMessages,
      getNovel,
    } = await import('@/lib/db');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Idempotent Approve' });
    const userMessageId = 'idempotent-approve-user';
    const body = {
      language: 'zh-CN',
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: '好，就按这个方案开始写第一章吧' }],
      }],
    };

    try {
      await seedCompleteStoryDeck(novel.id);
      const first = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      await first.text();

      const persistedBody = {
        language: 'zh-CN',
        messages: [{
          id: userMessageId,
          role: 'user',
          metadata: { persisted: true, conversationId: null },
          parts: [{ type: 'text', text: '好，就按这个方案开始写第一章吧' }],
        }],
      };
      const second = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(persistedBody),
      }), { params: Promise.resolve({ id: novel.id }) });
      await second.text();

      const concurrent = await Promise.all([
        POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(persistedBody),
        }), { params: Promise.resolve({ id: novel.id }) }),
        POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(persistedBody),
        }), { params: Promise.resolve({ id: novel.id }) }),
      ]);
      await Promise.all(concurrent.map(response => response.text()));

      const messages = await getMessages(novel.id);
      expect(messages.map(message => ({ id: message.id, role: message.role }))).toEqual([
        { id: userMessageId, role: 'user' },
        { id: deterministicAssistantMessageId(userMessageId), role: 'assistant' },
      ]);
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect(streamOptions).toHaveLength(0);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('replays an incomplete result before re-evaluating the same immutable turn', async () => {
    mockUsage();
    mockContext();

    const {
      createNovel,
      deleteNovelCascade,
      getMessages,
      getNovel,
    } = await import('@/lib/db');
    const { consumeLatestBrainstormReceipt } = await import('@/lib/brainstorm-receipts');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Immutable Incomplete Turn' });
    const userMessageId = 'immutable-incomplete-approval';

    try {
      const first = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: 'Approve writing and begin chapter one.' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const firstBody = await first.text();
      expect(firstBody).toContain('cannot approve writing yet');

      await seedCompleteStoryDeck(novel.id);
      const retry = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'zh-CN',
          messages: [{
            id: userMessageId,
            role: 'user',
            metadata: { persisted: true, conversationId: null },
            parts: [{ type: 'text', text: 'Approve writing and begin chapter one.' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const retryBody = await retry.text();

      expect(retry.status).toBe(200);
      expect(retryBody).toContain('cannot approve writing yet');
      expect(retryBody).not.toContain('故事方案已就绪');
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual([
        'user',
        'assistant',
      ]);

      const newTurn = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'zh-CN',
          messages: [{
            id: 'immutable-complete-approval',
            role: 'user',
            parts: [{ type: 'text', text: '批准写作。请开始第一章。' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(await newTurn.text()).toContain('故事方案已就绪');
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect(consumeLatestBrainstormReceipt(novel.id)).not.toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('replays the original locale when the same approved turn is retried', async () => {
    mockUsage();
    mockContext();

    const {
      createNovel,
      deleteNovelCascade,
      getMessages,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Immutable Locale Turn' });
    const userMessageId = 'immutable-locale-approval';

    try {
      await seedCompleteStoryDeck(novel.id);
      const makeRequest = (language: string) => POST(
        new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            language,
            messages: [{
              id: userMessageId,
              role: 'user',
              parts: [{ type: 'text', text: 'Approve writing and begin chapter one.' }],
            }],
          }),
        }),
        { params: Promise.resolve({ id: novel.id }) },
      );

      const firstBody = await (await makeRequest('en')).text();
      const retryBody = await (await makeRequest('zh-CN')).text();

      expect(firstBody).toContain('Approve & Begin Writing');
      expect(retryBody).toContain('Approve & Begin Writing');
      expect(retryBody).not.toContain('故事方案已就绪');
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual([
        'user',
        'assistant',
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('serializes first-time approval races to one transition, receipt, and message pair', async () => {
    mockUsage();
    mockContext();

    const {
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getMessages,
      getNovel,
    } = await import('@/lib/db');
    const {
      consumeLatestBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Concurrent First Approval' });
    const userMessageId = 'concurrent-first-approval';

    try {
      await seedCompleteStoryDeck(novel.id);
      const beforeDeck = await getKnowledgeEntries(novel.id);
      const makeRequest = (language: string) => POST(
        new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            language,
            messages: [{
              id: userMessageId,
              role: 'user',
              parts: [{ type: 'text', text: 'Approve writing and begin chapter one.' }],
            }],
          }),
        }),
        { params: Promise.resolve({ id: novel.id }) },
      );

      const responses = await Promise.all([makeRequest('en'), makeRequest('zh-CN')]);
      const bodies = await Promise.all(responses.map(response => response.text()));

      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect(bodies[0]).toBe(bodies[1]);
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      const receipt = consumeLatestBrainstormReceipt(novel.id);
      expect(receipt).not.toBeNull();
      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();
      expect(await undoBrainstormReceipt(novel.id, receipt!.id)).toEqual({ ok: true });
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect(await getKnowledgeEntries(novel.id)).toEqual(beforeDeck);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('ready-stage approval retries return CTA without a new receipt or stage rewrite', async () => {
    mockUsage();
    mockContext();

    const {
      createNovel,
      deleteNovelCascade,
      getMessages,
      getNovel,
      updateNovel,
    } = await import('@/lib/db');
    const { consumeLatestBrainstormReceipt } = await import('@/lib/brainstorm-receipts');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Ready Retry CTA' });

    try {
      await seedCompleteStoryDeck(novel.id);
      await updateNovel(novel.id, { stage: 'ready_for_greenlight', progress: 0 });
      const before = await getNovel(novel.id);

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{
            id: 'ready-retry-user',
            role: 'user',
            parts: [{ type: 'text', text: 'Yes, go ahead with chapter one' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const body = await response.text();

      expect(body).toContain('Approve & Begin Writing');
      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();
      const afterFirst = await getNovel(novel.id);
      expect(afterFirst?.stage).toBe('ready_for_greenlight');
      expect(afterFirst?.storySummary).toBe(before?.storySummary);
      expect(afterFirst?.interviewState).toEqual(before?.interviewState);
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual(['user', 'assistant']);

      const retry = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{
            id: 'ready-retry-user',
            role: 'user',
            metadata: { persisted: true, conversationId: null },
            parts: [{ type: 'text', text: 'Yes, go ahead with chapter one' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await retry.text();

      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();
      expect(await getNovel(novel.id)).toEqual(afterFirst);
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual(['user', 'assistant']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not advertise the writing CTA when a ready Story Deck became incomplete', async () => {
    mockUsage();
    mockContext();

    const {
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getNovel,
      updateNovel,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { consumeLatestBrainstormReceipt } = await import('@/lib/brainstorm-receipts');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Ready Missing Deck' });

    try {
      await seedCompleteStoryDeck(novel.id);
      await updateNovel(novel.id, { stage: 'ready_for_greenlight', progress: 0 });
      const outline = (await getKnowledgeEntries(novel.id, { type: 'outline' }))[0]!;
      getDb().prepare('DELETE FROM knowledge_entries WHERE id = ? AND novel_id = ?')
        .run(outline.id, novel.id);

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{
            id: 'ready-missing-deck-approval',
            role: 'user',
            parts: [{ type: 'text', text: 'Approve writing and begin chapter one.' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const body = await response.text();

      expect(body).toContain('cannot approve writing yet');
      expect(body).not.toContain('Approve & Begin Writing');
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('records one approval receipt whose undo restores stage without rewriting the Deck', async () => {
    mockUsage();
    mockContext();

    const {
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getNovel,
    } = await import('@/lib/db');
    const {
      consumeLatestBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Approve Receipt Undo' });

    try {
      await seedCompleteStoryDeck(novel.id);
      const beforeEntries = await getKnowledgeEntries(novel.id);

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'en',
          messages: [{
            id: 'receipt-approve-user',
            role: 'user',
            parts: [{ type: 'text', text: 'Approve writing and begin chapter one.' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await response.text();

      const receipt = consumeLatestBrainstormReceipt(novel.id);
      expect(receipt).toMatchObject({
        profileFields: expect.arrayContaining(['stage', 'interviewState']),
        storyEntries: [],
      });
      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');

      expect(await undoBrainstormReceipt(novel.id, receipt!.id)).toEqual({ ok: true });
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect(await getKnowledgeEntries(novel.id)).toEqual(beforeEntries);
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
