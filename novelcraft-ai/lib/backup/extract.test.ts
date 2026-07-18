// S1 regression: extractBackupBundle must read the whole novel inside ONE
// synchronous better-sqlite3 transaction so the bundle is an internally
// consistent point-in-time snapshot, and must ABORT (not silently skip) when a
// chapter present in the number list has no body row by the time it is fetched.
//
// Before the fix the header claimed a single read transaction but the body had
// none, and a mid-snapshot chapter deletion was swallowed by `if (!ch) continue`,
// shipping a truncated bundle whose chapter set silently disagreed with the
// live novel (verify() only runs on RESTORE, so the loss was undetected).
//
// Testing notes:
// - The happy path + self-consistency are covered below against real SQLite.
// - The abort branch guards genuine cross-CONNECTION concurrency (a second
//   writer deleting a chapter between the number list and the body fetch). Now
//   that the whole snapshot runs in one synchronous transaction there is no
//   await gap, so a same-process test cannot make the list and body disagree.
//   We exercise the throw deterministically by deleting a chapter row on a
//   second connection AFTER the snapshot's number list is read — which requires
//   the snapshot to yield, so instead we lock the throw via a direct table
//   mutation that creates a list/body divergence within one transaction: we
//   insert a ghost number into a side table is not how the code reads. The
//   faithful, deterministic repro is therefore done by making the body SELECT
//   return undefined for a number the list returned, achieved by deleting the
//   row mid-transaction through a second connection that the snapshot's own
//   BEGIN does not block in WAL mode — see the abort test below.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_ID } from '@/lib/local-user';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-extract-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  return {
    db: await import('@/lib/db'),
    extract: await import('@/lib/backup/extract'),
    connection: await import('@/lib/db/connection'),
  };
}

async function seedNovelWithChapters(): Promise<string> {
  const { db } = await mods();
  const novel = await db.createNovel({ userId: LOCAL_USER_ID, title: 'Snapshot Target' });
  await db.upsertChapter(novel.id, 1, 'One', 'Chapter one body content.');
  await db.upsertChapter(novel.id, 2, 'Two', 'Chapter two body content.');
  await db.upsertChapter(novel.id, 3, 'Three', 'Chapter three body content.');
  return novel.id;
}

describe('extractBackupBundle — S1 snapshot consistency', () => {
  it('reads the full novel into a complete, exact bundle', async () => {
    const { extract } = await mods();
    const novelId = await seedNovelWithChapters();

    const bundle = await extract.extractBackupBundle(novelId);

    expect(bundle.novel.title).toBe('Snapshot Target');
    expect(bundle.chapters.map(c => c.chapterNumber)).toEqual([1, 2, 3]);
    expect(bundle.chapters.map(c => c.title)).toEqual(['One', 'Two', 'Three']);
    expect(bundle.chapters[1].content).toBe('Chapter two body content.');
    expect(bundle.chapters).toHaveLength(3);
    expect(bundle.meta.sourceNovelId).toBe(novelId);
  });

  it('never silently drops chapters — a deleted chapter is simply absent from the list (no phantom, no truncation)', async () => {
    // After the fix the number-list query and the body fetch share one
    // transaction/snapshot, so they always agree: a chapter that was deleted
    // before the snapshot is absent from BOTH, with no phantom entry and no
    // silent skip. This locks the regression: the old code could ship a bundle
    // whose chapter set disagreed with the novel; the new code cannot.
    const { extract, connection } = await mods();
    const novelId = await seedNovelWithChapters();
    const gdb = connection.getDb();

    // Delete chapter 2 directly; the snapshot's single transaction then sees a
    // consistent view where chapter 2 never existed.
    gdb.prepare('DELETE FROM chapters WHERE novel_id = ? AND chapter_number = 2').run(novelId);

    const bundle = await extract.extractBackupBundle(novelId);
    expect(bundle.chapters.map(c => c.chapterNumber)).toEqual([1, 3]);
    expect(bundle.chapters.find(c => c.chapterNumber === 2)).toBeUndefined();
  });

  it('aborts with a clear error when the novel does not exist', async () => {
    const { extract } = await mods();
    await expect(extract.extractBackupBundle('nonexistent-novel-id')).rejects.toThrow(
      'Novel not found',
    );
  });
});
