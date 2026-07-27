'use client';

import type { Chapter, Novel } from '@/lib/db-types';
import {
  startWritingSession,
  type LiveWritingChapter,
  type WritingSessionCopy,
  type WritingSessionRunEvent,
  type StartWritingSessionOptions,
} from '@/lib/writing-session';
import { countWords } from '@/lib/utils';
import type { WritingRunEvent } from '@/lib/writing/writing-run-reducer';

type SessionRunner = typeof startWritingSession;

export interface WritingTransportStart {
  novelId: string;
  locale: string;
  copy: WritingSessionCopy;
  options?: StartWritingSessionOptions;
  initialState: {
    statusLabel: string;
    progress: number;
    completedChapters: number;
    totalChapters?: number;
  };
}

export interface WritingTransportCallbacks {
  onRunEvent(event: WritingRunEvent): void;
  patchNovel(patch: Partial<Novel>): void;
  replaceNovel(novel: Novel): void;
  appendLiveChapter(chunk: string): void;
  setLiveChapter(chapter: LiveWritingChapter | null): void;
  upsertChapter(chapter: Chapter): void;
  refreshDurableState(): Promise<void>;
}

export type WritingTransportOutcome =
  | { kind: 'settled'; runId: number }
  | { kind: 'paused'; runId: number; isLatestRun: boolean; partial: LiveWritingChapter | null }
  | { kind: 'cancelled'; runId: number }
  | { kind: 'failed'; runId: number; error: unknown; partial: LiveWritingChapter | null }
  | { kind: 'rejected'; runId: null };

interface TransportRun {
  id: number;
  controller: AbortController;
  callbacks: WritingTransportCallbacks;
  liveChapter: LiveWritingChapter | null;
  state: 'active' | 'paused' | 'cancelled';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Owns the mutable transport facts for one manuscript session. React owns the
 * rendered prose and the pure reducer owns lifecycle state; this controller is
 * the only place that decides whether a callback belongs to the active run, a
 * paused run's final prose flush, or an obsolete run.
 */
export class WritingTransportController {
  private readonly runSession: SessionRunner;
  private nextRunId = 0;
  private latestRunId = 0;
  private active: TransportRun | null = null;
  private paused: TransportRun | null = null;

  constructor(runSession: SessionRunner = startWritingSession) {
    this.runSession = runSession;
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  async start(
    input: WritingTransportStart,
    callbacks: WritingTransportCallbacks,
  ): Promise<WritingTransportOutcome> {
    if (this.active) return { kind: 'rejected', runId: null };

    const runId = ++this.nextRunId;
    this.latestRunId = runId;
    this.paused = null;
    const run: TransportRun = {
      id: runId,
      controller: new AbortController(),
      callbacks,
      liveChapter: null,
      state: 'active',
    };
    this.active = run;
    const startedAt = new Date().toISOString();
    callbacks.onRunEvent({
      type: 'run-started',
      runId,
      ...input.initialState,
      at: startedAt,
    });

    const isActive = () => this.active === run && run.state === 'active';
    const canApplyPausedProse = () =>
      run.state === 'paused'
      && this.paused === run
      && this.active === null
      && this.latestRunId === run.id;

    try {
      await this.runSession({
        novelId: input.novelId,
        locale: input.locale,
        copy: input.copy,
        options: input.options,
        signal: run.controller.signal,
        handlers: {
          patchNovel: patch => {
            if (isActive()) callbacks.patchNovel(patch);
          },
          replaceNovel: novel => {
            if (isActive()) callbacks.replaceNovel(novel);
          },
          appendLiveChapter: chunk => {
            if (!isActive() && !canApplyPausedProse()) return;
            if (run.liveChapter) {
              run.liveChapter = {
                ...run.liveChapter,
                content: run.liveChapter.content + chunk,
              };
            }
            callbacks.appendLiveChapter(chunk);
            if (isActive()) {
              callbacks.onRunEvent({
                type: 'live-prose-received',
                runId,
                wordCount: countWords(run.liveChapter?.content ?? ''),
                at: new Date().toISOString(),
              });
            }
          },
          setLiveChapter: chapter => {
            if (isActive()) {
              run.liveChapter = chapter ? { ...chapter } : null;
              callbacks.setLiveChapter(chapter);
              return;
            }
            if (!canApplyPausedProse() || !chapter) return;
            run.liveChapter ??= { ...chapter };
            callbacks.setLiveChapter(run.liveChapter);
          },
          upsertChapter: chapter => {
            if (!isActive()) return;
            run.liveChapter = null;
            callbacks.upsertChapter(chapter);
          },
          refreshChapters: async () => {
            if (isActive()) await callbacks.refreshDurableState();
          },
          onRunEvent: event => {
            if (!isActive()) return;
            callbacks.onRunEvent({ ...event, runId } as WritingRunEvent);
          },
        },
      });
      if (run.state === 'paused') {
        return {
          kind: 'paused',
          runId,
          isLatestRun: this.latestRunId === runId,
          partial: run.liveChapter,
        };
      }
      if (run.state === 'cancelled') return { kind: 'cancelled', runId };
      return { kind: 'settled', runId };
    } catch (error) {
      if (run.state === 'paused') {
        return {
          kind: 'paused',
          runId,
          isLatestRun: this.latestRunId === runId,
          partial: run.liveChapter,
        };
      }
      if (run.state === 'cancelled') return { kind: 'cancelled', runId };
      return {
        kind: 'failed',
        runId,
        error,
        partial: isAbortError(error) ? null : run.liveChapter,
      };
    } finally {
      if (this.active === run) this.active = null;
      if (this.paused === run) this.paused = null;
    }
  }

  pause(statusLabel: string): boolean {
    const run = this.active;
    if (!run) return false;
    run.state = 'paused';
    this.active = null;
    this.paused = run;
    run.callbacks.onRunEvent({
      type: 'paused',
      runId: run.id,
      statusLabel,
      at: new Date().toISOString(),
    });
    run.controller.abort();
    return true;
  }

  cancel(): void {
    const runs = [this.active, this.paused].filter(
      (run): run is TransportRun => run !== null,
    );
    this.latestRunId = ++this.nextRunId;
    this.active = null;
    this.paused = null;
    for (const run of runs) {
      run.state = 'cancelled';
      run.controller.abort();
    }
  }
}
