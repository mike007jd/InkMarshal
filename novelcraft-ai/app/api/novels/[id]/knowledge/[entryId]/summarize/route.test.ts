import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  createAIUsageSession: vi.fn(),
  createUsageSettlement: vi.fn((session: { fail: () => Promise<void>; recordUsage: (usage: unknown) => Promise<void> }) => {
    let settled = false;
    return {
      failOnce: async () => {
        if (settled) return;
        settled = true;
        await session.fail();
      },
      recordOnce: async (usage: unknown) => {
        if (settled) return;
        settled = true;
        await session.recordUsage(usage);
      },
      isSettled: () => settled,
    };
  }),
  aiUsageErrorResponse: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: mocks.generateText,
}));

vi.mock('@/lib/ai-usage', () => ({
  createAIUsageSession: mocks.createAIUsageSession,
  createUsageSettlement: mocks.createUsageSettlement,
  aiUsageErrorResponse: mocks.aiUsageErrorResponse,
}));

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
const PREV_EMBED_BASE_URL = process.env.INKMARSHAL_EMBED_BASE_URL;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-knowledge-summary-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
  delete process.env.INKMARSHAL_EMBED_BASE_URL;
});

beforeEach(() => {
  mocks.generateText.mockReset();
  mocks.generateText.mockResolvedValue({
    text: 'Fresh generated summary',
    usage: {},
  });
  mocks.aiUsageErrorResponse.mockReset();
  mocks.aiUsageErrorResponse.mockReturnValue(null);
  mocks.createAIUsageSession.mockReset();
  mocks.createUsageSettlement.mockClear();
  mocks.createAIUsageSession.mockResolvedValue({
    model: {},
    addPromptText: vi.fn(),
    addPartialOutput: vi.fn(),
    recordUsage: vi.fn(),
    fail: vi.fn(),
  });
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  if (PREV_EMBED_BASE_URL === undefined) delete process.env.INKMARSHAL_EMBED_BASE_URL;
  else process.env.INKMARSHAL_EMBED_BASE_URL = PREV_EMBED_BASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('knowledge summarize route helpers', () => {
  it('normalizes and hard-caps generated summaries', async () => {
    const { normalizeGeneratedKnowledgeSummary } = await import('./route');

    expect(normalizeGeneratedKnowledgeSummary('  one\n two\t three  ', 'fallback')).toBe('one two three');
    expect(normalizeGeneratedKnowledgeSummary('x'.repeat(150), 'fallback')).toHaveLength(100);
    expect(normalizeGeneratedKnowledgeSummary('   ', 'fallback summary')).toBe('fallback summary');
    expect(normalizeGeneratedKnowledgeSummary('   ', 'f'.repeat(150))).toHaveLength(100);
  });

  it('settles AI usage only after the final abort gate', () => {
    const source = readFileSync('app/api/novels/[id]/knowledge/[entryId]/summarize/route.ts', 'utf8');

    expect(source).toContain('const usageSettlement = createUsageSettlement(aiUsage);');
    expect(source.indexOf('await usageSettlement.recordOnce(usage);')).toBeGreaterThan(
      source.indexOf('if (req.signal.aborted) {'),
    );
    expect(source.indexOf('await usageSettlement.recordOnce(usage);')).toBeGreaterThan(
      source.indexOf('await applyKnowledgeEntryWrite({'),
    );
    expect(source).toContain('await usageSettlement.failOnce();\n        return NextResponse.json({ error: \'Not found\' }, { status: 404 });');
  });
});

describe('knowledge summarize route', () => {
  it('removes stale semantic embeddings after refreshing generated summary index state', async () => {
    const { POST } = await import('./route');
    const { createNovel, getKnowledgeEntry } = await import('@/lib/db');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');

    const novel = await createNovel({
      userId: 'local-user',
      title: 'Summary API Novel',
      genre: 'fantasy',
    });
    const entry = await createKnowledgeEntry(novel.id, {
      type: 'world',
      title: 'Vector Harbor',
      data: { category: 'location', description: 'Old harbor facts', details: {} },
      tags: [],
    });
    await upsertKnowledgeEmbedding({
      id: entry.id,
      novelId: novel.id,
      modelId: 'test-embedder',
      dim: 2,
      vector: Float32Array.from([1, 0]),
      contentHash: 'old-summary-content',
      updatedAt: new Date().toISOString(),
    });
    const beforeIndex = await getKnowledgeIndexById(entry.id);

    const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/knowledge/${entry.id}/summarize`, {
      method: 'POST',
    }), { params: Promise.resolve({ id: novel.id, entryId: entry.id }) });

    expect(response.status).toBe(200);
    expect(mocks.createAIUsageSession).toHaveBeenCalledWith(expect.any(Request), {
      userId: 'local-user',
      operation: 'summarize',
    });
    await Promise.resolve();
    expect((await getKnowledgeEntry(entry.id, novel.id))?.summary).toBe('Fresh generated summary');
    expect((await getKnowledgeIndexById(entry.id))?.contentHash).not.toBe(beforeIndex?.contentHash);
    expect(await getKnowledgeEmbedding(entry.id)).toBeNull();
  });

  it('rolls back the generated summary when recall index refresh fails', async () => {
    const { POST } = await import('./route');
    const { createNovel, getKnowledgeEntry } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const failUsage = vi.fn();
    mocks.createAIUsageSession.mockResolvedValueOnce({
      model: {},
      addPromptText: vi.fn(),
      addPartialOutput: vi.fn(),
      recordUsage: vi.fn(),
      fail: failUsage,
    });
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Summary API Rollback Novel',
      genre: 'fantasy',
    });
    const entry = await createKnowledgeEntry(novel.id, {
      type: 'world',
      title: 'Rollback Harbor',
      data: { category: 'location', description: 'Original harbor facts', details: {} },
      tags: [],
    });
    const beforeEntry = await getKnowledgeEntry(entry.id, novel.id);
    const beforeIndex = await getKnowledgeIndexById(entry.id);
    expect(beforeEntry).not.toBeNull();
    expect(beforeIndex).not.toBeNull();

    const db = getDb();
    db.prepare(
      `CREATE TRIGGER block_summary_index_update
       BEFORE UPDATE ON knowledge_index
       WHEN NEW.id = '${entry.id}'
       BEGIN
         SELECT RAISE(ABORT, 'blocked summary index update');
       END`,
    ).run();
    try {
      await expect(POST(new Request(`http://localhost/api/novels/${novel.id}/knowledge/${entry.id}/summarize`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id, entryId: entry.id }) })).rejects.toThrow('blocked summary index update');
    } finally {
      db.prepare('DROP TRIGGER IF EXISTS block_summary_index_update').run();
    }

    expect(failUsage).toHaveBeenCalledTimes(1);
    expect((await getKnowledgeEntry(entry.id, novel.id))?.summary).toBe(beforeEntry!.summary);
    expect(await getKnowledgeIndexById(entry.id)).toEqual(beforeIndex);
  });

  it('does not refresh entry, index, embedding, or novel recency when generated summary is unchanged', async () => {
    const { POST } = await import('./route');
    const { createNovel, getKnowledgeEntry, getNovel } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');

    mocks.generateText.mockResolvedValueOnce({
      text: 'Existing generated summary',
      usage: {},
    });
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Summary API No-op Novel',
      genre: 'fantasy',
    });
    const entry = await createKnowledgeEntry(novel.id, {
      type: 'world',
      title: 'Static Harbor',
      data: { category: 'location', description: 'Stable harbor facts', details: {} },
      tags: [],
    });
    const stale = '2000-01-01T00:00:00.000Z';
    getDb().prepare('UPDATE knowledge_entries SET summary = ?, updated_at = ? WHERE id = ?')
      .run('Existing generated summary', stale, entry.id);
    await upsertKnowledgeEmbedding({
      id: entry.id,
      novelId: novel.id,
      modelId: 'test-embedder',
      dim: 2,
      vector: Float32Array.from([0.5, 0.5]),
      contentHash: 'stable-summary-content',
      updatedAt: stale,
    });
    const beforeIndex = await getKnowledgeIndexById(entry.id);
    const beforeEmbedding = await getKnowledgeEmbedding(entry.id);
    getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);

    const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/knowledge/${entry.id}/summarize`, {
      method: 'POST',
    }), { params: Promise.resolve({ id: novel.id, entryId: entry.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ summary: 'Existing generated summary' });
    expect((await getKnowledgeEntry(entry.id, novel.id))?.updated_at).toBe(stale);
    expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));
    expect(await getKnowledgeIndexById(entry.id)).toEqual(beforeIndex);
    expect(await getKnowledgeEmbedding(entry.id)).toEqual(beforeEmbedding);
  });

  it('rejects a stale generated summary if the knowledge entry changes during model work', async () => {
    const { POST } = await import('./route');
    const { createNovel, getKnowledgeEntry } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const failUsage = vi.fn();
    mocks.createAIUsageSession.mockResolvedValueOnce({
      model: {},
      addPromptText: vi.fn(),
      addPartialOutput: vi.fn(),
      recordUsage: vi.fn(),
      fail: failUsage,
    });
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Summary API Stale Novel',
      genre: 'fantasy',
    });
    const entry = await createKnowledgeEntry(novel.id, {
      type: 'world',
      title: 'Changed Harbor',
      data: { category: 'location', description: 'Original harbor facts', details: {} },
      tags: [],
    });
    const beforeEntry = await getKnowledgeEntry(entry.id, novel.id);
    expect(beforeEntry).toBeDefined();
    const changedAt = '2030-01-01T00:00:00.000Z';
    mocks.generateText.mockImplementationOnce(async () => {
      getDb().prepare('UPDATE knowledge_entries SET data = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ category: 'location', description: 'Changed facts', details: {} }), changedAt, entry.id);
      return { text: 'Summary from stale facts', usage: {} };
    });

    const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/knowledge/${entry.id}/summarize`, {
      method: 'POST',
    }), { params: Promise.resolve({ id: novel.id, entryId: entry.id }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Knowledge entry changed during summary generation.',
    });
    expect(failUsage).toHaveBeenCalledTimes(1);
    const after = await getKnowledgeEntry(entry.id, novel.id);
    expect(after?.summary).toBe(beforeEntry!.summary);
    expect(after?.updated_at).toBe(changedAt);
  });
});
