import type { Novel } from '@/lib/db-types';
import type { WritingJob } from '@/lib/db/queries-writing-jobs';
import type {
  DurableWritingRunResolution,
  WritingRunState,
} from '@/lib/writing/writing-run-reducer';

export interface DurableReadToken {
  readonly novelId: string;
  readonly generation: number;
}

export interface DurableWritingLabels {
  failed: string;
  paused: string;
  reading: string;
}

export interface DurableWritingSnapshot {
  novel: Novel;
  chapterCount: number;
  job: WritingJob | null;
}

function timestamp(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/**
 * Owns durable-read identity. Callers can fetch in parallel, but only tokens
 * captured from the current novel/run generation may commit.
 */
export class DurableWritingRunController {
  private novelId: string;
  private generation = 0;
  private latestJobId: string | null = null;
  private readonly invalidatedJobIds = new Set<string>();

  constructor(novelId: string) {
    this.novelId = novelId;
  }

  resetScope(novelId: string): void {
    this.novelId = novelId;
    this.generation += 1;
    this.latestJobId = null;
    this.invalidatedJobIds.clear();
  }

  captureRead(): DurableReadToken {
    return { novelId: this.novelId, generation: this.generation };
  }

  canCommit(token: DurableReadToken): boolean {
    return token.novelId === this.novelId && token.generation === this.generation;
  }

  acceptJob(job: WritingJob | null): void {
    this.latestJobId = job?.id ?? null;
  }

  invalidateForNewRun(): void {
    if (this.latestJobId) this.invalidatedJobIds.add(this.latestJobId);
    this.latestJobId = null;
    this.generation += 1;
  }

  invalidateReads(): void {
    this.generation += 1;
  }

  resolve(
    snapshot: DurableWritingSnapshot,
    local: WritingRunState,
    labels: DurableWritingLabels,
  ): DurableWritingRunResolution | null {
    const { novel, chapterCount, job } = snapshot;
    const totalChapters = novel.blueprint?.chapters?.length ?? chapterCount;

    if (novel.stage === 'completed' || novel.stage === 'whole_book_unification') {
      return {
        phase: 'complete',
        statusLabel: labels.reading,
        completedChapters: chapterCount,
        totalChapters,
        at: typeof novel.updatedAt === 'number'
          ? new Date(novel.updatedAt).toISOString()
          : new Date().toISOString(),
      };
    }

    const novelActivity = timestamp(novel.updatedAt);
    const jobActivity = timestamp(job?.updatedAt);
    const jobIsNotOlderThanNovel =
      Number.isFinite(novelActivity)
      && Number.isFinite(jobActivity)
      && jobActivity >= novelActivity;
    const jobIsCurrentFailed =
      job?.status === 'failed'
      && !this.invalidatedJobIds.has(job.id)
      && jobIsNotOlderThanNovel
      && novel.stage === 'autonomous_writing';

    if (jobIsCurrentFailed && job) {
      if (local.phase === 'complete') return null;
      const localActivity = timestamp(local.lastActivityAt);
      const localStartedAt = timestamp(local.startedAt);
      const jobStartedAt = timestamp(job.startedAt);
      const jobCanBelongToCurrentRun =
        Number.isFinite(localStartedAt)
        && Number.isFinite(jobStartedAt)
        && jobStartedAt >= localStartedAt;
      if (
        local.phase === 'paused'
        && Number.isFinite(localActivity)
        && Number.isFinite(jobActivity)
        && localActivity > jobActivity
        && !jobCanBelongToCurrentRun
      ) {
        return null;
      }
      return {
        phase: 'failed',
        statusLabel: job.errorMessage || labels.failed,
        error: job.errorMessage || labels.failed,
        chapterNumber: job.currentChapter ?? undefined,
        completedChapters: chapterCount,
        totalChapters: novel.blueprint?.chapters?.length,
        progress: novel.progress,
        startedAt: job.startedAt,
        at: job.updatedAt,
      };
    }

    if (
      novel.stage === 'autonomous_writing'
      && local.phase !== 'complete'
      && local.phase !== 'failed'
    ) {
      return {
        phase: 'paused',
        statusLabel: labels.paused,
        progress: novel.progress,
        completedChapters: chapterCount,
        totalChapters: novel.blueprint?.chapters?.length,
        startedAt: local.startedAt ?? job?.startedAt,
        at: job?.updatedAt ?? local.lastActivityAt ?? new Date().toISOString(),
      };
    }

    return null;
  }
}
