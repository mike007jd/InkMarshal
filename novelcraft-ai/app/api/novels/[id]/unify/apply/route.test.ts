import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-unify-apply-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('unify apply route helpers', () => {
  it('keeps only known edit ids and deduplicates them', async () => {
    const { normalizeUnificationSelectionIds } = await import('./route');

    expect(normalizeUnificationSelectionIds(['e1', 'missing', 'e1', 12], ['e1', 'e2'], 'editIds')).toEqual({
      ids: ['e1'],
    });
  });

  it('rejects oversized selection arrays and oversized id strings', async () => {
    const {
      MAX_UNIFICATION_SELECTION_IDS,
      normalizeUnificationSelectionIds,
    } = await import('./route');
    const tooMany = Array.from({ length: MAX_UNIFICATION_SELECTION_IDS + 1 }, (_, index) => `e${index}`);
    expect(normalizeUnificationSelectionIds(tooMany, tooMany, 'editIds')).toEqual({
      error: 'editIds contains too many ids',
    });
    expect(normalizeUnificationSelectionIds(['x'.repeat(129)], ['x'.repeat(129)], 'skipIds')).toEqual({
      error: 'skipIds contains an invalid id',
    });
  });
});

describe('unify apply route mutation gates', () => {
  // S4a: applyAll and skipAll (and applyAll+skipIds / skipAll+editIds) are
  // mutually exclusive. Before the fix both flags were read independently with
  // no validation — a body {applyAll:true, skipAll:true} was accepted and skipAll
  // silently won downstream, masking a malformed request.
  it('rejects contradictory applyAll + skipAll with 400', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Apply contradict' });
    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/unify/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applyAll: true, skipAll: true }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(response.status).toBe(400);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects contradictory applyAll + skipIds with 400', async () => {
    const { createNovel, deleteNovelCascade, updateNovel } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Apply contradict ids' });
    try {
      await updateNovel(novel.id, {
        stage: 'whole_book_unification',
        unificationReport: {
          edits: [{ id: 'edit-1', chapterNumber: 1, original: 'a', replacement: 'b', rationale: 'r', severity: 'minor', applied: false }],
          summary: 'pending', generatedAt: new Date().toISOString(), modelId: 'test',
        },
      });
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/unify/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applyAll: true, skipIds: ['edit-1'] }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(response.status).toBe(400);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects contradictory skipAll + editIds with 400', async () => {
    const { createNovel, deleteNovelCascade, updateNovel } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Skip contradict ids' });
    try {
      await updateNovel(novel.id, {
        stage: 'whole_book_unification',
        unificationReport: {
          edits: [{ id: 'edit-1', chapterNumber: 1, original: 'a', replacement: 'b', rationale: 'r', severity: 'minor', applied: false }],
          summary: 'pending', generatedAt: new Date().toISOString(), modelId: 'test',
        },
      });
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/unify/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skipAll: true, editIds: ['edit-1'] }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(response.status).toBe(400);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('persists applied chapter edits, report status, and completed stage together', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      getChapter,
      getNovel,
      updateNovel,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Apply transaction' });

    try {
      await upsertChapter(novel.id, 1, 'One', 'alpha beta gamma');
      await updateNovel(novel.id, {
        stage: 'whole_book_unification',
        unificationReport: {
          edits: [{
            id: 'edit-1',
            chapterNumber: 1,
            original: 'beta',
            replacement: 'BETA',
            rationale: 'case',
            severity: 'minor',
            applied: false,
          }],
          summary: 'pending report',
          generatedAt: new Date().toISOString(),
          modelId: 'test',
        },
      });

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/unify/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applyAll: true }),
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(200);
      expect((await getChapter(novel.id, 1))!.content).toBe('alpha BETA gamma');
      const updatedNovel = await getNovel(novel.id);
      expect(updatedNovel!.stage).toBe('completed');
      expect(updatedNovel!.unificationReport!.edits[0].applied).toBe(true);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects stale report application outside the polishing/completed stages', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      getChapter,
      updateNovel,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Apply stage gate' });

    try {
      await upsertChapter(novel.id, 1, 'One', 'alpha beta gamma');
      await updateNovel(novel.id, {
        stage: 'autonomous_writing',
        unificationReport: {
          edits: [{
            id: 'edit-1',
            chapterNumber: 1,
            original: 'beta',
            replacement: 'BETA',
            rationale: 'case',
            severity: 'minor',
            applied: false,
          }],
          summary: 'stale report',
          generatedAt: new Date().toISOString(),
          modelId: 'test',
        },
      });

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/unify/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applyAll: true }),
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(409);
      expect((await getChapter(novel.id, 1))!.content).toBe('alpha beta gamma');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not apply edits while another writing lock owns the novel', async () => {
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      getChapter,
      releaseWritingLock,
      updateNovel,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Apply lock gate' });
    let token: string | null = null;

    try {
      await upsertChapter(novel.id, 1, 'One', 'alpha beta gamma');
      await updateNovel(novel.id, {
        stage: 'whole_book_unification',
        unificationReport: {
          edits: [{
            id: 'edit-1',
            chapterNumber: 1,
            original: 'beta',
            replacement: 'BETA',
            rationale: 'case',
            severity: 'minor',
            applied: false,
          }],
          summary: 'pending report',
          generatedAt: new Date().toISOString(),
          modelId: 'test',
        },
      });
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/unify/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ applyAll: true }),
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(409);
      expect((await getChapter(novel.id, 1))!.content).toBe('alpha beta gamma');
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
