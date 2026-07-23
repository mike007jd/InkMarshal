// Writing-job run-history queries against the current baseline SQLite schema via the
// temp-DATA_DIR + getDb pattern; server-only is stubbed under vitest.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_ID } from '@/lib/local-user';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-writingjobs-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  return {
    jobs: await import('@/lib/db/queries-writing-jobs'),
    db: await import('@/lib/db'),
  };
}

async function freshNovel(): Promise<string> {
  const { db } = await mods();
  const novel = await db.createNovel({ userId: LOCAL_USER_ID, title: 'WJ' });
  return novel.id;
}

describe('queries-writing-jobs', () => {
  it('creates a running job and reads it back as the latest', async () => {
    const { jobs } = await mods();
    const novelId = await freshNovel();
    const job = jobs.createWritingJob(novelId);
    expect(job.status).toBe('running');
    expect(jobs.getLatestWritingJob(novelId)?.id).toBe(job.id);
  });

  it('reclaims a crashed running job (no terminal write) on the next create', async () => {
    const { jobs } = await mods();
    const novelId = await freshNovel();
    jobs.createWritingJob(novelId); // crash: never finalized → left 'running'
    const fresh = jobs.createWritingJob(novelId);
    // No two running jobs survive: the crashed one is reclaimed, latest is fresh.
    expect(jobs.getLatestWritingJob(novelId)?.id).toBe(fresh.id);
    expect(jobs.getLatestWritingJob(novelId)?.status).toBe('running');
  });

  it('rolls back the reclaim when inserting the successor fails', async () => {
    const { jobs } = await mods();
    const { getDb } = await import('@/lib/db/connection');
    const novelId = await freshNovel();
    const crashed = jobs.createWritingJob(novelId);
    getDb().exec(`
      CREATE TRIGGER fail_writing_job_successor
      BEFORE INSERT ON writing_jobs
      BEGIN
        SELECT RAISE(ABORT, 'injected successor failure');
      END;
    `);

    expect(() => jobs.createWritingJob(novelId)).toThrow('injected successor failure');
    expect(jobs.getLatestWritingJob(novelId)).toMatchObject({
      id: crashed.id,
      status: 'running',
    });
    getDb().exec('DROP TRIGGER fail_writing_job_successor');
  });

  it('bumpProgress advances without changing status', async () => {
    const { jobs } = await mods();
    const novelId = await freshNovel();
    const job = jobs.createWritingJob(novelId);
    jobs.bumpWritingJobProgress(job.id, 3, 1);
    jobs.bumpWritingJobProgress(job.id, 4, 2);
    const latest = jobs.getLatestWritingJob(novelId);
    expect(latest?.status).toBe('running');
    expect(latest?.currentChapter).toBe(4);
    expect(latest?.completedInRun).toBe(2);
    expect(latest?.seq).toBe(2);
  });

  it('finalize is the terminal write and is not reclaimed by a later create', async () => {
    const { jobs } = await mods();
    const novelId = await freshNovel();
    const job = jobs.createWritingJob(novelId);
    jobs.finalizeWritingJob(job.id, novelId, 'completed', 'full_done');
    expect(jobs.getLatestWritingJob(novelId)?.status).toBe('completed');
    expect(jobs.getLatestWritingJob(novelId)?.endReason).toBe('full_done');
    // Only 'running' rows are reclaimed; a completed job stays completed.
    const next = jobs.createWritingJob(novelId);
    expect(jobs.getLatestWritingJob(novelId)?.id).toBe(next.id);
  });

  it('failed status carries the error message', async () => {
    const { jobs } = await mods();
    const novelId = await freshNovel();
    const job = jobs.createWritingJob(novelId);
    jobs.finalizeWritingJob(job.id, novelId, 'failed', null, 'boom');
    const latest = jobs.getLatestWritingJob(novelId);
    expect(latest?.status).toBe('failed');
    expect(latest?.errorMessage).toBe('boom');
  });

  it('rolls back the novel terminal patch when job finalization fails', async () => {
    const { jobs, db } = await mods();
    const { getDb } = await import('@/lib/db/connection');
    const novelId = await freshNovel();
    const job = jobs.createWritingJob(novelId);
    const before = await db.getNovel(novelId);
    getDb().exec(`
      CREATE TRIGGER fail_writing_job_terminal
      BEFORE UPDATE ON writing_jobs
      WHEN NEW.status != 'running'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal failure');
      END;
    `);

    expect(() => jobs.finalizeWritingJob(
      job.id,
      novelId,
      'failed',
      'error',
      'boom',
      { stage: 'autonomous_writing', progress: 42 },
    )).toThrow('injected terminal failure');
    expect(await db.getNovel(novelId)).toMatchObject({
      stage: before?.stage,
      progress: before?.progress,
    });
    expect(jobs.getLatestWritingJob(novelId)?.status).toBe('running');
    getDb().exec('DROP TRIGGER fail_writing_job_terminal');
  });
});
