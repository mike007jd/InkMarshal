// KN-01: syncKnowledgeRelationsForSource must apply every delete + create in a
// SINGLE transaction. If any create violates a constraint mid-sync, the whole
// batch — including the deletes that ran first — must roll back, so the relation
// set is never left partially updated.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-relsync-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USER_ID = '22222222-2222-2222-2222-222222222222';
const NOW = '2026-07-15T00:00:00.000Z';

const S = 'aaaaaaaa-0000-0000-0000-000000000001';
const T1 = 'aaaaaaaa-0000-0000-0000-000000000002';
const T2 = 'aaaaaaaa-0000-0000-0000-000000000003';
const T3 = 'aaaaaaaa-0000-0000-0000-000000000004';
const R1 = 'bbbbbbbb-0000-0000-0000-000000000001'; // S -> T1 'friend' (kept)
const R2 = 'bbbbbbbb-0000-0000-0000-000000000002'; // S -> T2 'mentor' (to delete)

let novelId: string;

function indexFor(id: string): {
  id: string; novelId: string; type: string; path: string; title: string;
  tags: string; aliases: string; importance: string | null; data: string;
  outgoingLinks: string; contentHash: string; updatedAt: string;
} {
  return {
    id, novelId, type: 'character', path: `characters/${id}.md`, title: id,
    tags: '[]', aliases: '[]', importance: null, data: '{}',
    outgoingLinks: '[]', contentHash: 'hash', updatedAt: NOW,
  };
}

async function seed() {
  const { getDb } = await import('@/lib/db/connection');
  const { createNovel } = await import('@/lib/db');
  const novel = await createNovel({ userId: USER_ID, title: 'Rel', genre: 'f', targetWords: 1000 });
  novelId = novel.id;
  const db = getDb();
  const insEntry = db.prepare(
    `INSERT INTO knowledge_entries (id, novel_id, type, title, created_at, updated_at)
     VALUES (?, ?, 'character', ?, ?, ?)`,
  );
  for (const id of [S, T1, T2, T3]) insEntry.run(id, novelId, id, NOW, NOW);
  const insRel = db.prepare(
    `INSERT INTO knowledge_relations (id, source_id, target_id, relation_type, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insRel.run(R1, S, T1, 'friend', 'ally', NOW);
  insRel.run(R2, S, T2, 'mentor', '', NOW);
}

async function relationsOfSource(): Promise<{ target_id: string; relation_type: string }[]> {
  const { getDb } = await import('@/lib/db/connection');
  return getDb()
    .prepare('SELECT target_id, relation_type FROM knowledge_relations WHERE source_id = ? ORDER BY created_at, target_id')
    .all(S) as { target_id: string; relation_type: string }[];
}

beforeEach(async () => {
  const { getDb } = await import('@/lib/db/connection');
  getDb().exec('DELETE FROM knowledge_relations; DELETE FROM knowledge_entries; DELETE FROM novels;');
  await seed();
});

describe('syncKnowledgeRelationsForSource — atomic batch', () => {
  it('applies deletes and creates together on the happy path', async () => {
    const { syncKnowledgeRelationsForSource } = await import('@/lib/db');
    await syncKnowledgeRelationsForSource(
      novelId,
      [R2],
      [{ id: 'cccccccc-0000-0000-0000-000000000001', sourceId: S, targetId: T3, relationType: 'ally', label: '', createdAt: NOW }],
      indexFor(S),
    );
    const rels = await relationsOfSource();
    expect(rels).toEqual([
      { target_id: T1, relation_type: 'friend' }, // kept
      { target_id: T3, relation_type: 'ally' },   // created
    ]); // R2 (T2/mentor) deleted
  });

  it('rolls back the whole batch — including deletes — when a create violates a constraint', async () => {
    const { syncKnowledgeRelationsForSource } = await import('@/lib/db');
    await expect(
      syncKnowledgeRelationsForSource(
        novelId,
        [R2], // would delete S->T2
        [
          { id: 'cccccccc-0000-0000-0000-000000000002', sourceId: S, targetId: T3, relationType: 'ally', label: '', createdAt: NOW },
          // Duplicate of the KEPT R1 (S, T1, 'friend') — violates the unique index mid-batch.
          { id: 'cccccccc-0000-0000-0000-000000000003', sourceId: S, targetId: T1, relationType: 'friend', label: 'dup', createdAt: NOW },
        ],
        indexFor(S),
      ),
    ).rejects.toThrow();

    // Nothing changed: R2 still present (delete rolled back), no S->T3 (create rolled back).
    const rels = await relationsOfSource();
    expect(rels).toEqual([
      { target_id: T1, relation_type: 'friend' },
      { target_id: T2, relation_type: 'mentor' },
    ]);
  });
});
