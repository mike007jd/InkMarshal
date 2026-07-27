import type { WritingPhase } from '@/lib/writing-orchestrator';

export interface WritingRunState {
  runId: number | null;
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
  runId: null,
  phase: 'idle',
  statusLabel: '',
  liveWordCount: 0,
  completedChapters: 0,
  progress: 0,
};

export type DurableWritingRunResolution =
  | {
      phase: 'complete';
      statusLabel: string;
      completedChapters: number;
      totalChapters: number;
      at: string;
    }
  | {
      phase: 'failed';
      statusLabel: string;
      error: string;
      chapterNumber?: number;
      completedChapters: number;
      totalChapters?: number;
      progress: number;
      startedAt: string;
      at: string;
    }
  | {
      phase: 'paused';
      statusLabel: string;
      completedChapters: number;
      totalChapters?: number;
      progress: number;
      startedAt?: string;
      at: string;
    };

export type WritingRunEvent =
  | {
      type: 'run-started';
      runId: number;
      statusLabel: string;
      progress: number;
      completedChapters: number;
      totalChapters?: number;
      at: string;
    }
  | { type: 'activity-received'; runId: number; at: string }
  | {
      type: 'phase-received';
      runId: number;
      phase: WritingPhase;
      statusLabel: string;
      progress?: number;
      chapterNumber?: number;
      chapterTitle?: string;
      completedChapters?: number;
      totalChapters?: number;
      at: string;
    }
  | {
      type: 'progress-received';
      runId: number;
      statusLabel: string;
      progress?: number;
      at: string;
    }
  | { type: 'blueprint-received'; runId: number; totalChapters?: number; at: string }
  | {
      type: 'chapter-started';
      runId: number;
      chapterNumber: number;
      chapterTitle?: string;
      at: string;
    }
  | { type: 'live-prose-received'; runId: number; wordCount: number; at: string }
  | {
      type: 'chapter-completed';
      runId: number;
      progress?: number;
      completedChapters?: number;
      totalChapters?: number;
      wordCount: number;
      at: string;
    }
  | {
      type: 'batch-completed';
      runId: number;
      statusLabel: string;
      nextChapter: number | null;
      remaining: number;
      completedChapters: number;
      totalChapters: number;
      at: string;
    }
  | { type: 'completed'; runId: number; statusLabel: string; at: string }
  | { type: 'failed'; runId: number; statusLabel: string; error: string; at: string }
  | { type: 'paused'; runId: number; statusLabel: string; at: string }
  | { type: 'gate-cancelled'; runId: number }
  | { type: 'durable-reconciled'; resolution: DurableWritingRunResolution }
  | { type: 'scope-reset' };

const ALLOWED_PHASE_TRANSITIONS: Record<WritingPhase, ReadonlySet<WritingPhase>> = {
  preparing: new Set(['preparing', 'planning', 'drafting', 'paused', 'failed', 'complete']),
  planning: new Set(['planning', 'drafting', 'saving', 'paused', 'failed', 'complete']),
  drafting: new Set([
    'drafting',
    'saving',
    'chapter_complete',
    'paused',
    'failed',
    'complete',
  ]),
  saving: new Set(['saving', 'chapter_complete', 'paused', 'failed', 'complete']),
  chapter_complete: new Set([
    'chapter_complete',
    'planning',
    'drafting',
    'saving',
    'paused',
    'failed',
    'complete',
  ]),
  paused: new Set(['paused']),
  failed: new Set(['failed']),
  complete: new Set(['complete']),
};

function acceptsRunEvent(state: WritingRunState, runId: number): boolean {
  return state.runId === runId && state.phase !== 'idle';
}

function acceptsPhase(state: WritingRunState, runId: number, next: WritingPhase): boolean {
  return acceptsRunEvent(state, runId)
    && state.phase !== 'idle'
    && ALLOWED_PHASE_TRANSITIONS[state.phase].has(next);
}

export function writingRunReducer(
  state: WritingRunState,
  event: WritingRunEvent,
): WritingRunState {
  switch (event.type) {
    case 'scope-reset':
      return IDLE_WRITING_RUN_STATE;
    case 'run-started':
      if (state.runId !== null && event.runId <= state.runId) return state;
      return {
        ...IDLE_WRITING_RUN_STATE,
        runId: event.runId,
        phase: 'preparing',
        statusLabel: event.statusLabel,
        progress: event.progress,
        completedChapters: event.completedChapters,
        totalChapters: event.totalChapters,
        startedAt: event.at,
        lastActivityAt: event.at,
      };
    case 'activity-received':
      if (!acceptsRunEvent(state, event.runId)) return state;
      return { ...state, lastActivityAt: event.at };
    case 'phase-received':
      if (!acceptsPhase(state, event.runId, event.phase)) return state;
      return {
        ...state,
        phase: event.phase,
        statusLabel: event.statusLabel,
        ...(event.progress === undefined ? {} : { progress: event.progress }),
        ...(event.chapterNumber === undefined ? {} : { chapterNumber: event.chapterNumber }),
        ...(event.chapterTitle === undefined ? {} : { chapterTitle: event.chapterTitle }),
        ...(event.completedChapters === undefined
          ? {}
          : { completedChapters: event.completedChapters }),
        ...(event.totalChapters === undefined ? {} : { totalChapters: event.totalChapters }),
        lastActivityAt: event.at,
        ...(event.phase === 'failed'
          ? { error: event.statusLabel }
          : event.phase === 'complete'
            ? { error: undefined }
            : {}),
      };
    case 'progress-received':
      if (!acceptsRunEvent(state, event.runId)) return state;
      return {
        ...state,
        statusLabel: event.statusLabel,
        ...(event.progress === undefined ? {} : { progress: event.progress }),
        lastActivityAt: event.at,
      };
    case 'blueprint-received':
      if (!acceptsRunEvent(state, event.runId)) return state;
      return {
        ...state,
        totalChapters: event.totalChapters,
        lastActivityAt: event.at,
      };
    case 'chapter-started':
      if (!acceptsPhase(state, event.runId, 'drafting')) return state;
      return {
        ...state,
        phase: 'drafting',
        chapterNumber: event.chapterNumber,
        chapterTitle: event.chapterTitle,
        liveWordCount: 0,
        lastActivityAt: event.at,
      };
    case 'live-prose-received':
      if (!acceptsRunEvent(state, event.runId)) return state;
      return {
        ...state,
        liveWordCount: event.wordCount,
        lastActivityAt: event.at,
      };
    case 'chapter-completed':
      if (!acceptsPhase(state, event.runId, 'chapter_complete')) return state;
      return {
        ...state,
        phase: 'chapter_complete',
        ...(event.progress === undefined ? {} : { progress: event.progress }),
        ...(event.completedChapters === undefined
          ? {}
          : { completedChapters: event.completedChapters }),
        ...(event.totalChapters === undefined ? {} : { totalChapters: event.totalChapters }),
        liveWordCount: event.wordCount,
        lastActivityAt: event.at,
      };
    case 'batch-completed':
      if (!acceptsPhase(state, event.runId, 'paused')) return state;
      return {
        ...state,
        phase: 'paused',
        statusLabel: event.statusLabel,
        completedChapters: event.completedChapters,
        totalChapters: event.totalChapters,
        lastActivityAt: event.at,
      };
    case 'completed':
      if (!acceptsPhase(state, event.runId, 'complete')) return state;
      return {
        ...state,
        phase: 'complete',
        statusLabel: event.statusLabel,
        progress: 100,
        error: undefined,
        lastActivityAt: event.at,
      };
    case 'failed':
      if (!acceptsPhase(state, event.runId, 'failed')) return state;
      return {
        ...state,
        phase: 'failed',
        statusLabel: event.statusLabel,
        error: event.error,
        lastActivityAt: event.at,
      };
    case 'paused':
      if (!acceptsPhase(state, event.runId, 'paused')) return state;
      return {
        ...state,
        phase: 'paused',
        statusLabel: event.statusLabel,
        lastActivityAt: event.at,
      };
    case 'gate-cancelled':
      return acceptsRunEvent(state, event.runId) ? IDLE_WRITING_RUN_STATE : state;
    case 'durable-reconciled': {
      const durable = event.resolution;
      if (durable.phase === 'complete') {
        if (
          state.phase === 'complete'
          && state.progress === 100
          && state.completedChapters === durable.completedChapters
          && state.totalChapters === durable.totalChapters
          && state.statusLabel === durable.statusLabel
        ) {
          return state;
        }
        return {
          ...state,
          runId: null,
          phase: 'complete',
          statusLabel: durable.statusLabel,
          progress: 100,
          completedChapters: durable.completedChapters,
          totalChapters: durable.totalChapters,
          error: undefined,
          lastActivityAt: durable.at,
        };
      }
      if (durable.phase === 'failed') {
        if (state.phase === 'complete') return state;
        if (
          state.phase === 'failed'
          && state.error === durable.error
          && state.lastActivityAt === durable.at
          && state.completedChapters === durable.completedChapters
          && state.progress === durable.progress
        ) {
          return state;
        }
        return {
          ...IDLE_WRITING_RUN_STATE,
          runId: null,
          phase: 'failed',
          statusLabel: durable.statusLabel,
          error: durable.error,
          chapterNumber: durable.chapterNumber,
          completedChapters: durable.completedChapters,
          totalChapters: durable.totalChapters,
          progress: durable.progress,
          startedAt: durable.startedAt,
          lastActivityAt: durable.at,
        };
      }
      if (state.phase === 'complete' || state.phase === 'failed') return state;
      if (
        state.phase === 'paused'
        && state.statusLabel === durable.statusLabel
        && state.progress === durable.progress
        && state.completedChapters === durable.completedChapters
        && state.totalChapters === durable.totalChapters
        && state.lastActivityAt === durable.at
      ) {
        return state;
      }
      return {
        ...state,
        runId: null,
        phase: 'paused',
        statusLabel: durable.statusLabel,
        progress: durable.progress,
        completedChapters: durable.completedChapters,
        totalChapters: durable.totalChapters,
        startedAt: state.startedAt ?? durable.startedAt,
        lastActivityAt: durable.at,
      };
    }
  }
}
