import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Same on-disk SQLite isolation as the other db-backed suites.
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-apply-write-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USER = 'apply-write-user';

async function setup() {
  const db = await import('@/lib/db');
  const novel = await db.createNovel({ userId: USER, title: 'Apply Write Novel', genre: 'fantasy', targetWords: 80000 });
  const now = new Date().toISOString();
  const mk = async (type: 'character', title: string) => {
    const id = crypto.randomUUID();
    await db.createKnowledgeEntry({
      id, novelId: novel.id, type, title,
      summary: `summary of ${title}`,
      data: JSON.stringify({ role: 'supporting' }),
      sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
    });
    return id;
  };
  const sourceId = await mk('character', 'Source Hero');
  const targetId = await mk('character', 'Target Ally');
  await db.createKnowledgeRelation({
    id: crypto.randomUUID(), sourceId, targetId, relationType: 'ally', label: 'trusts', createdAt: now,
  });
  return { db, novel, sourceId, targetId, now };
}

describe('buildIndexSyncInputForEntry (consolidated index projection)', () => {
  it('folds the entry\'s outgoing relations into data.relations', async () => {
    const { db, sourceId, now } = await setup();
    const { buildIndexSyncInputForEntry } = await import('@/lib/knowledge/refresh-index');
    const source = (await db.getKnowledgeEntryById(sourceId))!;

    const input = await buildIndexSyncInputForEntry(source, now);
    expect(input.data.relations).toEqual([
      { target: 'Target Ally', type: 'ally', label: 'trusts' },
    ]);
  });

  it('honours excludeTargetId (relation being deleted by endpoint)', async () => {
    const { db, sourceId, targetId, now } = await setup();
    const { buildIndexSyncInputForEntry } = await import('@/lib/knowledge/refresh-index');
    const source = (await db.getKnowledgeEntryById(sourceId))!;

    const input = await buildIndexSyncInputForEntry(source, now, { excludeTargetId: targetId });
    expect(input.data.relations).toBeUndefined();
  });

  it('honours an in-flight add not yet committed to the relation table', async () => {
    const { db, sourceId, now } = await setup();
    const { buildIndexSyncInputForEntry } = await import('@/lib/knowledge/refresh-index');
    const source = (await db.getKnowledgeEntryById(sourceId))!;

    const input = await buildIndexSyncInputForEntry(source, now, {
      add: { targetTitle: 'New Friend', relationType: 'mentor', label: '' },
    });
    expect(input.data.relations).toEqual([
      { target: 'Target Ally', type: 'ally', label: 'trusts' },
      { target: 'New Friend', type: 'mentor', label: '' },
    ]);
  });
});

describe('applyKnowledgeEntryWrite (shared write unit)', () => {
  it('updates the entry row and the recall index consistently', async () => {
    const { db, sourceId, now } = await setup();
    const { buildIndexSyncInputForEntry } = await import('@/lib/knowledge/refresh-index');
    const { buildKnowledgeIndexInsert } = await import('@/lib/knowledge/index-sync');
    const { applyKnowledgeEntryWrite } = await import('@/lib/knowledge/apply-write');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const source = (await db.getKnowledgeEntryById(sourceId))!;
    const updatedAt = new Date(Date.parse(now) + 1000).toISOString();
    const index = await buildKnowledgeIndexInsert(
      await buildIndexSyncInputForEntry(source, updatedAt, { summary: 'AI-written summary' }),
    );

    await applyKnowledgeEntryWrite({
      entryId: sourceId,
      novelId: source.novel_id,
      fields: { summary: 'AI-written summary', updatedAt },
      index,
      context: 'test',
    });

    const after = (await db.getKnowledgeEntryById(sourceId))!;
    expect(after.summary).toBe('AI-written summary');

    const indexRow = await getKnowledgeIndexById(sourceId);
    expect(indexRow).not.toBeNull();
    expect(indexRow!.title).toBe('Source Hero');
    // The recall index row mirrors the entry — same id and novel.
    expect(indexRow!.novelId).toBe(source.novel_id);
  });
});
