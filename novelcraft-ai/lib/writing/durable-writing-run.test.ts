import { describe, expect, it } from 'vitest';

import type { Novel } from '@/lib/db-types';
import type { WritingJob } from '@/lib/db/queries-writing-jobs';
import { DurableWritingRunController } from '@/lib/writing/durable-writing-run';
import {
  IDLE_WRITING_RUN_STATE,
  type WritingRunState,
} from '@/lib/writing/writing-run-reducer';

const LABELS = { failed: 'Writing failed', paused: 'Writing paused', reading: 'Reading' };
const STARTED_AT = '2026-07-27T00:00:00.000Z';

function novel(overrides: Partial<Novel> = {}): Novel {
  return {
    id: 'novel-1',
    userId: 'local-user',
    title: 'Draft',
    genre: 'Fantasy',
    stage: 'autonomous_writing',
    progress: 45,
    blueprint: { chapters: [{ chapterNumber: 1 }, { chapterNumber: 2 }] },
    updatedAt: Date.parse('2026-07-27T00:02:00.000Z'),
    ...overrides,
  } as Novel;
}

function job(overrides: Partial<WritingJob> = {}): WritingJob {
  return {
    id: 'job-1',
    novelId: 'novel-1',
    status: 'failed',
    endReason: 'error',
    currentChapter: 2,
    completedInRun: 1,
    seq: 1,
    errorMessage: 'Provider failed',
    startedAt: STARTED_AT,
    updatedAt: '2026-07-27T00:03:00.000Z',
    ...overrides,
  };
}

describe('DurableWritingRunController read ownership', () => {
  it('rejects a read captured before a newer run starts', () => {
    const controller = new DurableWritingRunController('novel-1');
    controller.acceptJob(job());
    const stale = controller.captureRead();

    controller.invalidateForNewRun();

    expect(controller.canCommit(stale)).toBe(false);
    expect(controller.canCommit(controller.captureRead())).toBe(true);
  });

  it('rejects reads from the previously opened novel', () => {
    const controller = new DurableWritingRunController('novel-1');
    const stale = controller.captureRead();

    controller.resetScope('novel-2');

    expect(controller.canCommit(stale)).toBe(false);
  });
});

describe('DurableWritingRunController reconciliation', () => {
  it('does not let an invalidated failed job overwrite a newer run', () => {
    const controller = new DurableWritingRunController('novel-1');
    const failedJob = job();
    controller.acceptJob(failedJob);
    controller.invalidateForNewRun();

    expect(controller.resolve(
      { novel: novel(), chapterCount: 1, job: failedJob },
      IDLE_WRITING_RUN_STATE,
      LABELS,
    )).toMatchObject({ phase: 'paused' });
  });

  it('prefers completed novel truth over a stale failed job', () => {
    const controller = new DurableWritingRunController('novel-1');

    expect(controller.resolve(
      {
        novel: novel({ stage: 'whole_book_unification', progress: 100 }),
        chapterCount: 2,
        job: job(),
      },
      IDLE_WRITING_RUN_STATE,
      LABELS,
    )).toMatchObject({ phase: 'complete' });
  });

  it('restores the current durable failure after relaunch', () => {
    const controller = new DurableWritingRunController('novel-1');
    const failedJob = job();
    controller.acceptJob(failedJob);

    expect(controller.resolve(
      { novel: novel(), chapterCount: 1, job: failedJob },
      IDLE_WRITING_RUN_STATE,
      LABELS,
    )).toMatchObject({
      phase: 'failed',
      error: 'Provider failed',
      chapterNumber: 2,
    });
  });

  it('keeps a newer local pause over an older unrelated job failure', () => {
    const controller = new DurableWritingRunController('novel-1');
    const local: WritingRunState = {
      ...IDLE_WRITING_RUN_STATE,
      runId: 2,
      phase: 'paused',
      statusLabel: 'Paused',
      startedAt: '2026-07-27T00:10:00.000Z',
      lastActivityAt: '2026-07-27T00:11:00.000Z',
    };

    expect(controller.resolve(
      { novel: novel(), chapterCount: 1, job: job() },
      local,
      LABELS,
    )).toBeNull();
  });

  it('does not trust a failed job whose durable timestamp cannot be ordered', () => {
    const controller = new DurableWritingRunController('novel-1');
    const malformedJob = job({ updatedAt: 'not-a-timestamp' });
    controller.acceptJob(malformedJob);

    expect(controller.resolve(
      { novel: novel(), chapterCount: 1, job: malformedJob },
      IDLE_WRITING_RUN_STATE,
      LABELS,
    )).toMatchObject({ phase: 'paused' });
  });
});
