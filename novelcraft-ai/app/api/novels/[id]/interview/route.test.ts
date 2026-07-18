import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('server-only', () => ({}));

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-interview-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('interview API stage boundary', () => {
  it('re-checks the novel stage immediately before mutating interview state', () => {
    const source = readFileSync('app/api/novels/[id]/interview/route.ts', 'utf8');

    // DELETE: lock → recheck → atomic transactional write.
    const deleteLockIndex = source.indexOf('const lock = await acquireWritingLock(id, LOCK_TTL_SEC);');
    const deleteRecheckIndex = source.indexOf('const lockedNovel = await getNovel(id);', deleteLockIndex);
    const deleteTxIndex = source.indexOf('db.transaction(() => {', deleteRecheckIndex);
    expect(deleteLockIndex).toBeGreaterThanOrEqual(0);
    expect(deleteRecheckIndex).toBeGreaterThan(deleteLockIndex);
    expect(deleteTxIndex).toBeGreaterThan(deleteRecheckIndex);

    // GET: get-existing → recheck → single lazy save (no paired write).
    const getExistingIndex = source.indexOf('const existing = await getInterviewState(id);');
    const getRecheckIndex = source.indexOf('const freshNovel = await getNovel(id);', getExistingIndex);
    const getSaveIndex = source.indexOf('await saveInterviewState(id, fresh);', getRecheckIndex);
    expect(getRecheckIndex).toBeGreaterThan(getExistingIndex);
    expect(getSaveIndex).toBeGreaterThan(getRecheckIndex);

    // POST: lock → recheck → atomic transactional write (interviewState + stage
    // advanced together so a crash can't desynchronize them).
    const postLockIndex = source.indexOf('const lock = await acquireWritingLock(id, LOCK_TTL_SEC);', deleteLockIndex + 1);
    const postRecheckIndex = source.indexOf('const lockedNovel = await getNovel(id);', deleteRecheckIndex + 1);
    const postTxIndex = source.indexOf('db.transaction(() => {', deleteTxIndex + 1);
    expect(postLockIndex).toBeGreaterThan(deleteLockIndex);
    expect(postRecheckIndex).toBeGreaterThan(postLockIndex);
    expect(postTxIndex).toBeGreaterThan(postRecheckIndex);
  });

  it('does not reset a novel back to discovery after writing has started', async () => {
    const { createNovel, deleteNovelCascade, getNovel, updateNovel } = await import('@/lib/db');
    const { DELETE } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Interview reset gate' });

    try {
      await updateNovel(novel.id, {
        stage: 'autonomous_writing',
        progress: 42,
        storySummary: 'already writing',
      });

      const response = await DELETE(new Request(`http://localhost/api/novels/${novel.id}/interview`, {
        method: 'DELETE',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(409);
      const after = await getNovel(novel.id);
      expect(after?.stage).toBe('autonomous_writing');
      expect(after?.progress).toBe(42);
      expect(after?.storySummary).toBe('already writing');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not create or advance interview state after writing has started', async () => {
    const { createNovel, deleteNovelCascade, getNovel, updateNovel } = await import('@/lib/db');
    const { GET, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Interview post gate' });

    try {
      await updateNovel(novel.id, { stage: 'whole_book_unification', progress: 100 });

      const getResponse = await GET(new Request(`http://localhost/api/novels/${novel.id}/interview`), {
        params: Promise.resolve({ id: novel.id }),
      });
      expect(getResponse.status).toBe(409);

      const postResponse = await POST(new Request(`http://localhost/api/novels/${novel.id}/interview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedOptionId: 'readiness-complete' }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(postResponse.status).toBe(409);

      const after = await getNovel(novel.id);
      expect(after?.stage).toBe('whole_book_unification');
      expect(after?.interviewState).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not reset or advance interview state while the novel writing lock is held', async () => {
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      getNovel,
      releaseWritingLock,
      updateNovel,
    } = await import('@/lib/db');
    const { getInterviewState } = await import('@/lib/interview-state-server');
    const { DELETE, GET, POST } = await import('./route');
    const novel = await createNovel({ userId: 'local-user', title: 'Interview active lock gate' });
    let token: string | null = null;

    try {
      const initial = await GET(new Request(`http://localhost/api/novels/${novel.id}/interview?lang=en`), {
        params: Promise.resolve({ id: novel.id }),
      });
      expect(initial.status).toBe(200);
      const initialState = await getInterviewState(novel.id);
      expect(initialState?.currentQuestionId).toBe('readiness');

      await updateNovel(novel.id, { stage: 'ready_for_greenlight', progress: 0 });
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const reset = await DELETE(new Request(`http://localhost/api/novels/${novel.id}/interview?lang=en`, {
        method: 'DELETE',
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(reset.status).toBe(409);

      const advance = await POST(new Request(`http://localhost/api/novels/${novel.id}/interview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'en', selectedOptionId: 'readiness-complete' }),
      }), { params: Promise.resolve({ id: novel.id }) });
      expect(advance.status).toBe(409);

      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect((await getInterviewState(novel.id))?.currentQuestionId).toBe('readiness');
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  // S2a: advancing interview state to proposal_review must update interviewState
  // AND the novel stage atomically — a crash between the two writes used to leave
  // interviewState advanced while the novel stage stayed discovery_interview.
  it('rolls back interviewState when the paired novel stage-advance fails (atomic)', async () => {
    const { createNovel, deleteNovelCascade, getNovel } = await import('@/lib/db');
    const { getInterviewState, saveInterviewState } = await import('@/lib/interview-state-server');
    const { getDb } = await import('@/lib/db/connection');
    const { POST } = await import('./route');
    const { toInterviewState } = await import('@/lib/interview-state');
    const novel = await createNovel({ userId: 'local-user', title: 'Interview atomic advance' });
    const gdb = getDb();

    try {
      // Seed a COMPLETE interview profile directly into proposal_review so the
      // next POST exercises the stage-advance branch (filling all slots via the
      // real multi-step interview is brittle; presetting the terminal state is
      // the deterministic way to reach the paired-write path). Every slot in
      // INTERVIEW_SLOT_ORDER must have a key so getRemainingSlots returns [].
      const fullProfile: Record<string, string> = {
        readiness: 'yes', length: '80000', genre: 'fantasy', reference: 'none',
        pov: 'first', setting: 'city', protagonist: 'hero', relationship: 'rival',
        worldbuilding: 'magic', conflict: 'war', ending: 'happy', readerFeeling: 'hope',
      };
      const proposalState = toInterviewState({
        mode: 'proposal_review',
        currentQuestionId: null,
        currentQuestion: null,
        currentHelperText: null,
        currentOptions: [],
        recommendedOptionId: null,
        slotTarget: null,
        missingFields: [],
        collectedProfile: fullProfile,
        proposalSummary: 'summary',
        proposalVersion: 1,
        interviewStage: 'proposal_review',
        stageProgress: { current: 12, total: 12 },
      });
      await saveInterviewState(novel.id, proposalState);
      const beforeState = await getInterviewState(novel.id);
      expect(beforeState?.mode).toBe('proposal_review');

      // Force the stage UPDATE to fail mid-transaction. The interviewState
      // UPDATE runs first; without atomicity it would persist while the stage
      // UPDATE aborts — desynchronizing interviewState and stage.
      gdb.prepare(
        `CREATE TEMP TRIGGER fail_stage_advance
         BEFORE UPDATE ON novels
         WHEN NEW.stage = 'ready_for_greenlight'
         BEGIN
           SELECT RAISE(ABORT, 'forced stage advance failure');
         END`,
      ).run();

      await expect(
        POST(new Request(`http://localhost/api/novels/${novel.id}/interview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ language: 'en', selectedOptionId: 'readiness-complete' }),
        }), { params: Promise.resolve({ id: novel.id }) }),
      ).rejects.toThrow('forced stage advance failure');

      // Both writes ran in one transaction, so the interviewState UPDATE rolled
      // back with the failed stage UPDATE — the proposalVersion must NOT have
      // advanced past the pre-call value, and the stage stays discovery_interview.
      const novelAfter = await getNovel(novel.id);
      expect(novelAfter?.stage).toBe('discovery_interview');
      const stateAfter = await getInterviewState(novel.id);
      expect(stateAfter?.proposalVersion).toBe(beforeState?.proposalVersion);
    } finally {
      gdb.prepare('DROP TRIGGER IF EXISTS temp.fail_stage_advance').run();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
