// Extraction reads one novel in a single synchronous SQLite transaction so
// chapters and book-owned history share one snapshot. Missing novels fail
// explicitly; chapters deleted before extraction are absent.

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
    // History sections are always present (empty when the novel has none).
    expect(bundle.novel.volumeSummaries).toEqual([]);
    expect(bundle.conversations).toEqual([]);
    expect(bundle.messages).toEqual([]);
    expect(bundle.chapterChat).toEqual([]);
  });

  it('captures book-owned history rows inside the same snapshot transaction', async () => {
    const { db, extract } = await mods();
    const novelId = await seedNovelWithChapters();
    const now = new Date().toISOString();

    await db.appendVolumeSummary(novelId, { start: 1, end: 3, summary: 'Full span.' });
    const conv = await db.createConversation({
      id: crypto.randomUUID(),
      novelId,
      userId: LOCAL_USER_ID,
      topic: 'general',
      title: 'Snapshot thread',
      parentMessageId: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.addMessage(novelId, 'user', 'Hello from snapshot', conv.id);
    await db.addMessage(novelId, 'system', 'Orphan note', null);
    await db.addChatMessage(novelId, 2, {
      role: 'user',
      content: 'Chat note',
      status: 'pending',
    });

    const bundle = await extract.extractBackupBundle(novelId);
    expect(bundle.novel.volumeSummaries).toEqual([{ start: 1, end: 3, summary: 'Full span.' }]);
    expect(bundle.conversations).toHaveLength(1);
    expect(bundle.conversations[0].title).toBe('Snapshot thread');
    expect(bundle.messages).toHaveLength(2);
    expect(bundle.messages.some(m => m.conversationId == null)).toBe(true);
    expect(bundle.chapterChat).toHaveLength(1);
    expect(bundle.chapterChat[0].chapterNumber).toBe(2);
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
