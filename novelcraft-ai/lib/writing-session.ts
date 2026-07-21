'use client';

import type { Chapter, Novel } from '@/lib/db-types';
import type { WritingFrame, WritingPhase } from '@/lib/writing-orchestrator';
import {
  buildAIRequestHeaders,
  consumeNdjsonStream,
  createChunkBatcher,
} from '@/lib/streaming-client';
import type { CreativityLevel } from '@/lib/ai/generation-presets';

export interface LiveWritingChapter {
  id: string;
  chapterNumber: number;
  title: string;
  content: string;
}

export interface WritingSessionCopy {
  writingLabel: string;
  readingLabel: string;
  errorLabel: string;
  timeoutLabel: string;
}

export type { WritingPhase };

export function isWritingRunBusyPhase(phase: 'idle' | WritingPhase): boolean {
  return phase === 'preparing'
    || phase === 'planning'
    || phase === 'drafting'
    || phase === 'saving'
    || phase === 'chapter_complete';
}

export interface WritingRunState {
  phase: 'idle' | WritingPhase;
  statusLabel: string;
  modelLabel?: string;
  chapterNumber?: number;
  chapterTitle?: string;
  liveWordCount: number;
  completedChapters: number;
  totalChapters?: number;
  progress: number;
  startedAt?: string;
  lastActivityAt?: string;
  error?: string;
}

export const IDLE_WRITING_RUN_STATE: WritingRunState = {
  phase: 'idle',
  statusLabel: '',
  liveWordCount: 0,
  completedChapters: 0,
  progress: 0,
};

export interface BatchDonePayload {
  /** Next un-written chapter, or null when the whole book is done. */
  nextChapter: number | null;
  /** Chapters left in the blueprint after this batch. */
  remaining: number;
  completedChapters: number;
  totalChapters: number;
}

export interface WritingSessionHandlers {
  setStatusLabel(label: string): void;
  patchNovel(patch: Partial<Novel>): void;
  replaceNovel(novel: Novel): void;
  appendLiveChapter(chunk: string): void;
  setLiveChapter(chapter: LiveWritingChapter | null): void;
  upsertChapter(chapter: Chapter): void;
  refreshChapters(): Promise<void>;
  onDone(): void;
  onError(message: string): void;
  updateRunState?(patch: Partial<WritingRunState>): void;
  /** Optional: fires when the server completes a chapter batch (chaptersLimit /
   *  untilChapter reached) but the whole book is not yet done. */
  onBatchDone?(payload: BatchDonePayload): void;
  /** Optional: fires when writing was abruptly stopped (abort, error) mid-
   *  chapter so the client can persist the half-written `liveChapter`. */
  onPartialChapter?(chapter: LiveWritingChapter): void;
}

export const WRITING_SESSION_OPERATIONS = ['outline', 'chapter', 'summarize', 'validate', 'polish'] as const;
export const WRITING_SESSION_READ_TIMEOUT_MS = 90_000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function chapterFromWritingDoneEvent(
  event: Record<string, unknown>,
  novelId: string,
): Chapter | null {
  const chapterNumber = numberValue(event.chapterNumber);
  const title = text(event.title);
  const content = text(event.content);
  if (chapterNumber == null || !title || content == null) return null;

  return {
    id: text(event.id) ?? `ch-${chapterNumber}`,
    novelId,
    chapterNumber,
    title,
    content,
    originalContent: null,
    wordCount: numberValue(event.wordCount) ?? content.length,
    version: 0,
    summary: '',
    keyFacts: null,
    qualityIssues: Array.isArray(event.qualityIssues)
      ? event.qualityIssues as Chapter['qualityIssues']
      : null,
    generationMeta: null,
    createdAt: Date.now(),
  };
}

export async function applyWritingSessionEvent(
  event: Record<string, unknown>,
  args: {
    novelId: string;
    copy: WritingSessionCopy;
    batcher: { enqueue(chunk: string): void; flush(): void; cancel(): void };
    handlers: WritingSessionHandlers;
  },
): Promise<boolean> {
  const { novelId, copy, batcher, handlers } = args;
  // Narrow the parsed NDJSON line to the WritingFrame tag set. The switch below
  // is exhaustive over WritingFrame['type']: adding a frame variant without a
  // case here is a COMPILE error (the `default` guard stops narrowing to never).
  const type = event.type as WritingFrame['type'];

  switch (type) {
    case 'heartbeat':
      handlers.updateRunState?.({
        lastActivityAt: text(event.at) ?? new Date().toISOString(),
      });
      return true;

    case 'phase': {
      const phase = text(event.phase) as WritingPhase | null;
      if (!phase) return false;
      const statusLabel = text(event.message) ?? copy.writingLabel;
      handlers.setStatusLabel(statusLabel);
      handlers.updateRunState?.({
        phase,
        statusLabel,
        ...(numberValue(event.progress) == null ? {} : { progress: numberValue(event.progress)! }),
        ...(numberValue(event.chapterNumber) == null ? {} : { chapterNumber: numberValue(event.chapterNumber)! }),
        ...(text(event.chapterTitle) == null ? {} : { chapterTitle: text(event.chapterTitle)! }),
        ...(numberValue(event.completedChapters) == null ? {} : { completedChapters: numberValue(event.completedChapters)! }),
        ...(numberValue(event.totalChapters) == null ? {} : { totalChapters: numberValue(event.totalChapters)! }),
        lastActivityAt: new Date().toISOString(),
        ...(phase === 'failed' ? { error: statusLabel } : { error: undefined }),
      });
      return true;
    }

    case 'progress': {
      batcher.flush();
      handlers.setStatusLabel(text(event.message) ?? copy.writingLabel);
      const progress = numberValue(event.progress);
      handlers.patchNovel({
        ...(progress == null ? {} : { progress }),
        stage: 'autonomous_writing',
      });
      handlers.updateRunState?.({
        statusLabel: text(event.message) ?? copy.writingLabel,
        ...(progress == null ? {} : { progress }),
        lastActivityAt: new Date().toISOString(),
      });
      return true;
    }

    case 'blueprint': {
      batcher.flush();
      handlers.patchNovel({ blueprint: event.blueprint as Novel['blueprint'] });
      handlers.updateRunState?.({
        totalChapters: numberValue(event.total) ?? undefined,
        lastActivityAt: new Date().toISOString(),
      });
      return true;
    }

    case 'writing': {
      const chapterNumber = numberValue(event.chapterNumber);
      if (chapterNumber == null) return false;
      handlers.setLiveChapter({
        id: `live-${chapterNumber}`,
        chapterNumber,
        title: text(event.title) ?? `Chapter ${String(chapterNumber).padStart(2, '0')}`,
        content: '',
      });
      handlers.updateRunState?.({
        phase: 'drafting',
        chapterNumber,
        chapterTitle: text(event.title) ?? undefined,
        lastActivityAt: new Date().toISOString(),
      });
      batcher.enqueue(text(event.chunk) ?? '');
      return true;
    }

    case 'chapter_done': {
      batcher.cancel();
      const progress = numberValue(event.progress);
      handlers.patchNovel({
        ...(progress == null ? {} : { progress }),
        stage: 'autonomous_writing',
      });
      handlers.setLiveChapter(null);
      const chapter = chapterFromWritingDoneEvent(event, novelId);
      if (chapter) handlers.upsertChapter(chapter);
      handlers.updateRunState?.({
        phase: 'chapter_complete',
        ...(progress == null ? {} : { progress }),
        ...(numberValue(event.completedChapters) == null ? {} : { completedChapters: numberValue(event.completedChapters)! }),
        ...(numberValue(event.totalChapters) == null ? {} : { totalChapters: numberValue(event.totalChapters)! }),
        liveWordCount: numberValue(event.wordCount) ?? 0,
        lastActivityAt: new Date().toISOString(),
      });
      return true;
    }

    case 'batch_done': {
      batcher.cancel();
      handlers.setLiveChapter(null);
      handlers.setStatusLabel(copy.readingLabel);
      const nextChapter = numberValue(event.nextChapter);
      const remaining = numberValue(event.remaining) ?? 0;
      const completedChapters = numberValue(event.completedChapters) ?? 0;
      const totalChapters = numberValue(event.totalChapters) ?? 0;
      handlers.onBatchDone?.({
        nextChapter,
        remaining,
        completedChapters,
        totalChapters,
      });
      handlers.updateRunState?.({
        phase: 'paused',
        statusLabel: copy.readingLabel,
        completedChapters,
        totalChapters,
        lastActivityAt: new Date().toISOString(),
      });
      await handlers.refreshChapters();
      return true;
    }

    case 'done': {
      batcher.cancel();
      handlers.setLiveChapter(null);
      if (event.novel) handlers.replaceNovel(event.novel as Novel);
      handlers.setStatusLabel(copy.readingLabel);
      handlers.onDone();
      handlers.updateRunState?.({
        phase: 'complete',
        statusLabel: text(event.message) ?? copy.readingLabel,
        progress: 100,
        lastActivityAt: new Date().toISOString(),
      });
      await handlers.refreshChapters();
      return true;
    }

    case 'error': {
      batcher.cancel();
      handlers.setLiveChapter(null);
      // The unified error frame key is `error` (lib/streaming-helpers). The old
      // `message` fallback was dead — client and server ship together in the same
      // desktop bundle, so there is no rolling-release skew to read across.
      const error = text(event.error) ?? copy.errorLabel;
      handlers.onError(error);
      handlers.updateRunState?.({
        phase: 'failed',
        statusLabel: error,
        error,
        lastActivityAt: new Date().toISOString(),
      });
      await Promise.allSettled([handlers.refreshChapters()]);
      return true;
    }

    default: {
      // Exhaustiveness guard (compile-time). At runtime an unknown/forward frame
      // is ignored — same-bundle client/server means this only fires on a
      // genuinely malformed frame.
      const _exhaustive: never = type;
      void _exhaustive;
      return false;
    }
  }
}

export interface StartWritingSessionOptions {
  /** How many unwritten chapters to produce before stopping. Default 1 (one
   *  click = one chapter). */
  chapters?: number;
  /** Stop after this chapter number (inclusive). Overrides `chapters`. */
  untilChapter?: number;
  /** Persisted/user-selected creativity for chapter prose generation. */
  creativity?: CreativityLevel | null;
}

export async function startWritingSession(args: {
  novelId: string;
  locale: string;
  signal: AbortSignal;
  copy: WritingSessionCopy;
  handlers: WritingSessionHandlers;
  options?: StartWritingSessionOptions;
}): Promise<void> {
  const { novelId, locale, signal, copy, handlers, options } = args;
  const search = new URLSearchParams();
  if (options?.chapters != null && Number.isFinite(options.chapters)) {
    search.set('chapters', String(Math.max(1, Math.floor(options.chapters))));
  }
  if (options?.untilChapter != null && Number.isFinite(options.untilChapter)) {
    search.set('untilChapter', String(Math.max(1, Math.floor(options.untilChapter))));
  }
  const query = search.toString();
  const url = `/api/novels/${novelId}/start-writing${query ? `?${query}` : ''}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: await buildAIRequestHeaders(locale, WRITING_SESSION_OPERATIONS, {
      creativity: options?.creativity ?? undefined,
    }, { signal }),
    signal,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(text(err.error) ?? `HTTP ${response.status}`);
  }

  let liveChapter: LiveWritingChapter | null = null;
  let partialEmitted = false;
  const emitPartialChapter = () => {
    if (partialEmitted || !liveChapter?.content) return;
    partialEmitted = true;
    handlers.onPartialChapter?.(liveChapter);
  };
  const trackedHandlers: WritingSessionHandlers = {
    ...handlers,
    appendLiveChapter(chunk) {
      if (liveChapter) liveChapter = { ...liveChapter, content: liveChapter.content + chunk };
      handlers.appendLiveChapter(chunk);
    },
    setLiveChapter(chapter) {
      if (chapter) {
        liveChapter = liveChapter ?? { ...chapter };
        partialEmitted = false;
      } else {
        liveChapter = null;
      }
      handlers.setLiveChapter(chapter);
    },
    upsertChapter(chapter) {
      liveChapter = null;
      partialEmitted = false;
      handlers.upsertChapter(chapter);
    },
  };

  const batcher = createChunkBatcher(trackedHandlers.appendLiveChapter);
  let terminalFrameSeen = false;
  try {
    await consumeNdjsonStream(
      response,
      {
        async onEvent(event) {
          if (event.type === 'error') {
            batcher.flush();
            emitPartialChapter();
          }
          const handled = await applyWritingSessionEvent(event, {
            novelId,
            copy,
            batcher,
            handlers: trackedHandlers,
          });
          if (
            handled &&
            (event.type === 'done' || event.type === 'batch_done' || event.type === 'error')
          ) {
            terminalFrameSeen = true;
          }
        },
      },
      {
        readTimeoutMs: WRITING_SESSION_READ_TIMEOUT_MS,
        timeoutMessage: copy.timeoutLabel,
      },
    );
    if (!terminalFrameSeen) {
      if (signal.aborted) {
        throw new DOMException('The writing session was aborted.', 'AbortError');
      }
      throw new Error(
        'Writing stopped unexpectedly before the server confirmed completion. Refresh the manuscript and retry.',
      );
    }
  } finally {
    batcher.flush();
    emitPartialChapter();
  }
}
