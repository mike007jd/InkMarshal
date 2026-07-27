import { describe, expect, it } from 'vitest';

import {
  IDLE_WRITING_RUN_STATE,
  writingRunReducer,
  type WritingRunEvent,
  type WritingRunState,
} from '@/lib/writing/writing-run-reducer';

const AT = '2026-07-27T01:00:00.000Z';

function reduce(events: WritingRunEvent[]): WritingRunState {
  return events.reduce(writingRunReducer, IDLE_WRITING_RUN_STATE);
}

function started(runId = 1): WritingRunEvent {
  return {
    type: 'run-started',
    runId,
    statusLabel: 'Writing',
    progress: 5,
    completedChapters: 0,
    totalChapters: 3,
    at: AT,
  };
}

describe('writingRunReducer legal transitions', () => {
  it('moves one run through planning, drafting, saving, chapter completion and pause', () => {
    const state = reduce([
      started(),
      {
        type: 'phase-received',
        runId: 1,
        phase: 'planning',
        statusLabel: 'Planning',
        at: AT,
      },
      {
        type: 'chapter-started',
        runId: 1,
        chapterNumber: 1,
        chapterTitle: 'Arrival',
        at: AT,
      },
      { type: 'live-prose-received', runId: 1, wordCount: 420, at: AT },
      {
        type: 'phase-received',
        runId: 1,
        phase: 'saving',
        statusLabel: 'Saving',
        at: AT,
      },
      {
        type: 'chapter-completed',
        runId: 1,
        progress: 40,
        completedChapters: 1,
        totalChapters: 3,
        wordCount: 1_200,
        at: AT,
      },
      {
        type: 'batch-completed',
        runId: 1,
        statusLabel: 'Ready to continue',
        nextChapter: 2,
        remaining: 2,
        completedChapters: 1,
        totalChapters: 3,
        at: AT,
      },
    ]);

    expect(state).toMatchObject({
      runId: 1,
      phase: 'paused',
      chapterNumber: 1,
      chapterTitle: 'Arrival',
      liveWordCount: 1_200,
      completedChapters: 1,
      totalChapters: 3,
      progress: 40,
    });
  });

  it('accepts a retry with a newer identity and lets it reach completion', () => {
    const first = reduce([
      started(1),
      { type: 'failed', runId: 1, statusLabel: 'Failed', error: 'Failed', at: AT },
    ]);
    const retried = writingRunReducer(first, started(2));
    const completed = writingRunReducer(retried, {
      type: 'completed',
      runId: 2,
      statusLabel: 'Complete',
      at: AT,
    });

    expect(completed).toMatchObject({
      runId: 2,
      phase: 'complete',
      progress: 100,
      error: undefined,
    });
  });

  it('reconstructs terminal and resumable states from durable truth', () => {
    const failed = writingRunReducer(IDLE_WRITING_RUN_STATE, {
      type: 'durable-reconciled',
      resolution: {
        phase: 'failed',
        statusLabel: 'Provider failed',
        error: 'Provider failed',
        completedChapters: 2,
        totalChapters: 5,
        progress: 45,
        startedAt: AT,
        at: AT,
      },
    });
    const complete = writingRunReducer(failed, {
      type: 'durable-reconciled',
      resolution: {
        phase: 'complete',
        statusLabel: 'Reading',
        completedChapters: 5,
        totalChapters: 5,
        at: AT,
      },
    });

    expect(failed).toMatchObject({ phase: 'failed', error: 'Provider failed' });
    expect(complete).toMatchObject({ phase: 'complete', progress: 100, error: undefined });
  });
});

describe('writingRunReducer rejected transitions', () => {
  it('ignores callbacks from an older run after retry', () => {
    const retried = reduce([started(1), started(2)]);
    const lateFailure = writingRunReducer(retried, {
      type: 'failed',
      runId: 1,
      statusLabel: 'Old failure',
      error: 'Old failure',
      at: AT,
    });

    expect(lateFailure).toBe(retried);
  });

  it('does not allow an active phase to revive a paused or completed run', () => {
    const paused = reduce([
      started(),
      { type: 'paused', runId: 1, statusLabel: 'Paused', at: AT },
    ]);
    const revivedPause = writingRunReducer(paused, {
      type: 'phase-received',
      runId: 1,
      phase: 'drafting',
      statusLabel: 'Late drafting',
      at: AT,
    });
    const completed = reduce([
      started(2),
      { type: 'completed', runId: 2, statusLabel: 'Complete', at: AT },
    ]);
    const revivedComplete = writingRunReducer(completed, {
      type: 'phase-received',
      runId: 2,
      phase: 'drafting',
      statusLabel: 'Late drafting',
      at: AT,
    });

    expect(revivedPause).toBe(paused);
    expect(revivedComplete).toBe(completed);
  });

  it('does not let a durable pause or failure demote local completion', () => {
    const complete = reduce([
      started(),
      { type: 'completed', runId: 1, statusLabel: 'Complete', at: AT },
    ]);
    const durablePause = writingRunReducer(complete, {
      type: 'durable-reconciled',
      resolution: {
        phase: 'paused',
        statusLabel: 'Paused',
        completedChapters: 2,
        totalChapters: 3,
        progress: 70,
        at: AT,
      },
    });
    const durableFailure = writingRunReducer(complete, {
      type: 'durable-reconciled',
      resolution: {
        phase: 'failed',
        statusLabel: 'Old failure',
        error: 'Old failure',
        completedChapters: 2,
        progress: 70,
        startedAt: AT,
        at: AT,
      },
    });

    expect(durablePause).toBe(complete);
    expect(durableFailure).toBe(complete);
  });
});
