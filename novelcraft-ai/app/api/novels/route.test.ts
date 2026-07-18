import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-novel-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('novel API request validation', () => {
  it('creates a blank novel and its first editable chapter atomically', async () => {
    const { POST } = await import('@/app/api/novels/route');
    const { deleteNovelCascade, getChapters, getMessages } = await import('@/lib/db');

    const response = await POST(new Request('http://localhost/api/novels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Blank Draft',
        creationMode: 'blank',
        firstChapterTitle: 'Chapter 1',
      }),
    }));
    const novel = await response.json() as { id: string };

    try {
      expect(response.status).toBe(201);
      expect(await getChapters(novel.id)).toEqual([
        expect.objectContaining({
          chapterNumber: 1,
          title: 'Chapter 1',
          content: '',
          wordCount: 0,
          version: 0,
        }),
      ]);
      expect(await getMessages(novel.id)).toHaveLength(0);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects incomplete or mixed blank-creation payloads without writing rows', async () => {
    const { POST } = await import('@/app/api/novels/route');
    const { getNovels } = await import('@/lib/db');
    const before = await getNovels('local-user');

    const missingChapter = await POST(new Request('http://localhost/api/novels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Incomplete Blank', creationMode: 'blank' }),
    }));
    const mixedMode = await POST(new Request('http://localhost/api/novels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Mixed Blank',
        creationMode: 'blank',
        firstChapterTitle: 'Chapter 1',
        openingAssistantMessage: 'This must not be accepted.',
      }),
    }));

    expect(missingChapter.status).toBe(400);
    expect(mixedMode.status).toBe(400);
    expect(await getNovels('local-user')).toHaveLength(before.length);
  });

  it('rolls back the novel if its blank first chapter cannot be inserted', async () => {
    const { createBlankNovel, getNovels } = await import('@/lib/db');

    await expect(createBlankNovel({
      userId: 'local-user',
      title: 'Blank Rollback Fixture',
      firstChapterTitle: null as unknown as string,
    })).rejects.toThrow();

    expect((await getNovels('local-user')).map(novel => novel.title))
      .not.toContain('Blank Rollback Fixture');
  });

  it('starts a blank manuscript in drafting rather than brainstorming', async () => {
    const { createBlankNovel, deleteNovelCascade } = await import('@/lib/db');
    const novel = await createBlankNovel({
      userId: 'local-user',
      title: 'Direct Draft',
      firstChapterTitle: 'Chapter 1',
    });
    try {
      expect(novel.stage).toBe('autonomous_writing');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('bounds create payloads before writing a novel row', async () => {
    const { POST } = await import('@/app/api/novels/route');
    const { getNovels } = await import('@/lib/db');

    const response = await POST(new Request('http://localhost/api/novels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201) }),
    }));

    expect(response.status).toBe(400);
    expect(await getNovels('local-user')).toHaveLength(0);
  });

  it('stores the first Agent prompt as the main thread opening message', async () => {
    const { POST } = await import('@/app/api/novels/route');
    const { deleteNovelCascade, getMessages, getNovel } = await import('@/lib/db');

    const response = await POST(new Request('http://localhost/api/novels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Moon Gate',
        genre: '',
        initialPrompt: 'A locked-room mystery begins inside an orbital monastery.',
      }),
    }));
    const novel = await response.json() as { id: string };

    try {
      expect(response.status).toBe(201);
      const messages = await getMessages(novel.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: 'A locked-room mystery begins inside an orbital monastery.',
        conversationId: null,
      });
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('stores the New Novel opening as an assistant seed message', async () => {
    const { POST } = await import('@/app/api/novels/route');
    const { deleteNovelCascade, getMessages } = await import('@/lib/db');

    const response = await POST(new Request('http://localhost/api/novels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Untitled Draft',
        genre: '',
        openingAssistantMessage: 'Tell me your genre, protagonist, world, conflict, references, and desired ending feeling.',
      }),
    }));
    const novel = await response.json() as { id: string };

    try {
      expect(response.status).toBe(201);
      const messages = await getMessages(novel.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'assistant',
        content: 'Tell me your genre, protagonist, world, conflict, references, and desired ending feeling.',
        conversationId: null,
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('keeps novel creation and the opening message in one transaction', async () => {
    const { createNovelWithOpeningMessage, getNovels } = await import('@/lib/db');

    await expect(createNovelWithOpeningMessage({
      userId: 'local-user',
      title: 'Rollback Fixture',
      openingMessage: null as unknown as string,
    })).rejects.toThrow();

    expect((await getNovels('local-user')).map(novel => novel.title)).not.toContain('Rollback Fixture');
  });

  it('bounds patch payloads before mutating novel metadata', async () => {
    const { createNovel, getNovel } = await import('@/lib/db');
    const { PATCH } = await import('@/app/api/novels/[id]/route');
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Bounded API Novel',
      genre: 'mystery',
      targetWords: 80_000,
    });

    const response = await PATCH(new Request(`http://localhost/api/novels/${novel.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetWords: 9_999_999 }),
    }), { params: Promise.resolve({ id: novel.id }) });

    expect(response.status).toBe(400);
    const after = await getNovel(novel.id);
    expect(after?.targetWords).toBe(80_000);
  });

  it('does not refresh recency for empty or same-value metadata patches', async () => {
    const { createNovel, deleteNovelCascade, getNovel } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { PATCH } = await import('@/app/api/novels/[id]/route');
    const novel = await createNovel({
      userId: 'local-user',
      title: 'No-op Patch Novel',
      genre: 'mystery',
      targetWords: 80_000,
    });
    const stale = '2000-01-01T00:00:00.000Z';

    try {
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      const empty = await PATCH(new Request(`http://localhost/api/novels/${novel.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(empty.status).toBe(200);
      expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));

      const same = await PATCH(new Request(`http://localhost/api/novels/${novel.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'No-op Patch Novel' }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(same.status).toBe(200);
      expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not delete a novel while another writing lock owns it', async () => {
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      getNovel,
      releaseWritingLock,
    } = await import('@/lib/db');
    const { DELETE } = await import('@/app/api/novels/[id]/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Locked Delete Novel' });
    let token: string | null = null;

    try {
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const response = await DELETE(new Request(`http://localhost/api/novels/${novel.id}`, {
        method: 'DELETE',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(409);
      expect(await getNovel(novel.id)).toBeDefined();
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
