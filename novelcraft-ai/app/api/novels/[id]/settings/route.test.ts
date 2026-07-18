import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-settings-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('novel settings API request validation', () => {
  it('rejects non-object JSON before merging settings', async () => {
    const { createNovel, getNovel, deleteNovelCascade } = await import('@/lib/db');
    const { PATCH } = await import('@/app/api/novels/[id]/settings/route');

    const novel = await createNovel({ userId: 'local-user', title: 'Settings API' });
    try {
      const response = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify('wild'),
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'settings body must be an object' });
      expect((await getNovel(novel.id))?.settings).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('persists only supported creativity values', async () => {
    const { createNovel, getNovel, deleteNovelCascade } = await import('@/lib/db');
    const { PATCH } = await import('@/app/api/novels/[id]/settings/route');

    const novel = await createNovel({ userId: 'local-user', title: 'Settings API values' });
    try {
      const bad = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creativity: 'feral' }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(bad.status).toBe(400);
      expect((await getNovel(novel.id))?.settings).toBeNull();

      const good = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creativity: 'wild' }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ settings: { creativity: 'wild' } });
      expect((await getNovel(novel.id))?.settings).toEqual({ creativity: 'wild' });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not refresh recency for empty or same-value settings patches', async () => {
    const { createNovel, getNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { PATCH } = await import('@/app/api/novels/[id]/settings/route');

    const novel = await createNovel({ userId: 'local-user', title: 'Settings API no-op' });
    const stale = '2000-01-01T00:00:00.000Z';
    try {
      getDb().prepare('UPDATE novels SET settings = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify({ creativity: 'wild' }), stale, novel.id);

      const empty = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ settings: { creativity: 'wild' } });
      expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));

      const same = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creativity: 'wild' }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(same.status).toBe(200);
      expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects unsupported settings fields instead of silently treating them as no-op writes', async () => {
    const { createNovel, getNovel, deleteNovelCascade } = await import('@/lib/db');
    const { PATCH } = await import('@/app/api/novels/[id]/settings/route');

    const novel = await createNovel({ userId: 'local-user', title: 'Settings API unknown' });
    try {
      const response = await PATCH(new Request(`http://localhost/api/novels/${novel.id}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unknown: true }),
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'unsupported settings field' });
      expect((await getNovel(novel.id))?.settings).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});

// B10: a server-side write failure (DB locked / disk full) must surface as 500,
// not 400 — a 400 implies a client error and misleads clients into retrying the
// same body. Source-shape guard covers both settings + project-goals routes.
describe('novel settings + project-goals error status (B10)', () => {
  it('returns 500 (not 400) for a non-validation server failure', async () => {
    const { readFileSync } = await import('node:fs');
    const settings = readFileSync('app/api/novels/[id]/settings/route.ts', 'utf8');
    const goals = readFileSync('app/api/novels/[id]/project-goals/route.ts', 'utf8');
    // The non-ZodError catch must use status 500.
    expect(settings).toMatch(/status:\s*500/);
    expect(goals).toMatch(/status:\s*500/);
    // And must NOT still label a server failure as 400 in the generic catch.
    expect(settings).not.toMatch(/Failed to update settings[\s\S]*status:\s*400/);
    expect(goals).not.toMatch(/Failed to update project goals[\s\S]*status:\s*400/);
  });
});
