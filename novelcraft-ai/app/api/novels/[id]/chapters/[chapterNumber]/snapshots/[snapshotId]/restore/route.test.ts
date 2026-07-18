import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-snapshot-restore-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('snapshot restore optimistic locking', () => {
  it('requires the client-loaded chapter version before restoring a snapshot', async () => {
    const {
      createChapterSnapshot,
      createNovel,
      deleteNovelCascade,
      getChapter,
      updateChapterContent,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Snapshot route lock' });

    try {
      await upsertChapter(novel.id, 1, 'One', 'snapshot body');
      const snapshot = await createChapterSnapshot(novel.id, 1, 'before edits');
      expect(snapshot).not.toBeNull();
      const loadedVersion = (await getChapter(novel.id, 1))!.version;

      await updateChapterContent(novel.id, 1, 'newer body', loadedVersion);

      const stale = await POST(new Request(
        `http://localhost/api/novels/${novel.id}/chapters/1/snapshots/${snapshot!.id}/restore`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: loadedVersion }),
        },
      ), {
        params: Promise.resolve({ id: novel.id, chapterNumber: '1', snapshotId: snapshot!.id }),
      });

      expect(stale.status).toBe(409);
      expect((await getChapter(novel.id, 1))!.content).toBe('newer body');

      const missingVersion = await POST(new Request(
        `http://localhost/api/novels/${novel.id}/chapters/1/snapshots/${snapshot!.id}/restore`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      ), {
        params: Promise.resolve({ id: novel.id, chapterNumber: '1', snapshotId: snapshot!.id }),
      });

      expect(missingVersion.status).toBe(400);
      expect((await getChapter(novel.id, 1))!.content).toBe('newer body');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not restore a snapshot while another writing lock owns the novel', async () => {
    const {
      acquireWritingLock,
      createChapterSnapshot,
      createNovel,
      deleteNovelCascade,
      getChapter,
      releaseWritingLock,
      updateChapterContent,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Snapshot active lock route' });
    let token: string | null = null;

    try {
      await upsertChapter(novel.id, 1, 'One', 'snapshot body');
      const snapshot = await createChapterSnapshot(novel.id, 1, 'before edits');
      const version = (await getChapter(novel.id, 1))!.version;
      await updateChapterContent(novel.id, 1, 'edited body', version);
      const editedVersion = (await getChapter(novel.id, 1))!.version;
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const res = await POST(new Request(
        `http://localhost/api/novels/${novel.id}/chapters/1/snapshots/${snapshot!.id}/restore`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: editedVersion }),
        },
      ), {
        params: Promise.resolve({ id: novel.id, chapterNumber: '1', snapshotId: snapshot!.id }),
      });

      expect(res.status).toBe(409);
      expect((await getChapter(novel.id, 1))!.content).toBe('edited body');
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
