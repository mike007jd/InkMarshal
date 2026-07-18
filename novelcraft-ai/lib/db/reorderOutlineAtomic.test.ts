// Wave 2 commit D — reorderOutlineAtomic atomic reorder + chapterNumber sync.
//
// Verifies:
//   1. sort_order is rewritten to match `orderedEntryIds.indexOf(id)`.
//   2. When `syncChapterNumbers` is not explicitly false, `data.chapterNumber`
//      is also rewritten to `index+1` (the projected blueprint then matches).
//   3. When `syncChapterNumbers: false`, the underlying frontmatter
//      chapterNumber is preserved (manual "swap order only" path).
//   4. The chapters table is NOT touched (URL stability invariant).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-outline-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function db() {
  return import('@/lib/db');
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('reorderOutlineAtomic + chapterNumber sync', () => {
  it('rewrites sort_order AND data.chapterNumber when syncChapterNumbers (default true)', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
      getOutlineEntries,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'OS' });
    try {
      const now = new Date().toISOString();
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (let i = 0; i < 3; i++) {
        await createKnowledgeEntry({
          id: ids[i],
          novelId: novel.id,
          type: 'outline',
          title: `Chapter ${i + 1}`,
          summary: '',
          data: JSON.stringify({ chapterNumber: i + 1, synopsis: 's' + (i + 1) }),
          sortOrder: i,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
      }

      // Reorder [2, 0, 1] — moves ch.3 to front.
      await reorderOutlineAtomic(novel.id, [ids[2], ids[0], ids[1]]);

      const rows = await getOutlineEntries(novel.id);
      // sort_order is now 0..2 in id order ids[2], ids[0], ids[1]
      const byId = new Map(rows.map(r => [r.id, r]));
      expect(byId.get(ids[2])!.sort_order).toBe(0);
      expect(byId.get(ids[0])!.sort_order).toBe(1);
      expect(byId.get(ids[1])!.sort_order).toBe(2);

      // data.chapterNumber rewritten to index+1
      const data2 = JSON.parse(byId.get(ids[2])!.data) as Record<string, unknown>;
      const data0 = JSON.parse(byId.get(ids[0])!.data) as Record<string, unknown>;
      const data1 = JSON.parse(byId.get(ids[1])!.data) as Record<string, unknown>;
      expect(data2.chapterNumber).toBe(1);
      expect(data0.chapterNumber).toBe(2);
      expect(data1.chapterNumber).toBe(3);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('opt-out via syncChapterNumbers: false leaves data.chapterNumber untouched', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
      getOutlineEntries,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'OS2' });
    try {
      const now = new Date().toISOString();
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      await createKnowledgeEntry({
        id: ids[0], novelId: novel.id, type: 'outline', title: 'A',
        summary: '', data: JSON.stringify({ chapterNumber: 1 }),
        sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: ids[1], novelId: novel.id, type: 'outline', title: 'B',
        summary: '', data: JSON.stringify({ chapterNumber: 2 }),
        sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
      });

      await reorderOutlineAtomic(novel.id, [ids[1], ids[0]], { syncChapterNumbers: false });
      const rows = await getOutlineEntries(novel.id);
      const byId = new Map(rows.map(r => [r.id, r]));
      expect(byId.get(ids[1])!.sort_order).toBe(0);
      expect(byId.get(ids[0])!.sort_order).toBe(1);
      // chapterNumber preserved
      expect(JSON.parse(byId.get(ids[1])!.data).chapterNumber).toBe(2);
      expect(JSON.parse(byId.get(ids[0])!.data).chapterNumber).toBe(1);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('chapters table chapter_number is NOT modified (URL stability invariant)', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      upsertChapter,
      getChaptersLite,
      createKnowledgeEntry,
      reorderOutlineAtomic,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'StableUrl' });
    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'body1');
      await upsertChapter(novel.id, 2, 'Ch2', 'body2');
      await upsertChapter(novel.id, 3, 'Ch3', 'body3');

      const now = new Date().toISOString();
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (let i = 0; i < 3; i++) {
        await createKnowledgeEntry({
          id: ids[i], novelId: novel.id, type: 'outline', title: `Chapter ${i + 1}`,
          summary: '', data: JSON.stringify({ chapterNumber: i + 1 }),
          sortOrder: i, tags: '[]', createdAt: now, updatedAt: now,
        });
      }

      // Move ch.3 → ch.1 position (rewriting outline frontmatter chapterNumbers).
      await reorderOutlineAtomic(novel.id, [ids[2], ids[0], ids[1]]);

      const chapters = await getChaptersLite(novel.id);
      // chapter_number columns are still 1, 2, 3 (not renumbered).
      const numbers = chapters.map(c => c.chapterNumber).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3]);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('rejects incomplete reorder payloads without duplicating chapter numbers', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
      getOutlineEntries,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'PartialOrder' });
    try {
      const now = new Date().toISOString();
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (let i = 0; i < ids.length; i++) {
        await createKnowledgeEntry({
          id: ids[i],
          novelId: novel.id,
          type: 'outline',
          title: `Chapter ${i + 1}`,
          summary: '',
          data: JSON.stringify({ chapterNumber: i + 1 }),
          sortOrder: i,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
      }

      await expect(reorderOutlineAtomic(novel.id, [ids[2]])).rejects.toThrow('Invalid outline order');

      const rows = await getOutlineEntries(novel.id);
      const byId = new Map(rows.map(row => [row.id, row]));
      expect(ids.map(id => JSON.parse(byId.get(id)!.data).chapterNumber)).toEqual([1, 2, 3]);
      expect(ids.map(id => byId.get(id)!.sort_order)).toEqual([0, 1, 2]);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('rejects duplicate reorder payloads at the DB boundary', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
      getOutlineEntries,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'DuplicateOrder' });
    try {
      const now = new Date().toISOString();
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      for (let i = 0; i < ids.length; i++) {
        await createKnowledgeEntry({
          id: ids[i],
          novelId: novel.id,
          type: 'outline',
          title: `Chapter ${i + 1}`,
          summary: '',
          data: JSON.stringify({ chapterNumber: i + 1 }),
          sortOrder: i,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
      }

      await expect(reorderOutlineAtomic(novel.id, [ids[1], ids[1]])).rejects.toThrow('Invalid outline order');

      const rows = await getOutlineEntries(novel.id);
      const byId = new Map(rows.map(row => [row.id, row]));
      expect(ids.map(id => JSON.parse(byId.get(id)!.data).chapterNumber)).toEqual([1, 2]);
      expect(ids.map(id => byId.get(id)!.sort_order)).toEqual([0, 1]);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('rolls back outline rows when index mirror update fails', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
      getOutlineEntries,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    const { upsertKnowledgeIndexRow } = await import('@/lib/db/queries-vault');
    const novel = await createNovel({ userId: USER_ID, title: 'AtomicOutlineMirror' });
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      const now = new Date().toISOString();
      for (let i = 0; i < ids.length; i++) {
        await createKnowledgeEntry({
          id: ids[i],
          novelId: novel.id,
          type: 'outline',
          title: `Chapter ${i + 1}`,
          summary: '',
          data: JSON.stringify({ chapterNumber: i + 1, synopsis: `s${i + 1}` }),
          sortOrder: i,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
        await upsertKnowledgeIndexRow({
          id: ids[i],
          novelId: novel.id,
          type: 'outline',
          path: `outline/chapter-${i + 1}.md`,
          title: `Chapter ${i + 1}`,
          tags: '[]',
          aliases: '[]',
          importance: null,
          data: JSON.stringify({ chapterNumber: i + 1, synopsis: `s${i + 1}` }),
          outgoingLinks: '[]',
          contentHash: `hash-${i + 1}`,
          updatedAt: now,
        });
      }

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_outline_index_update
         BEFORE UPDATE ON knowledge_index
         WHEN OLD.id = '${ids[0]}'
         BEGIN
           SELECT RAISE(ABORT, 'forced outline index update failure');
         END`,
      ).run();

      await expect(reorderOutlineAtomic(novel.id, [ids[1], ids[0]])).rejects.toThrow(
        'forced outline index update failure',
      );

      const rows = await getOutlineEntries(novel.id);
      const byId = new Map(rows.map(row => [row.id, row]));
      expect(byId.get(ids[0])!.sort_order).toBe(0);
      expect(byId.get(ids[1])!.sort_order).toBe(1);
      expect(JSON.parse(byId.get(ids[0])!.data).chapterNumber).toBe(1);
      expect(JSON.parse(byId.get(ids[1])!.data).chapterNumber).toBe(2);
      expect((await getKnowledgeIndexById(ids[0]))?.data.chapterNumber).toBe(1);
      expect((await getKnowledgeIndexById(ids[1]))?.data.chapterNumber).toBe(2);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS temp.fail_outline_index_update').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('deleteChaptersFrom clears stale outline chapterId links in current rows and index mirror', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      upsertChapter,
      deleteChaptersFrom,
      getOutlineEntries,
      setNovelBlueprint,
    } = await db();
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    const novel = await createNovel({ userId: USER_ID, title: 'TailRegenerate' });
    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'body1');
      await upsertChapter(novel.id, 2, 'Ch2', 'body2');
      await upsertChapter(novel.id, 3, 'Ch3', 'body3');
      await setNovelBlueprint(novel.id, {
        chapters: [
          { chapterNumber: 1, title: 'Ch1', summary: 's1' },
          { chapterNumber: 2, title: 'Ch2', summary: 's2' },
          { chapterNumber: 3, title: 'Ch3', summary: 's3' },
        ],
        targetWordsPerChapter: 1000,
        generatedAt: '2026-05-22T00:00:00.000Z',
        modelId: 'test',
      });

      const before = await getOutlineEntries(novel.id);
      const chapter2Outline = before.find(row => JSON.parse(row.data).chapterNumber === 2)!;
      expect(JSON.parse(chapter2Outline.data).chapterId).toBeTruthy();
      expect((await getKnowledgeIndexById(chapter2Outline.id))?.data.chapterId).toBeTruthy();

      expect(await deleteChaptersFrom(novel.id, 2)).toBe(2);

      const after = await getOutlineEntries(novel.id);
      const byNumber = new Map(after.map(row => [JSON.parse(row.data).chapterNumber as number, row]));
      expect(JSON.parse(byNumber.get(1)!.data).chapterId).toBeTruthy();
      expect(JSON.parse(byNumber.get(2)!.data).chapterId).toBe('');
      expect(JSON.parse(byNumber.get(3)!.data).chapterId).toBe('');
      expect((await getKnowledgeIndexById(byNumber.get(2)!.id))?.data.chapterId).toBe('');
      expect((await getKnowledgeIndexById(byNumber.get(3)!.id))?.data.chapterId).toBe('');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('W3-1: cross-level reorder of a mixed tree never writes chapterNumber on scene/beat rows', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
      getOutlineEntries,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'MixedTree' });
    try {
      const now = new Date().toISOString();
      const chapterId = crypto.randomUUID();
      const sceneId = crypto.randomUUID();
      const beatId = crypto.randomUUID();
      // chapter with a real chapterNumber, plus a scene + beat under it.
      await createKnowledgeEntry({
        id: chapterId, novelId: novel.id, type: 'outline', title: 'Chapter 1',
        summary: '', data: JSON.stringify({ chapterNumber: 1, level: 'chapter', parentId: '' }),
        sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: sceneId, novelId: novel.id, type: 'outline', title: 'Scene A',
        summary: '', data: JSON.stringify({ level: 'scene', parentId: chapterId }),
        sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: beatId, novelId: novel.id, type: 'outline', title: 'Beat A',
        summary: '', data: JSON.stringify({ level: 'beat', parentId: sceneId }),
        sortOrder: 2, tags: '[]', createdAt: now, updatedAt: now,
      });

      // Reorder the scene + beat under the chapter (a subset reorder). The tree
      // has non-chapter rows, so the hierarchy path runs and chapterNumber is
      // never touched on any row.
      await reorderOutlineAtomic(novel.id, [beatId, sceneId]);

      const rows = await getOutlineEntries(novel.id);
      const byId = new Map(rows.map(r => [r.id, r]));
      // sort_order resequenced for the subset.
      expect(byId.get(beatId)!.sort_order).toBe(0);
      expect(byId.get(sceneId)!.sort_order).toBe(1);
      // scene/beat rows must NOT have gained a chapterNumber.
      expect(JSON.parse(byId.get(sceneId)!.data).chapterNumber).toBeUndefined();
      expect(JSON.parse(byId.get(beatId)!.data).chapterNumber).toBeUndefined();
      // the chapter row's stored chapterNumber is preserved as-is.
      expect(JSON.parse(byId.get(chapterId)!.data).chapterNumber).toBe(1);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('W3-1: subset reorder is accepted on a mixed tree (validation relaxed)', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
      getOutlineEntries,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'SubsetReorder' });
    try {
      const now = new Date().toISOString();
      const c1 = crypto.randomUUID();
      const c2 = crypto.randomUUID();
      const s1 = crypto.randomUUID();
      await createKnowledgeEntry({
        id: c1, novelId: novel.id, type: 'outline', title: 'C1',
        summary: '', data: JSON.stringify({ chapterNumber: 1, level: 'chapter', parentId: '' }),
        sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: c2, novelId: novel.id, type: 'outline', title: 'C2',
        summary: '', data: JSON.stringify({ chapterNumber: 2, level: 'chapter', parentId: '' }),
        sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
      });
      await createKnowledgeEntry({
        id: s1, novelId: novel.id, type: 'outline', title: 'S1',
        summary: '', data: JSON.stringify({ level: 'scene', parentId: c1 }),
        sortOrder: 2, tags: '[]', createdAt: now, updatedAt: now,
      });

      // Reorder only the two chapters — a strict-count check would reject this
      // (3 rows exist, 2 supplied), the relaxed subset check accepts it.
      await expect(reorderOutlineAtomic(novel.id, [c2, c1])).resolves.toBeUndefined();
      const rows = await getOutlineEntries(novel.id);
      const byId = new Map(rows.map(r => [r.id, r]));
      expect(byId.get(c2)!.sort_order).toBe(0);
      expect(byId.get(c1)!.sort_order).toBe(1);
      // chapterNumber NOT synced on the hierarchy path (display number is derived).
      expect(JSON.parse(byId.get(c1)!.data).chapterNumber).toBe(1);
      expect(JSON.parse(byId.get(c2)!.data).chapterNumber).toBe(2);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('W3-1: pure-chapter tree still rejects a partial reorder (legacy contract intact)', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'PureChapterStrict' });
    try {
      const now = new Date().toISOString();
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (let i = 0; i < ids.length; i++) {
        await createKnowledgeEntry({
          id: ids[i], novelId: novel.id, type: 'outline', title: `C${i + 1}`,
          summary: '', data: JSON.stringify({ chapterNumber: i + 1, level: 'chapter', parentId: '' }),
          sortOrder: i, tags: '[]', createdAt: now, updatedAt: now,
        });
      }
      // All-chapter, default path => strict full-permutation requirement holds.
      await expect(reorderOutlineAtomic(novel.id, [ids[2], ids[0]])).rejects.toThrow('Invalid outline order');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('outline projection and renumbering tolerate malformed outline data', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      reorderOutlineAtomic,
      getKnowledgeEntry,
      getOutlineEntries,
      getOutlineWithChapterStatus,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'MalformedOutlineData' });
    try {
      const now = new Date().toISOString();
      const brokenId = crypto.randomUUID();
      const validId = crypto.randomUUID();
      await createKnowledgeEntry({
        id: brokenId,
        novelId: novel.id,
        type: 'outline',
        title: 'Broken',
        summary: '',
        data: '{',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      await createKnowledgeEntry({
        id: validId,
        novelId: novel.id,
        type: 'outline',
        title: 'Valid',
        summary: '',
        data: JSON.stringify({ chapterNumber: 12 }),
        sortOrder: 1,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });

      expect((await getOutlineEntries(novel.id)).map(row => row.id)).toEqual([brokenId, validId]);
      expect((await getOutlineWithChapterStatus(novel.id)).map(row => row.id)).toEqual([brokenId, validId]);

      await reorderOutlineAtomic(novel.id, [validId, brokenId]);
      const healed = await getKnowledgeEntry(brokenId, novel.id);
      expect(JSON.parse(healed!.data).chapterNumber).toBe(2);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});
