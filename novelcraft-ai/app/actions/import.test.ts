import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-import-action-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('importPlanToNovel merge dedupe fail-closed', () => {
  it('rejects a missing dedupe report before mutating chapters and leaves the target unchanged', async () => {
    const { createNovel, getChapters, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { importPlanToNovel } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'Merge target' });
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 1, 'Existing', 'Keep me', 2, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, now);

    try {
      await expect(importPlanToNovel({
        mode: 'merge',
        targetNovelId: novel.id,
        plan: {
          source: 'txt',
          filename: 'incoming.txt',
          novelTitle: 'Incoming',
          chapters: [
            { chapterNumber: 1, title: 'Incoming One', content: 'New body' },
            { chapterNumber: 2, title: 'Incoming Two', content: 'Another' },
          ],
        },
      })).rejects.toThrow(/explicit dedupe decision/);

      const chapters = await getChapters(novel.id);
      expect(chapters).toHaveLength(1);
      expect(chapters[0]).toMatchObject({
        chapterNumber: 1,
        title: 'Existing',
        content: 'Keep me',
      });
      expect(
        getDb().prepare('SELECT settings FROM novels WHERE id = ?').get(novel.id),
      ).toEqual({ settings: null });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects incomplete, duplicate, and out-of-plan decisions without writing chapters', async () => {
    const { createNovel, getChapters, deleteNovelCascade } = await import('@/lib/db');
    const { importPlanToNovel } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'Merge target 2' });
    const plan = {
      source: 'txt' as const,
      filename: 'incoming.txt',
      novelTitle: 'Incoming',
      chapters: [
        { chapterNumber: 1, title: 'One', content: 'A' },
        { chapterNumber: 2, title: 'Two', content: 'B' },
      ],
    };

    try {
      await expect(importPlanToNovel({
        mode: 'merge',
        targetNovelId: novel.id,
        plan,
        dedupeDecisions: [{
          chapterNumber: 1,
          action: 'append',
          matchedChapterNumber: null,
        }],
      })).rejects.toThrow(/explicit dedupe decision/);

      await expect(importPlanToNovel({
        mode: 'merge',
        targetNovelId: novel.id,
        plan,
        dedupeDecisions: [
          { chapterNumber: 1, action: 'append', matchedChapterNumber: null },
          { chapterNumber: 1, action: 'skip', matchedChapterNumber: null },
          { chapterNumber: 2, action: 'append', matchedChapterNumber: null },
        ],
      })).rejects.toThrow(/duplicate dedupe decisions/);

      await expect(importPlanToNovel({
        mode: 'merge',
        targetNovelId: novel.id,
        plan,
        dedupeDecisions: [
          { chapterNumber: 1, action: 'append', matchedChapterNumber: null },
          { chapterNumber: 2, action: 'append', matchedChapterNumber: null },
          { chapterNumber: 9, action: 'skip', matchedChapterNumber: null },
        ],
      })).rejects.toThrow(/outside the import plan/);

      expect(await getChapters(novel.id)).toEqual([]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('overwrites the matched existing chapter rather than the incoming chapter number', async () => {
    const { createNovel, getChapters, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { importPlanToNovel } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'Matched target' });
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 10, 'Shared title', 'Original body', 2, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, new Date().toISOString());

    try {
      await importPlanToNovel({
        mode: 'merge',
        targetNovelId: novel.id,
        plan: {
          source: 'txt',
          filename: 'incoming.txt',
          novelTitle: 'Incoming',
          chapters: [{
            chapterNumber: 1,
            title: 'Shared title',
            content: 'Replacement body',
          }],
        },
        dedupeDecisions: [{
          chapterNumber: 1,
          action: 'overwrite',
          matchedChapterNumber: 10,
        }],
      });

      expect(await getChapters(novel.id)).toEqual([
        expect.objectContaining({
          chapterNumber: 10,
          title: 'Shared title',
          content: 'Replacement body',
        }),
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects duplicate overwrite targets before mutating the target novel', async () => {
    const { createNovel, getChapters, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { importPlanToNovel } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'One target' });
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 10, 'Shared title', 'Original body', 2, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, new Date().toISOString());

    try {
      await expect(importPlanToNovel({
        mode: 'merge',
        targetNovelId: novel.id,
        plan: {
          source: 'txt',
          filename: 'incoming.txt',
          novelTitle: 'Incoming',
          chapters: [
            { chapterNumber: 1, title: 'Shared title', content: 'First replacement' },
            { chapterNumber: 2, title: 'Shared title', content: 'Second replacement' },
          ],
        },
        dedupeDecisions: [
          { chapterNumber: 1, action: 'overwrite', matchedChapterNumber: 10 },
          { chapterNumber: 2, action: 'overwrite', matchedChapterNumber: 10 },
        ],
      })).rejects.toThrow(/same target chapter twice/);

      expect(await getChapters(novel.id)).toEqual([
        expect.objectContaining({
          chapterNumber: 10,
          content: 'Original body',
        }),
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
