import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-snapshot-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('snapshot create route', () => {
  it('returns the existing snapshot without refreshing recency for duplicate content and label', async () => {
    const {
      createChapterSnapshot,
      createNovel,
      deleteNovelCascade,
      getNovel,
      listChapterSnapshots,
      upsertChapter,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Snapshot duplicate API' });
    const stale = '2000-01-01T00:00:00.000Z';

    try {
      await upsertChapter(novel.id, 1, 'One', 'stable body');
      const first = await createChapterSnapshot(novel.id, 1, 'checkpoint');
      expect(first).not.toBeNull();
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/chapters/1/snapshots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'checkpoint' }),
      }), { params: Promise.resolve({ id: novel.id, chapterNumber: '1' }) });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ snapshot: first });
      expect(await listChapterSnapshots(novel.id, 1)).toEqual([first]);
      expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not create a snapshot while another writing lock owns the novel', async () => {
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      listChapterSnapshots,
      releaseWritingLock,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Snapshot active lock API' });
    let token: string | null = null;

    try {
      await upsertChapter(novel.id, 1, 'One', 'locked snapshot body');
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/chapters/1/snapshots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'during writing' }),
      }), { params: Promise.resolve({ id: novel.id, chapterNumber: '1' }) });

      expect(response.status).toBe(409);
      expect(await listChapterSnapshots(novel.id, 1)).toEqual([]);
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
