import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-chapter-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('chapter PATCH request validation', () => {
  it('rejects oversized content before writing the chapter row', async () => {
    const { createNovel, getChapter, upsertChapter } = await import('@/lib/db');
    const { MAX_CHAPTER_PATCH_CONTENT_CHARS, PATCH } = await import('@/app/api/novels/[id]/chapters/[chapterNumber]/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Chapter API' });
    await upsertChapter(novel.id, 1, 'One', 'small');

    const response = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/chapters/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(MAX_CHAPTER_PATCH_CONTENT_CHARS + 1), version: 0 }),
    }), { params: Promise.resolve({ id: novel.id, chapterNumber: '1' }) });

    expect(response.status).toBe(400);
    expect((await getChapter(novel.id, 1))?.content).toBe('small');
  });

  it('rejects malformed optimistic-lock versions instead of downgrading to unconditional write', async () => {
    const { createNovel, getChapter, upsertChapter } = await import('@/lib/db');
    const { PATCH } = await import('@/app/api/novels/[id]/chapters/[chapterNumber]/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Chapter Version API' });
    await upsertChapter(novel.id, 1, 'One', 'original');

    const response = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/chapters/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'overwritten', version: '0' }),
    }), { params: Promise.resolve({ id: novel.id, chapterNumber: '1' }) });

    expect(response.status).toBe(400);
    expect((await getChapter(novel.id, 1))?.content).toBe('original');
  });

  it('requires optimistic-lock version instead of accepting unconditional writes', async () => {
    const { createNovel, getChapter, upsertChapter, updateChapterContent } = await import('@/lib/db');
    const { PATCH } = await import('@/app/api/novels/[id]/chapters/[chapterNumber]/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Chapter Missing Version API' });
    await upsertChapter(novel.id, 1, 'One', 'original');
    const loadedVersion = (await getChapter(novel.id, 1))!.version;
    await updateChapterContent(novel.id, 1, 'newer edit', loadedVersion);

    const response = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/chapters/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'stale overwrite' }),
    }), { params: Promise.resolve({ id: novel.id, chapterNumber: '1' }) });

    expect(response.status).toBe(400);
    expect((await getChapter(novel.id, 1))?.content).toBe('newer edit');
  });

  it('does not bump version or novel recency when saving identical content', async () => {
    const { createNovel, deleteNovelCascade, getChapter, getNovel, upsertChapter } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { PATCH } = await import('@/app/api/novels/[id]/chapters/[chapterNumber]/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Chapter Same Content API' });
    const stale = '2000-01-01T00:00:00.000Z';

    try {
      await upsertChapter(novel.id, 1, 'One', 'stable content');
      const version = (await getChapter(novel.id, 1))!.version;
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);

      const response = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/chapters/1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'stable content', version }),
      }), { params: Promise.resolve({ id: novel.id, chapterNumber: '1' }) });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, version });
      expect((await getChapter(novel.id, 1))?.version).toBe(version);
      expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not patch chapter content while another writing lock owns the novel', async () => {
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      getChapter,
      releaseWritingLock,
      upsertChapter,
    } = await import('@/lib/db');
    const { PATCH } = await import('@/app/api/novels/[id]/chapters/[chapterNumber]/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Chapter active lock API' });
    let token: string | null = null;

    try {
      await upsertChapter(novel.id, 1, 'One', 'locked body');
      const version = (await getChapter(novel.id, 1))!.version;
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const response = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/chapters/1`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'manual overwrite', version }),
      }), { params: Promise.resolve({ id: novel.id, chapterNumber: '1' }) });

      expect(response.status).toBe(409);
      expect((await getChapter(novel.id, 1))?.content).toBe('locked body');
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
