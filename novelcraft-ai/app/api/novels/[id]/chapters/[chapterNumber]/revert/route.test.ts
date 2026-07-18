import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-revert-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('chapter revert optimistic locking', () => {
  it('uses a single atomic DB helper for content restore and original cleanup', () => {
    const routeSource = readFileSync(join(process.cwd(), 'app/api/novels/[id]/chapters/[chapterNumber]/revert/route.ts'), 'utf8');
    const dbSource = readFileSync(join(process.cwd(), 'lib/db/queries-chapter.ts'), 'utf8');

    expect(routeSource).toContain('revertChapterToOriginalContent(id, chapterNumber, expectedVersion)');
    expect(routeSource).not.toContain('clearOriginalContent');
    expect(dbSource).toContain('export async function revertChapterToOriginalContent');
    expect(dbSource).toContain('const tx = db.transaction(() => {');
    expect(dbSource).toContain('SET content = ?, word_count = ?, version = ?, original_content = NULL');
  });

  it('uses the client-loaded version instead of the current server version', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      getChapter,
      setOriginalContent,
      updateChapterContent,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Revert route lock' });

    try {
      await upsertChapter(novel.id, 1, 'One', 'loaded body');
      await setOriginalContent(novel.id, 1, 'first draft');
      const loadedVersion = (await getChapter(novel.id, 1))!.version;

      await updateChapterContent(novel.id, 1, 'newer body', loadedVersion);

      const stale = await POST(new Request(
        `http://localhost/api/novels/${novel.id}/chapters/1/revert`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: loadedVersion }),
        },
      ), {
        params: Promise.resolve({ id: novel.id, chapterNumber: '1' }),
      });

      expect(stale.status).toBe(409);
      expect((await getChapter(novel.id, 1))!.content).toBe('newer body');

      const malformed = await POST(new Request(
        `http://localhost/api/novels/${novel.id}/chapters/1/revert`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: '1' }),
        },
      ), {
        params: Promise.resolve({ id: novel.id, chapterNumber: '1' }),
      });

      expect(malformed.status).toBe(400);
      expect((await getChapter(novel.id, 1))!.content).toBe('newer body');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('allows reverting to an empty first draft', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      getChapter,
      setOriginalContent,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Empty revert route' });

    try {
      await upsertChapter(novel.id, 1, 'One', 'non-empty edits');
      await setOriginalContent(novel.id, 1, '');
      const loadedVersion = (await getChapter(novel.id, 1))!.version;

      const res = await POST(new Request(
        `http://localhost/api/novels/${novel.id}/chapters/1/revert`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: loadedVersion }),
        },
      ), {
        params: Promise.resolve({ id: novel.id, chapterNumber: '1' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { content: string; wordCount: number };
      expect(body.content).toBe('');
      expect(body.wordCount).toBe(0);
      expect((await getChapter(novel.id, 1))!.content).toBe('');
      expect((await getChapter(novel.id, 1))!.originalContent).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not revert while another writing lock owns the novel', async () => {
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      getChapter,
      releaseWritingLock,
      setOriginalContent,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Revert active lock route' });
    let token: string | null = null;

    try {
      await upsertChapter(novel.id, 1, 'One', 'edited body');
      await setOriginalContent(novel.id, 1, 'first draft');
      const version = (await getChapter(novel.id, 1))!.version;
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const res = await POST(new Request(
        `http://localhost/api/novels/${novel.id}/chapters/1/revert`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version }),
        },
      ), {
        params: Promise.resolve({ id: novel.id, chapterNumber: '1' }),
      });

      expect(res.status).toBe(409);
      expect((await getChapter(novel.id, 1))!.content).toBe('edited body');
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
