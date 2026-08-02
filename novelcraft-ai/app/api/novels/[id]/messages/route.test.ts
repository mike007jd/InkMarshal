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
  const addPartialOutput = vi.fn();
  vi.doMock('@/lib/ai-usage', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/ai-usage')>();
    return {
      ...actual,
      createAIUsageSession: vi.fn(async () => ({
        model: {} as never,
        runtimeModel: { id: 'test-model', label: 'Test', provider: 'openai', modelId: 'test', contextWindow: 8192 },
        addPromptText: vi.fn(),
        addPartialOutput,
        recordUsage,
        settle,
        fail,
      })),
    };
  });
  return { recordUsage, fail, settle, addPartialOutput };
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
  onFinish?: (event: {
    responseMessage: {
      id: string;
      role: 'assistant';
      parts: Array<{ type: 'text'; text: string; state?: 'done' }>;
    };
    isAborted: boolean;
    isContinuation: boolean;
    messages: unknown[];
  }) => Promise<void> | void;
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

function mockDeferredStream(args: {
  optionsLog: unknown[];
  gate: { promise: Promise<void> };
  text?: string;
  callCount: { value: number };
}) {
  const text = args.text ?? 'assistant text';
  vi.doMock('ai', async importOriginal => {
    const actual = await importOriginal<typeof import('ai')>();
    return {
      ...actual,
      streamText: vi.fn((opts: {
        onFinish: (event: { text: string; usage: undefined }) => Promise<void>;
        onError?: (event: { error: unknown }) => Promise<void>;
      }) => {
        args.callCount.value += 1;
        args.optionsLog.push(opts);
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
      expect(response.headers.get('X-InkMarshal-Chat-Turn-Status')).toBe('missing');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('reports the latest durable turn status for reload recovery', async () => {
    const {
      addMessageWithId,
      beginChatTurn,
      cancelChatTurn,
      createNovel,
      deleteNovelCascade,
      hashChatTurnRequest,
    } = await import('@/lib/db');
    const { GET } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Turn Recovery Status' });

    try {
      const userMessageId = 'recovery-user';
      const assistantMessageId = 'recovery-assistant';
      await addMessageWithId(novel.id, userMessageId, 'user', 'continue');
      const claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({ content: 'continue', mode: 'ordinary' }),
        assistantMessageId,
      });
      expect(claim.kind).toBe('acquired');
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected an acquired recovery test turn');
      }

      const running = await GET(new Request(`http://localhost/api/novels/${novel.id}/messages`), {
        params: Promise.resolve({ id: novel.id }),
      });
      expect(running.headers.get('X-InkMarshal-Chat-Turn-Status')).toBe('running');

      const { getDb } = await import('@/lib/db/connection');
      getDb().prepare(
        'UPDATE chat_turns SET updated_at = ? WHERE novel_id = ? AND user_message_id = ?',
      ).run('2000-01-01T00:00:00.000Z', novel.id, userMessageId);
      const stale = await GET(new Request(`http://localhost/api/novels/${novel.id}/messages`), {
        params: Promise.resolve({ id: novel.id }),
      });
      expect(stale.headers.get('X-InkMarshal-Chat-Turn-Status')).toBe('stale');

      cancelChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken: claim.turn.claimToken,
        responseText: 'partial',
      });
      await addMessageWithId(novel.id, assistantMessageId, 'assistant', 'partial');
      const cancelled = await GET(new Request(`http://localhost/api/novels/${novel.id}/messages`), {
        params: Promise.resolve({ id: novel.id }),
      });
      expect(cancelled.headers.get('X-InkMarshal-Chat-Turn-Status')).toBe('cancelled');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('reports an exact pending claim before its user message is persisted', async () => {
    const {
      beginChatTurn,
      createNovel,
      deleteNovelCascade,
      hashChatTurnRequest,
    } = await import('@/lib/db');
    const { GET } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Pending Claim Status' });

    try {
      const userMessageId = 'claimed-before-user-persist';
      const claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({ content: 'pending', mode: 'ordinary' }),
        assistantMessageId: 'pending-assistant',
      });
      expect(claim.kind).toBe('acquired');

      const response = await GET(new Request(
        `http://localhost/api/novels/${novel.id}/messages?pendingTurnId=${userMessageId}`,
      ), { params: Promise.resolve({ id: novel.id }) });

      expect(await response.json()).toEqual([]);
      expect(response.headers.get('X-InkMarshal-Chat-Turn-Status')).toBe('running');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('recognizes a v0.1.5 unmarked conversation-style Stop from its cancelled usage receipt', async () => {
    const {
      addMessageWithId,
      beginChatTurn,
      createNovel,
      deleteNovelCascade,
      hashChatTurnRequest,
    } = await import('@/lib/db');
    const { insertAiRun } = await import('@/lib/db/queries-ai-runs');
    const { persistChatTurnAssistantMessage } = await import('@/lib/db/queries-chat-turns');
    const { countWords } = await import('@/lib/utils');
    const { GET } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Legacy Stop Recovery' });

    try {
      const userMessageId = 'legacy-stop-user';
      const assistantMessageId = 'legacy-stop-assistant';
      const partial = 'Legacy conversation partial without a visible Stop suffix.';
      await addMessageWithId(novel.id, userMessageId, 'user', 'Write a long response');
      const claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({
          content: 'Write a long response',
          mode: 'conversation',
          conversationId: 'legacy-conversation',
        }),
        assistantMessageId,
      });
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected an acquired legacy Stop test turn');
      }
      expect(persistChatTurnAssistantMessage({
        novelId: novel.id,
        userMessageId,
        claimToken: claim.turn.claimToken,
        assistantMessageId,
        responseText: partial,
      })).toBeTruthy();
      const runId = insertAiRun({
        operation: 'chat',
        outcome: 'cancelled',
        // Core onFinish may have observed more text than the UI partial that
        // v0.1.5 ultimately persisted.
        generatedWords: countWords(partial) + 3,
      });
      const { getDb } = await import('@/lib/db/connection');
      const legacyAt = '2041-02-03T04:05:06.000Z';
      getDb().prepare('UPDATE ai_runs SET created_at = ? WHERE id = ?').run(legacyAt, runId);
      getDb().prepare(
        'UPDATE chat_turns SET updated_at = ? WHERE novel_id = ? AND user_message_id = ?',
      ).run(legacyAt, novel.id, userMessageId);

      const response = await GET(new Request(`http://localhost/api/novels/${novel.id}/messages`), {
        params: Promise.resolve({ id: novel.id }),
      });
      expect(response.headers.get('X-InkMarshal-Chat-Turn-Status')).toBe('stopped');
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

      const { deterministicAssistantMessageId } = await import('./route');
      const persisted = await getMessages(novel.id);
      expect(persisted.map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual([
        { id: 'user-ui-1', role: 'user', content: 'hello from ui' },
        {
          id: deterministicAssistantMessageId('user-ui-1'),
          role: 'assistant',
          content: 'assistant text',
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
      const statuses = responses.map(response => response.status).sort();
      // Durable claim serializes the side effect: one winner streams, the loser
      // either waits as in_progress or (rarely) replays after completion.
      expect(statuses[0]).toBe(200);
      expect([200, 409]).toContain(statuses[1]);
      if (statuses[1] === 409) {
        expect(bodies.some(body => body.includes('CHAT_TURN_IN_PROGRESS'))).toBe(true);
      } else {
        expect(bodies[0]).toBe(bodies[1]);
      }
      const replay = await makeRequest('en');
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain('Approve & Begin Writing');
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

  it('finalizes from the exact zh-CN QA confirmation without calling the model', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions, 'model prose that must not appear');

    const {
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getMessages,
      getNovel,
      updateNovel,
    } = await import('@/lib/db');
    const { consumeLatestBrainstormReceipt } = await import('@/lib/brainstorm-receipts');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'QA Confirm Final Plan' });
    const qaText = '确认这些条目，没有需要调整的地方，请生成最终故事框架。';
    const userMessageId = 'qa-confirm-final-plan';

    try {
      await updateNovel(novel.id, {
        genre: '悬疑',
        storySummary: '调查员林澈在雾港档案馆发现会自行改写的失踪索引。',
        characterSummary: '林澈保持理性，档案却开始抹去活人。',
        arcSummary: '第一章把他困进索引改写规则。',
      });
      expect(await getKnowledgeEntries(novel.id)).toEqual([]);
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'zh-CN',
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: qaText }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(streamOptions).toHaveLength(0);
      expect(body).toContain('Story Deck 已补全');
      expect(body).not.toContain('model prose');
      expect(body).not.toContain('Approve & Begin Writing');
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');

      const entries = await getKnowledgeEntries(novel.id);
      expect(entries.map(entry => entry.type).sort()).toEqual(['character', 'outline', 'world']);
      expect(entries.some(entry => entry.summary.includes('林澈') || entry.summary.includes('雾港'))).toBe(true);

      const messages = await getMessages(novel.id);
      expect(messages.map(message => ({ id: message.id, role: message.role }))).toEqual([
        { id: userMessageId, role: 'user' },
        { id: deterministicAssistantMessageId(userMessageId), role: 'assistant' },
      ]);
      const receipt = consumeLatestBrainstormReceipt(novel.id);
      expect(receipt).not.toBeNull();
      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();

      const retry = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          language: 'zh-CN',
          messages: [{
            id: userMessageId,
            role: 'user',
            metadata: { persisted: true, conversationId: null },
            parts: [{ type: 'text', text: qaText }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      const retryBody = await retry.text();

      expect(retry.status).toBe(200);
      expect(streamOptions).toHaveLength(0);
      expect(retryBody).toContain('Story Deck 已补全');
      expect(await getKnowledgeEntries(novel.id)).toHaveLength(entries.length);
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual(['user', 'assistant']);
      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not force Story Deck finalization on false-positive confirmation phrasing', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions);

    const { createNovel, deleteNovelCascade, getKnowledgeEntries, getNovel, updateNovel } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'False Positive Confirm' });
    const qaZh = '确认这些条目，没有需要调整的地方，请生成最终故事框架。';
    const qaEn = 'Confirm these entries, nothing needs adjusting, please generate the final story framework.';

    try {
      await updateNovel(novel.id, {
        genre: 'Mystery',
        storySummary: 'An investigator finds a self-rewriting index.',
        characterSummary: 'Lin Che stays rational.',
        arcSummary: 'Chapter one traps him inside the rewrite rule.',
      });

      for (const text of [
        '确认这些条目，没有需要调整的地方吗？',
        '不要确认这些条目，请生成最终故事框架。',
        '我明天可能确认这些条目并生成最终故事框架。',
        '先调整条目，再生成最终故事框架。',
        '界面显示，确认这些条目，没有需要调整的地方，请生成最终故事框架。',
        '请生成最终故事框架。',
        '写一个短篇悬疑故事：调查员林澈在雾港档案馆发现会自行改写的失踪索引。',
        '我无法确认这些条目，但请生成最终故事框架。',
        '我不确认这些条目，请生成最终故事框架。',
        '尚未确认这些条目，请生成最终故事框架。',
        'I cannot confirm these entries, but please generate the final story framework.',
        "I can't confirm these entries, but please generate the final story framework.",
        'I can\u2019t confirm these entries, but please generate the final story framework.',
        'I never confirm these entries, but please generate the final story framework.',
        '我没有确认这些条目，但请生成最终故事框架。',
        '我並沒有確認這些條目，但請生成最終故事框架。',
        'I am unable to confirm these entries, but please generate the final story framework.',
        'I refuse to confirm these entries, but please generate the final story framework.',
        '这些条目不是没问题，请生成最终故事框架。',
        '确认这些条目，但我不想生成最终故事框架。',
        '确认这些条目，等我通知再生成最终故事框架。',
        '如果我确认这些条目，就请生成最终故事框架。',
        'If I confirm these entries, please generate the final story framework.',
        'Confirm these entries, but do not generate the final story framework.',
        '需要我确认这些条目，然后请生成最终故事框架。',
        '确认这些条目，我只是想看看你会不会生成最终故事框架。',
        'Could you confirm these entries and generate the final story framework.',
        '我是在测试：确认这些条目，没有需要调整的地方，请生成最终故事框架。',
        '- [ ] Confirm these entries, nothing needs adjusting, please generate the final story framework.',
        '我确认这些条目还需要调整，请生成最终故事框架。',
        '我确认这些条目有问题，请生成最终故事框架。',
        'I confirm these entries are incorrect. Please generate the final story plan.',
        'I have not decided; these entries look good, please generate the final story plan.',
        'I am undecided. These entries look good. Please generate the final story plan.',
        '我还没决定。这些条目没问题，请生成最终故事框架。',
        `请把“${qaZh}”翻译成英文。`,
        `Please translate "${qaEn}" into Chinese.`,
        `请改写下面这句话：${qaZh}`,
        `Rewrite this as a clearer request: ${qaEn}`,
        `例如：${qaZh}`,
        `For example: ${qaEn}`,
        `\`\`\`\n${qaEn}\n\`\`\`\nPlease explain this sample request.`,
        'confirm these entries is shown in a code block and followed by a meta request',
        `请复述‘${qaZh}’`,
        `> ${qaZh}`,
        `The document contains: ${qaEn}`,
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
        expect(streamOptions, text).toHaveLength(1);
        expect((await getNovel(novel.id))?.stage, text).toBe('discovery_interview');
        expect(await getKnowledgeEntries(novel.id), text).toEqual([]);
      }
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

    const { createNovel, deleteNovelCascade, getMessages, getChatTurn } = await import('@/lib/db');
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
      expect(getChatTurn(novel.id, 'failed-user-1')?.status).toBe('failed');
      expect(usage.settle).toHaveBeenCalledWith({ outcome: 'failed' });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('replays the same deterministic assistant on sequential ordinary-chat duplicates', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions, 'stable ordinary reply');

    const { createNovel, deleteNovelCascade, getMessages, getChatTurn } = await import('@/lib/db');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Sequential Ordinary Idempotency' });
    const userMessageId = 'ordinary-seq-user';
    const body = {
      language: 'en',
      messages: [{
        id: userMessageId,
        role: 'user',
        // Client metadata must be ignored — DB is authoritative.
        metadata: { persisted: false, conversationId: null },
        parts: [{ type: 'text', text: 'hello ordinary' }],
      }],
    };

    try {
      const first = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(await first.text()).toContain('stable ordinary reply');

      const second = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(await second.text()).toContain('stable ordinary reply');

      expect(streamOptions).toHaveLength(1);
      expect((await getMessages(novel.id)).map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual([
        { id: userMessageId, role: 'user', content: 'hello ordinary' },
        {
          id: deterministicAssistantMessageId(userMessageId),
          role: 'assistant',
          content: 'stable ordinary reply',
        },
      ]);
      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'succeeded',
        responseText: 'stable ordinary reply',
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('allows only one deferred provider execution for concurrent ordinary-chat duplicates', async () => {
    mockUsage();
    mockContext();
    let release!: () => void;
    const gate = {
      promise: new Promise<void>(resolve => {
        release = resolve;
      }),
    };
    const streamOptions: unknown[] = [];
    const callCount = { value: 0 };
    mockDeferredStream({ optionsLog: streamOptions, gate, callCount, text: 'only once' });

    const { createNovel, deleteNovelCascade, getMessages, getChatTurn } = await import('@/lib/db');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Concurrent Ordinary Idempotency' });
    const userMessageId = 'ordinary-concurrent-user';
    const body = {
      language: 'en',
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'race me' }],
      }],
    };

    try {
      const started = Promise.all([
        POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), { params: Promise.resolve({ id: novel.id }) }),
        POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), { params: Promise.resolve({ id: novel.id }) }),
      ]);

      // Let both handlers race through beginChatTurn before the provider resumes.
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

      const replay = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain('only once');
      expect(callCount.value).toBe(1);
      expect(streamOptions).toHaveLength(1);
      expect((await getMessages(novel.id)).map(m => ({ id: m.id, role: m.role }))).toEqual([
        { id: userMessageId, role: 'user' },
        { id: deterministicAssistantMessageId(userMessageId), role: 'assistant' },
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('fails closed when the same user_message_id is reused with different content', async () => {
    mockUsage();
    mockContext();
    mockSuccessfulStream('first reply');

    const { createNovel, deleteNovelCascade, getMessages } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Ordinary Collision' });
    const userMessageId = 'ordinary-collision-user';

    try {
      const first = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: 'original content' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await first.text();

      const collision = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: 'mutated content' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(collision.status).toBe(409);
      expect(await collision.json()).toMatchObject({ code: 'CHAT_TURN_REQUEST_COLLISION' });
      expect((await getMessages(novel.id)).map(m => m.content)).toEqual([
        'original content',
        'first reply',
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('fails closed when the same user_message_id changes semantic mode after completion', async () => {
    mockUsage();
    mockContext();
    mockSuccessfulStream('ordinary reply');

    const { createNovel, deleteNovelCascade, getMessages } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Ordinary Mode Collision' });
    const userMessageId = 'ordinary-mode-collision-user';
    const messages = [{
      id: userMessageId,
      role: 'user',
      parts: [{ type: 'text', text: 'keep this request immutable' }],
    }];

    try {
      const first = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await first.text();

      const collision = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages, repairStoryDeck: true }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(collision.status).toBe(409);
      expect(await collision.json()).toMatchObject({ code: 'CHAT_TURN_REQUEST_COLLISION' });
      expect((await getMessages(novel.id)).map(message => message.content)).toEqual([
        'keep this request immutable',
        'ordinary reply',
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('marks a failed ordinary turn retryable and succeeds on the next attempt without duplicating the user row', async () => {
    const usage = mockUsage();
    mockContext();
    vi.doMock('ai', async importOriginal => {
      const actual = await importOriginal<typeof import('ai')>();
      let attempts = 0;
      return {
        ...actual,
        streamText: vi.fn((opts: {
          onFinish: (event: { text: string; usage: undefined }) => Promise<void>;
          onError: (event: { error: unknown }) => Promise<void>;
        }) => {
          attempts += 1;
          return {
            toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
              mockUIMessageResponse(uiOptions, async () => {
                if (attempts === 1) {
                  const error = new Error('provider down');
                  await opts.onError({ error });
                  return { error: uiOptions.onError?.(error) };
                }
                const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
                await opts.onFinish({ text: 'recovered reply', usage: undefined });
                return { type: 'text-delta', messageId: id, delta: 'recovered reply' };
              }),
          };
        }),
      };
    });

    const { createNovel, deleteNovelCascade, getMessages, getChatTurn } = await import('@/lib/db');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Ordinary Fail Then Retry' });
    const userMessageId = 'ordinary-fail-retry-user';
    const body = {
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'please retry me' }],
      }],
    };

    try {
      const failed = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      await failed.text();
      expect(getChatTurn(novel.id, userMessageId)?.status).toBe('failed');
      expect((await getMessages(novel.id)).map(m => m.role)).toEqual(['user']);

      const retried = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(await retried.text()).toContain('recovered reply');
      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'succeeded',
        responseText: 'recovered reply',
      });
      expect((await getMessages(novel.id)).map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual([
        { id: userMessageId, role: 'user', content: 'please retry me' },
        {
          id: deterministicAssistantMessageId(userMessageId),
          role: 'assistant',
          content: 'recovered reply',
        },
      ]);
      expect(usage.settle).toHaveBeenCalledWith({ outcome: 'failed' });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('replays from the durable turn receipt after a completed ordinary chat', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions, 'receipt replay');

    const { createNovel, deleteNovelCascade, getChatTurn, getMessages } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { POST, deterministicAssistantMessageId } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Ordinary Completed Replay' });
    const userMessageId = 'ordinary-replay-user';
    const body = {
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'persist then replay' }],
      }],
    };

    try {
      const first = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      await first.text();
      expect(getChatTurn(novel.id, userMessageId)?.status).toBe('succeeded');

      // Simulate response-row loss after the durable receipt was stamped succeeded.
      getDb()
        .prepare('DELETE FROM messages WHERE novel_id = ? AND id = ?')
        .run(novel.id, deterministicAssistantMessageId(userMessageId));

      const replay = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          messages: [{
            ...body.messages[0],
            metadata: { persisted: true, conversationId: null },
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain('receipt replay');
      expect(streamOptions).toHaveLength(1);
      expect((await getMessages(novel.id)).map(m => m.id)).toEqual([
        userMessageId,
        deterministicAssistantMessageId(userMessageId),
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('allows only one special-branch side effect for concurrent repair duplicates', async () => {
    mockUsage();
    mockContext();
    const finalizeCount = { value: 0 };
    vi.doMock('@/lib/brainstorm-agent', async importOriginal => {
      const actual = await importOriginal<typeof import('@/lib/brainstorm-agent')>();
      return {
        ...actual,
        finalizeApprovedStoryDeckForClaim: vi.fn(async (
          ...args: Parameters<typeof actual.finalizeApprovedStoryDeckForClaim>
        ) => {
          finalizeCount.value += 1;
          return actual.finalizeApprovedStoryDeckForClaim(...args);
        }),
      };
    });

    const {
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getMessages,
      updateNovel,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Concurrent Repair Claim' });
    const userMessageId = 'repair-concurrent-user';
    const body = {
      language: 'en',
      repairStoryDeck: true,
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'Complete the approved Story Deck.' }],
      }],
    };

    try {
      await updateNovel(novel.id, {
        stage: 'ready_for_greenlight',
        genre: 'Fantasy',
        storySummary: 'Two sisters uncover a haunted archive.',
        characterSummary: 'The sisters disagree about whether to trust the archive.',
        arcSummary: 'They reconcile while sealing the archive.',
      });

      const [first, second] = await Promise.all([
        POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), { params: Promise.resolve({ id: novel.id }) }),
        POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }), { params: Promise.resolve({ id: novel.id }) }),
      ]);
      const bodies = await Promise.all([first.text(), second.text()]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(bodies.some(body => body.includes('Story Deck completed'))).toBe(true);
      expect(bodies.some(body => body.includes('CHAT_TURN_IN_PROGRESS'))).toBe(true);
      expect(finalizeCount.value).toBe(1);
      expect((await getKnowledgeEntries(novel.id)).map(entry => entry.type).sort()).toEqual([
        'character',
        'outline',
        'world',
      ]);
      expect((await getMessages(novel.id)).map(message => message.role)).toEqual(['user', 'assistant']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('reuses brainstorm_receipt_id after provider failure and across durable restart', async () => {
    mockUsage();
    mockContext();
    vi.doMock('ai', async importOriginal => {
      const actual = await importOriginal<typeof import('ai')>();
      let attempts = 0;
      return {
        ...actual,
        streamText: vi.fn((opts: {
          onFinish: (event: { text: string; usage: undefined }) => Promise<void>;
          onError: (event: { error: unknown }) => Promise<void>;
        }) => {
          attempts += 1;
          return {
            toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
              mockUIMessageResponse(uiOptions, async () => {
                if (attempts === 1) {
                  const error = new Error('provider down');
                  await opts.onError({ error });
                  return { error: uiOptions.onError?.(error) };
                }
                const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
                await opts.onFinish({ text: 'reused receipt reply', usage: undefined });
                return { type: 'text-delta', messageId: id, delta: 'reused receipt reply' };
              }),
          };
        }),
      };
    });

    const { createNovel, deleteNovelCascade, getChatTurn } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Receipt Reuse' });
    const userMessageId = 'receipt-reuse-user';
    const body = {
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'keep the receipt' }],
      }],
    };

    try {
      const failed = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      await failed.text();
      const failedTurn = getChatTurn(novel.id, userMessageId);
      expect(failedTurn?.status).toBe('failed');
      expect(failedTurn?.brainstormReceiptId).toBeTruthy();
      const receiptId = failedTurn!.brainstormReceiptId!;

      // Receipts are SQLite-durable: a process restart must still see the row so
      // retries reuse the same chat_turns.brainstorm_receipt_id.
      const { getDb } = await import('@/lib/db/connection');
      const durableBeforeRetry = getDb()
        .prepare('SELECT id, novel_id FROM brainstorm_receipts WHERE id = ?')
        .get(receiptId) as { id: string; novel_id: string } | undefined;
      expect(durableBeforeRetry).toEqual({ id: receiptId, novel_id: novel.id });

      const retried = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(await retried.text()).toContain('reused receipt reply');
      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'succeeded',
        brainstormReceiptId: receiptId,
      });
      expect(
        getDb()
          .prepare('SELECT id FROM brainstorm_receipts WHERE id = ?')
          .get(receiptId),
      ).toEqual({ id: receiptId });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('reclaims a stale running ordinary turn and retries safely', async () => {
    mockUsage();
    mockContext();
    const streamOptions: unknown[] = [];
    mockCapturedStream(streamOptions, 'stale reclaim reply');

    const { createNovel, deleteNovelCascade, getChatTurn, getMessages } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { CHAT_TURN_STALE_LEASE_MS } = await import('@/lib/db/queries-chat-turns');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Stale Running Retry' });
    const userMessageId = 'stale-running-retry-user';
    const body = {
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'abandoned mid-flight' }],
      }],
    };

    try {
      const { beginChatTurn, hashChatTurnRequest } = await import('@/lib/db/queries-chat-turns');
      const assistantMessageId = deterministicAssistantMessageId(userMessageId);
      expect(beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({ content: 'abandoned mid-flight', mode: 'ordinary' }),
        assistantMessageId,
      }).kind).toBe('acquired');
      getDb()
        .prepare(
          `UPDATE chat_turns
              SET brainstorm_receipt_id = ?, updated_at = ?
            WHERE novel_id = ? AND user_message_id = ?`,
        )
        .run(
          'prebound-receipt',
          new Date(Date.now() - CHAT_TURN_STALE_LEASE_MS - 5_000).toISOString(),
          novel.id,
          userMessageId,
        );

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(await response.text()).toContain('stale reclaim reply');
      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'succeeded',
        brainstormReceiptId: 'prebound-receipt',
        responseText: 'stale reclaim reply',
      });
      expect(streamOptions).toHaveLength(1);
      expect((await getMessages(novel.id)).map(m => m.id)).toEqual([
        userMessageId,
        assistantMessageId,
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not stale-reclaim an active deferred provider stream into a second paid call', async () => {
    mockUsage();
    mockContext();
    let release!: () => void;
    const gate = {
      promise: new Promise<void>(resolve => {
        release = resolve;
      }),
    };
    const streamOptions: unknown[] = [];
    const callCount = { value: 0 };
    mockDeferredStream({ optionsLog: streamOptions, gate, callCount, text: 'live lease reply' });

    const { createNovel, deleteNovelCascade, getChatTurn, getMessages } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { CHAT_TURN_STALE_LEASE_MS } = await import('@/lib/db/queries-chat-turns');
    const { __tickChatTurnClaimLeasesForTest } = await import('@/lib/chat-turn-lease');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Active Claim Lease Race' });
    const userMessageId = 'active-lease-race-user';
    const body = {
      language: 'en',
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'keep me alive' }],
      }],
    };

    try {
      const firstPromise = POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });

      await vi.waitFor(() => {
        expect(callCount.value).toBe(1);
      });
      expect(getChatTurn(novel.id, userMessageId)?.status).toBe('running');

      // Backdate past the previous stale threshold while the first worker is
      // still mid-flight. Without heartbeat renewal this would be reclaimable.
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

      // Deterministic heartbeat: renew the live claim without waiting minutes.
      __tickChatTurnClaimLeasesForTest();
      expect(getChatTurn(novel.id, userMessageId)?.updatedAt).not.toBe(
        new Date(Date.now() - CHAT_TURN_STALE_LEASE_MS - 5_000).toISOString(),
      );

      const duplicate = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: 'CHAT_TURN_IN_PROGRESS' });
      expect(callCount.value).toBe(1);

      release();
      const first = await firstPromise;
      expect(first.status).toBe(200);
      expect(await first.text()).toContain('live lease reply');
      expect(callCount.value).toBe(1);
      expect(streamOptions).toHaveLength(1);

      const replay = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain('live lease reply');
      expect(callCount.value).toBe(1);
      expect((await getMessages(novel.id)).map(m => m.id)).toEqual([
        userMessageId,
        deterministicAssistantMessageId(userMessageId),
      ]);
    } finally {
      release();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('persists a stopped partial once when official non-awaited abort precedes UI onFinish', async () => {
    const usage = mockUsage();
    mockContext();
    const requestController = new AbortController();
    vi.doMock('ai', async importOriginal => {
      const actual = await importOriginal<typeof import('ai')>();
      return {
        ...actual,
        streamText: vi.fn((opts: {
          onAbort?: (event: { steps: unknown[] }) => void | Promise<void>;
        }) => ({
          toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
            mockUIMessageResponse(uiOptions, async () => {
              // AI SDK 6.0.208 abort-part path: non-awaited onAbort, no onError.
              requestController.abort();
              void opts.onAbort?.({ steps: [] });
              const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
              await uiOptions.onFinish?.({
                responseMessage: {
                  id,
                  role: 'assistant',
                  parts: [{ type: 'text', text: 'partial reply', state: 'done' }],
                },
                isAborted: true,
                isContinuation: false,
                messages: [],
              });
              return { aborted: true, messageId: id };
            }),
        })),
      };
    });

    const { createNovel, deleteNovelCascade, getChatTurn, getMessages } = await import('@/lib/db');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Stop Partial Official Abort' });
    const userMessageId = 'stop-partial-official-abort-user';

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: requestController.signal,
        body: JSON.stringify({
          stoppedLabel: 'Stopped',
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: 'stop me after partial' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await response.text();

      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'cancelled',
        responseText: 'partial reply\n\nStopped',
      });
      expect((await getMessages(novel.id)).map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual([
        { id: userMessageId, role: 'user', content: 'stop me after partial' },
        {
          id: deterministicAssistantMessageId(userMessageId),
          role: 'assistant',
          content: 'partial reply\n\nStopped',
        },
      ]);
      expect(usage.addPartialOutput).toHaveBeenCalledWith('partial reply');
      expect(usage.addPartialOutput.mock.invocationCallOrder[0]).toBeLessThan(
        usage.settle.mock.invocationCallOrder[0]!,
      );
      expect(usage.settle).toHaveBeenCalledTimes(1);
      expect(usage.settle).toHaveBeenCalledWith({ outcome: 'cancelled', usage: undefined });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('persists a stopped partial once when core onError races ahead of UI onFinish', async () => {
    const usage = mockUsage();
    mockContext();
    const requestController = new AbortController();
    vi.doMock('ai', async importOriginal => {
      const actual = await importOriginal<typeof import('ai')>();
      return {
        ...actual,
        streamText: vi.fn((opts: {
          onError: (event: { error: unknown }) => Promise<void>;
        }) => ({
          toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
            mockUIMessageResponse(uiOptions, async () => {
              // Packaged Stop ordering: request abort + core onError before
              // UI-stream onFinish({ isAborted }) owns partial persistence.
              requestController.abort();
              await opts.onError({
                error: new DOMException('The operation was aborted.', 'AbortError'),
              });
              const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
              await uiOptions.onFinish?.({
                responseMessage: {
                  id,
                  role: 'assistant',
                  parts: [{ type: 'text', text: 'partial reply', state: 'done' }],
                },
                isAborted: true,
                isContinuation: false,
                messages: [],
              });
              return { aborted: true, messageId: id };
            }),
        })),
      };
    });

    const { createNovel, deleteNovelCascade, getChatTurn, getMessages } = await import('@/lib/db');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Stop Partial Race' });
    const userMessageId = 'stop-partial-race-user';

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: requestController.signal,
        body: JSON.stringify({
          stoppedLabel: 'Stopped',
          messages: [{
            id: userMessageId,
            role: 'user',
            parts: [{ type: 'text', text: 'stop me after partial' }],
          }],
        }),
      }), { params: Promise.resolve({ id: novel.id }) });
      await response.text();

      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'cancelled',
        responseText: 'partial reply\n\nStopped',
      });
      expect((await getMessages(novel.id)).map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual([
        { id: userMessageId, role: 'user', content: 'stop me after partial' },
        {
          id: deterministicAssistantMessageId(userMessageId),
          role: 'assistant',
          content: 'partial reply\n\nStopped',
        },
      ]);
      expect(usage.addPartialOutput).toHaveBeenCalledWith('partial reply');
      expect(usage.addPartialOutput.mock.invocationCallOrder[0]).toBeLessThan(
        usage.settle.mock.invocationCallOrder[0]!,
      );
      expect(usage.settle).toHaveBeenCalledTimes(1);
      expect(usage.settle).toHaveBeenCalledWith({ outcome: 'cancelled', usage: undefined });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('cancels an empty stopped turn and allows a later retry', async () => {
    const usage = mockUsage();
    mockContext();
    const requestController = new AbortController();
    let attempts = 0;
    vi.doMock('ai', async importOriginal => {
      const actual = await importOriginal<typeof import('ai')>();
      return {
        ...actual,
        streamText: vi.fn((opts: {
          onError: (event: { error: unknown }) => Promise<void>;
          onFinish: (event: { text: string; usage: undefined }) => Promise<void>;
        }) => {
          attempts += 1;
          return {
            toUIMessageStreamResponse: (uiOptions: MockUIMessageResponseOptions) =>
              mockUIMessageResponse(uiOptions, async () => {
                if (attempts === 1) {
                  requestController.abort();
                  await opts.onError({
                    error: new DOMException('The operation was aborted.', 'AbortError'),
                  });
                  const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
                  await uiOptions.onFinish?.({
                    responseMessage: {
                      id,
                      role: 'assistant',
                      parts: [{ type: 'text', text: '', state: 'done' }],
                    },
                    isAborted: true,
                    isContinuation: false,
                    messages: [],
                  });
                  return { aborted: true, messageId: id };
                }
                const id = uiOptions.generateMessageId?.() ?? 'assistant-1';
                await opts.onFinish({ text: 'retry reply', usage: undefined });
                return { type: 'text-delta', messageId: id, delta: 'retry reply' };
              }),
          };
        }),
      };
    });

    const { createNovel, deleteNovelCascade, getChatTurn, getMessages } = await import('@/lib/db');
    const { deterministicAssistantMessageId, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Empty Stop Retry' });
    const userMessageId = 'empty-stop-retry-user';
    const body = {
      stoppedLabel: 'Stopped',
      messages: [{
        id: userMessageId,
        role: 'user',
        parts: [{ type: 'text', text: 'empty stop then retry' }],
      }],
    };

    try {
      const stopped = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: requestController.signal,
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      await stopped.text();
      expect(getChatTurn(novel.id, userMessageId)?.status).toBe('cancelled');
      expect((await getMessages(novel.id)).map(m => m.role)).toEqual(['user']);
      expect(usage.settle).toHaveBeenCalledWith({ outcome: 'cancelled', usage: undefined });

      const retried = await POST(new Request(`http://localhost/api/novels/${novel.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(await retried.text()).toContain('retry reply');
      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'succeeded',
        responseText: 'retry reply',
      });
      expect((await getMessages(novel.id)).map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual([
        { id: userMessageId, role: 'user', content: 'empty stop then retry' },
        {
          id: deterministicAssistantMessageId(userMessageId),
          role: 'assistant',
          content: 'retry reply',
        },
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
