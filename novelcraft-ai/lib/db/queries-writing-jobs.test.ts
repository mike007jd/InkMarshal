// Phase 3 — writing_jobs run-history queries. Real SQLite (schema 0012) via the
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
    jobs.finalizeWritingJob(job.id, 'completed', 'full_done');
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
    jobs.finalizeWritingJob(job.id, 'failed', null, 'boom');
    const latest = jobs.getLatestWritingJob(novelId);
    expect(latest?.status).toBe('failed');
    expect(latest?.errorMessage).toBe('boom');
  });
});
