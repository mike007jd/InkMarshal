import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-export-bundle-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('submission bundle export response headers', () => {
  it('returns private non-cacheable attachment headers for bundle downloads', async () => {
    const { createNovel, deleteNovelCascade, upsertChapter } = await import('@/lib/db');
    const { POST } = await import('@/app/api/novels/[id]/export-bundle/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Private Bundle' });

    try {
      await upsertChapter(novel.id, 1, 'One', 'plain ascii chapter text');

      const response = await POST(
        new Request(`http://localhost/api/novels/${novel.id}/export-bundle`, { method: 'POST' }),
        { params: Promise.resolve({ id: novel.id }) },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(response.headers.get('pragma')).toBe('no-cache');
      expect(response.headers.get('expires')).toBe('0');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-disposition')).toContain('attachment; filename=');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('builds a submission bundle even while a writing lock owns the novel (read-only)', async () => {
    // Read-only: the bundle export must not take the writing lock, so it still
    // succeeds while a background write/unify session holds it.
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      releaseWritingLock,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('@/app/api/novels/[id]/export-bundle/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Locked Bundle' });
    let token: string | null = null;

    try {
      await upsertChapter(novel.id, 1, 'One', 'plain ascii chapter text');
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const response = await POST(
        new Request(`http://localhost/api/novels/${novel.id}/export-bundle`, { method: 'POST' }),
        { params: Promise.resolve({ id: novel.id }) },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).not.toBeNull();
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
