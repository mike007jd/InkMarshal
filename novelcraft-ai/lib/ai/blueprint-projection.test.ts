// Wave 2 commit D — projectBlueprintFromOutline end-to-end tests.
//
// The projector is the runtime replacement for the dropped `novels.blueprint`
// column. It must:
//   1. Return null when no outline rows exist.
//   2. Aggregate outline rows into a `NovelBlueprint` with stable ordering.
//   3. Renumber chapters into 1..N when frontmatter chapterNumbers have gaps
//      or duplicates (defensive — manual outline edits can leave the order
//      inconsistent).
//   4. Surface `modelId = 'derived'` so callers can tell projected from
//      AI-generated blueprints.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-projection-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  const dbMod = await import('@/lib/db');
  const proj = await import('@/lib/ai/blueprint-projection');
  return { ...dbMod, ...proj };
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('projectBlueprintFromOutline', () => {
  it('returns null when no outline entries exist', async () => {
    const { createNovel, deleteNovelCascade, projectBlueprintFromOutline } = await load();
    const novel = await createNovel({ userId: USER_ID, title: 'Empty' });
    try {
      const bp = await projectBlueprintFromOutline(novel.id);
      expect(bp).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('aggregates outline rows into a blueprint with chapters sorted by chapterNumber ASC', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      projectBlueprintFromOutline,
    } = await load();
    const novel = await createNovel({ userId: USER_ID, title: 'Agg' });
    try {
      const now = new Date().toISOString();
      // Create rows out-of-order to confirm the projector sorts.
      await createKnowledgeEntry({
        id: crypto.randomUUID(), novelId: novel.id, type: 'outline', title: 'C',
        summary: '', data: JSON.stringify({ chapterNumber: 3, synopsis: 'third', wordCountTarget: 1000 }),
        sortOrder: 2, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: crypto.randomUUID(), novelId: novel.id, type: 'outline', title: 'A',
        summary: '', data: JSON.stringify({ chapterNumber: 1, synopsis: 'first', wordCountTarget: 1000 }),
        sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: crypto.randomUUID(), novelId: novel.id, type: 'outline', title: 'B',
        summary: '', data: JSON.stringify({ chapterNumber: 2, synopsis: 'second', wordCountTarget: 1000 }),
        sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
      });

      const bp = await projectBlueprintFromOutline(novel.id);
      expect(bp).not.toBeNull();
      expect(bp!.chapters.map(c => c.chapterNumber)).toEqual([1, 2, 3]);
      expect(bp!.chapters.map(c => c.title)).toEqual(['A', 'B', 'C']);
      expect(bp!.chapters.map(c => c.summary)).toEqual(['first', 'second', 'third']);
      expect(bp!.targetWordsPerChapter).toBe(1000);
      expect(bp!.modelId).toBe('derived');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('renumbers chapters to 1..N when stored chapterNumbers have gaps', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      projectBlueprintFromOutline,
    } = await load();
    const novel = await createNovel({ userId: USER_ID, title: 'Gap' });
    try {
      const now = new Date().toISOString();
      await createKnowledgeEntry({
        id: crypto.randomUUID(), novelId: novel.id, type: 'outline', title: 'First',
        summary: '', data: JSON.stringify({ chapterNumber: 1, synopsis: '' }),
        sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
      });
      // Skip 2, jump to 5
      await createKnowledgeEntry({
        id: crypto.randomUUID(), novelId: novel.id, type: 'outline', title: 'Far',
        summary: '', data: JSON.stringify({ chapterNumber: 5, synopsis: '' }),
        sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
      });

      const bp = await projectBlueprintFromOutline(novel.id);
      expect(bp).not.toBeNull();
      // Gap detected -> projector compacts to 1..2.
      expect(bp!.chapters.map(c => c.chapterNumber)).toEqual([1, 2]);
      expect(bp!.chapters.map(c => c.title)).toEqual(['First', 'Far']);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('setNovelBlueprint + getNovelBlueprint round-trip yields the same chapter shape', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      setNovelBlueprint,
      getNovelBlueprint,
    } = await load();
    const novel = await createNovel({ userId: USER_ID, title: 'RT' });
    try {
      await setNovelBlueprint(novel.id, {
        chapters: [
          { chapterNumber: 1, title: 'Alpha', summary: 'one' },
          { chapterNumber: 2, title: 'Beta', summary: 'two' },
          { chapterNumber: 3, title: 'Gamma', summary: 'three' },
        ],
        targetWordsPerChapter: 2000,
        generatedAt: '2026-05-18T00:00:00.000Z',
        modelId: 'roundtrip',
      });
      const bp = await getNovelBlueprint(novel.id);
      expect(bp).not.toBeNull();
      expect(bp!.chapters.map(c => ({
        chapterNumber: c.chapterNumber,
        title: c.title,
        summary: c.summary,
      }))).toEqual([
        { chapterNumber: 1, title: 'Alpha', summary: 'one' },
        { chapterNumber: 2, title: 'Beta', summary: 'two' },
        { chapterNumber: 3, title: 'Gamma', summary: 'three' },
      ]);
      // modelId is overwritten by the projector since we have no source-of-
      // truth for it any more.
      expect(bp!.modelId).toBe('derived');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('W3-1: projects ONLY chapter-level rows, ignoring volume/scene/beat, numbered 1..N', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      projectBlueprintFromOutline,
    } = await load();
    const novel = await createNovel({ userId: USER_ID, title: 'MixedProjection' });
    try {
      const now = new Date().toISOString();
      const volId = crypto.randomUUID();
      const ch1 = crypto.randomUUID();
      const ch2 = crypto.randomUUID();
      const sceneId = crypto.randomUUID();
      const beatId = crypto.randomUUID();
      await createKnowledgeEntry({
        id: volId, novelId: novel.id, type: 'outline', title: 'Volume One',
        summary: '', data: JSON.stringify({ level: 'volume', parentId: '' }),
        sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: ch1, novelId: novel.id, type: 'outline', title: 'Chapter One',
        summary: '', data: JSON.stringify({ chapterNumber: 1, level: 'chapter', parentId: volId, synopsis: 'first' }),
        sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: sceneId, novelId: novel.id, type: 'outline', title: 'A scene',
        summary: '', data: JSON.stringify({ level: 'scene', parentId: ch1 }),
        sortOrder: 2, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: beatId, novelId: novel.id, type: 'outline', title: 'A beat',
        summary: '', data: JSON.stringify({ level: 'beat', parentId: sceneId }),
        sortOrder: 3, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: ch2, novelId: novel.id, type: 'outline', title: 'Chapter Two',
        summary: '', data: JSON.stringify({ chapterNumber: 2, level: 'chapter', parentId: volId, synopsis: 'second' }),
        sortOrder: 4, tags: '[]', createdAt: now, updatedAt: now,
      });

      const bp = await projectBlueprintFromOutline(novel.id);
      expect(bp).not.toBeNull();
      // Only the two chapter rows project; volume/scene/beat are transparent.
      expect(bp!.chapters).toHaveLength(2);
      expect(bp!.chapters.map(c => c.title)).toEqual(['Chapter One', 'Chapter Two']);
      expect(bp!.chapters.map(c => c.chapterNumber)).toEqual([1, 2]);
      expect(bp!.chapters.map(c => c.summary)).toEqual(['first', 'second']);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('W3-1: a legacy single-level outline (no level key) projects exactly as before the migration', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      projectBlueprintFromOutline,
    } = await load();
    const novel = await createNovel({ userId: USER_ID, title: 'LegacyNoLevel' });
    try {
      const now = new Date().toISOString();
      // Rows WITHOUT a `level` key — the COALESCE guard must treat them as chapters.
      await createKnowledgeEntry({
        id: crypto.randomUUID(), novelId: novel.id, type: 'outline', title: 'Old A',
        summary: '', data: JSON.stringify({ chapterNumber: 1, synopsis: 'a' }),
        sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: crypto.randomUUID(), novelId: novel.id, type: 'outline', title: 'Old B',
        summary: '', data: JSON.stringify({ chapterNumber: 2, synopsis: 'b' }),
        sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
      });

      const bp = await projectBlueprintFromOutline(novel.id);
      expect(bp).not.toBeNull();
      expect(bp!.chapters.map(c => c.chapterNumber)).toEqual([1, 2]);
      expect(bp!.chapters.map(c => c.title)).toEqual(['Old A', 'Old B']);
      expect(bp!.chapters.map(c => c.summary)).toEqual(['a', 'b']);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('falls back to current outline rows when the knowledge_index mirror is partial', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      setNovelBlueprint,
      projectBlueprintFromOutline,
    } = await load();
    const { getDb } = await import('@/lib/db/connection');
    const { deleteKnowledgeIndexRow } = await import('@/lib/db/queries-vault');
    const novel = await createNovel({ userId: USER_ID, title: 'PartialIndex' });
    try {
      await setNovelBlueprint(novel.id, {
        chapters: [
          { chapterNumber: 1, title: 'One', summary: 's1' },
          { chapterNumber: 2, title: 'Two', summary: 's2' },
          { chapterNumber: 3, title: 'Three', summary: 's3' },
        ],
        targetWordsPerChapter: 1800,
        generatedAt: '2026-05-18T00:00:00.000Z',
        modelId: 'generated',
      });

      const indexedRows = getDb()
        .prepare("SELECT id FROM knowledge_index WHERE novel_id = ? AND type = 'outline' ORDER BY title ASC")
        .all(novel.id) as { id: string }[];
      expect(indexedRows).toHaveLength(3);
      await deleteKnowledgeIndexRow(indexedRows[0].id);

      const bp = await projectBlueprintFromOutline(novel.id);
      expect(bp).not.toBeNull();
      expect(bp!.chapters.map(c => c.title)).toEqual(['One', 'Two', 'Three']);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('falls back to fresher current outline rows when the knowledge_index mirror is stale', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      setNovelBlueprint,
      projectBlueprintFromOutline,
    } = await load();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'StaleIndex' });
    try {
      await setNovelBlueprint(novel.id, {
        chapters: [
          { chapterNumber: 1, title: 'Old One', summary: 'old s1' },
          { chapterNumber: 2, title: 'Two', summary: 's2' },
        ],
        targetWordsPerChapter: 1800,
        generatedAt: '2026-05-18T00:00:00.000Z',
        modelId: 'generated',
      });

      const outlineRows = getDb()
        .prepare("SELECT id FROM knowledge_entries WHERE novel_id = ? AND type = 'outline' ORDER BY sort_order ASC")
        .all(novel.id) as { id: string }[];
      expect(outlineRows).toHaveLength(2);

      getDb()
        .prepare(
          `UPDATE knowledge_entries
              SET title = ?,
                  data = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          'Fresh One',
          JSON.stringify({ chapterNumber: 1, synopsis: 'fresh s1', wordCountTarget: 2400 }),
          '2030-01-01T00:00:00.000Z',
          outlineRows[0].id,
        );

      const bp = await projectBlueprintFromOutline(novel.id);
      expect(bp).not.toBeNull();
      expect(bp!.chapters[0]).toMatchObject({
        chapterNumber: 1,
        title: 'Fresh One',
        summary: 'fresh s1',
      });
      expect(bp!.targetWordsPerChapter).toBe(2100);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});
