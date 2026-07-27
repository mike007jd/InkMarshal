'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { creativityFromSettings, readCachedNovelCreativity } from '@/hooks/useNovelCreativity';
import { isAIActionGateCancellation } from '@/lib/ai-action-gate';
import type { Chapter, Novel } from '@/lib/db-types';
import {
  isWritingRunBusyPhase,
  type LiveWritingChapter,
} from '@/lib/writing-session';
import { useDurableWritingRun } from '@/lib/writing/use-durable-writing-run';
import { WritingTransportController } from '@/lib/writing/writing-transport-controller';
import {
  IDLE_WRITING_RUN_STATE,
  writingRunReducer,
  type WritingRunEvent,
  type WritingRunState,
} from '@/lib/writing/writing-run-reducer';

const RESUME_COUNTDOWN_SEC = 5;

export interface BatchDoneInfo {
  completedChapter: number;
  remaining: number;
}

export interface ManuscriptSession {
  novel: Novel | null;
  chapters: Chapter[];
  isLoading: boolean;
  statusLabel: string;
  didRequestAutostart: boolean;
  isStreaming: boolean;
  liveChapter: LiveWritingChapter | null;
  resumeCountdown: number | null;
  resumePromptVisible: boolean;
  batchDone: BatchDoneInfo | null;
  writingRunState: WritingRunState;

  fetchNovel: () => Promise<Novel>;
  fetchChapters: () => Promise<Chapter[]>;
  startWriting: (opts?: { chapters?: number }) => Promise<void>;
  pauseWriting: () => void;
  cancelResume: () => void;
  dismissBatchDone: () => void;
  patchNovelLocal: (patch: Partial<Novel>) => void;
}

export function liveChapterAfterWritingFailure(
  error: unknown,
  partial: LiveWritingChapter | null,
): LiveWritingChapter | null {
  if (error instanceof DOMException && error.name === 'AbortError') return null;
  return partial ?? null;
}

export function resolveStartWritingCreativity(
  novelId: string,
  settings: Novel['settings'] | null | undefined,
) {
  return readCachedNovelCreativity(novelId) ?? creativityFromSettings(settings);
}

export function useManuscriptSession(opts: {
  novelId: string;
  autostart: boolean;
}): ManuscriptSession {
  const { novelId, autostart } = opts;
  const { t, locale } = useLanguage();
  const { toast } = useToast();
  const durable = useDurableWritingRun(novelId);
  const {
    novel,
    chapters,
    fetchNovel,
    fetchChapters,
    beginRun,
    invalidateReads,
    patchNovel,
    replaceNovel,
    upsertChapter,
    resolve: resolveDurableRun,
  } = durable;

  const [isLoading, setIsLoading] = useState(true);
  const [liveChapter, setLiveChapter] = useState<LiveWritingChapter | null>(null);
  const [resumeCountdown, setResumeCountdown] = useState<number | null>(null);
  const [resumePromptVisible, setResumePromptVisible] = useState(false);
  const [batchDone, setBatchDone] = useState<BatchDoneInfo | null>(null);
  const [autostartConsumed, setAutostartConsumed] = useState(false);
  const [writingRunState, dispatchWritingRun] = useReducer(
    writingRunReducer,
    IDLE_WRITING_RUN_STATE,
  );

  const transportRef = useRef(new WritingTransportController());
  const resumeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resumeCancelledRef = useRef(false);
  const startWritingRef = useRef<((options?: { chapters?: number }) => Promise<void>) | null>(
    null,
  );

  const isStreaming = isWritingRunBusyPhase(writingRunState.phase);
  const didRequestAutostart = isStreaming;

  const clearResumeTimer = useCallback(() => {
    if (!resumeTimerRef.current) return;
    clearInterval(resumeTimerRef.current);
    resumeTimerRef.current = null;
  }, []);

  useEffect(() => {
    transportRef.current.cancel();
    clearResumeTimer();
    resumeCancelledRef.current = false;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setIsLoading(true);
      setLiveChapter(null);
      setResumeCountdown(null);
      setResumePromptVisible(false);
      setBatchDone(null);
      setAutostartConsumed(false);
      dispatchWritingRun({ type: 'scope-reset' });
    });
    return () => {
      cancelled = true;
    };
  }, [clearResumeTimer, novelId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      try {
        await Promise.all([fetchNovel(), fetchChapters()]);
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load manuscript:', error);
        toast(t.errorLoadManuscript, 'error', {
          action: { label: t.toastRetry, onClick: () => { void load(); } },
        });
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchChapters, fetchNovel, t.errorLoadManuscript, t.toastRetry, toast]);

  const startWriting = useCallback(async (options?: { chapters?: number }) => {
    if (transportRef.current.isRunning()) return;

    beginRun();
    setBatchDone(null);
    setResumePromptVisible(false);
    setResumeCountdown(null);
    setLiveChapter(null);
    const writingLabel = t.manuscriptWriting || 'Writing Live';

    const onRunEvent = (event: WritingRunEvent) => {
      dispatchWritingRun(event);
      if (event.type === 'batch-completed' && event.remaining > 0) {
        setBatchDone({
          completedChapter: event.completedChapters,
          remaining: event.remaining,
        });
      }
      if (event.type === 'failed') {
        toast(event.error, 'error', {
          action: {
            label: t.toastRetry,
            onClick: () => { void startWritingRef.current?.(options); },
          },
        });
      }
    };

    const outcome = await transportRef.current.start(
      {
        novelId,
        locale,
        copy: {
          writingLabel,
          readingLabel: t.manuscriptReading || 'Reading Copy',
          errorLabel: t.errorWritingFailed,
          timeoutLabel: 'Writing stream timed out — no data received for 90 seconds.',
        },
        options: {
          chapters: options?.chapters ?? 1,
          creativity: resolveStartWritingCreativity(novelId, novel?.settings),
        },
        initialState: {
          statusLabel: writingLabel,
          progress: novel?.progress ?? 0,
          completedChapters: chapters.length,
          totalChapters: novel?.blueprint?.chapters?.length,
        },
      },
      {
        onRunEvent,
        patchNovel,
        replaceNovel,
        appendLiveChapter: chunk => {
          setLiveChapter(current => current
            ? { ...current, content: current.content + chunk }
            : current);
        },
        setLiveChapter,
        upsertChapter,
        refreshDurableState: async () => {
          await Promise.allSettled([fetchChapters(), fetchNovel()]);
        },
      },
    );

    if (outcome.kind === 'paused') {
      if (outcome.partial) setLiveChapter(outcome.partial);
      if (outcome.isLatestRun) {
        await Promise.allSettled([fetchNovel()]);
      }
      return;
    }
    if (outcome.kind !== 'failed') return;

    if (isAIActionGateCancellation(outcome.error)) {
      setLiveChapter(null);
      dispatchWritingRun({ type: 'gate-cancelled', runId: outcome.runId });
      return;
    }

    await Promise.allSettled([fetchNovel(), fetchChapters()]);
    const message = outcome.error instanceof Error
      ? outcome.error.message
      : t.errorWritingFailed;
    setLiveChapter(liveChapterAfterWritingFailure(outcome.error, outcome.partial));
    dispatchWritingRun({
      type: 'failed',
      runId: outcome.runId,
      statusLabel: message,
      error: message,
      at: new Date().toISOString(),
    });
    toast(message, 'error', {
      action: {
        label: t.toastRetry,
        onClick: () => { void startWritingRef.current?.(options); },
      },
    });
  }, [
    chapters.length,
    beginRun,
    fetchChapters,
    fetchNovel,
    locale,
    novel,
    novelId,
    patchNovel,
    replaceNovel,
    t.errorWritingFailed,
    t.manuscriptReading,
    t.manuscriptWriting,
    t.toastRetry,
    toast,
    upsertChapter,
  ]);

  useEffect(() => {
    startWritingRef.current = startWriting;
  }, [startWriting]);

  const pauseWriting = useCallback(() => {
    if (!transportRef.current.pause(t.writingPausedLabel || 'Writing paused')) return;
    invalidateReads();
    toast(t.writingStopped, 'info');
  }, [invalidateReads, t.writingPausedLabel, t.writingStopped, toast]);

  useEffect(() => {
    if (!autostart || autostartConsumed || isStreaming || !novel) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (novel.stage === 'ready_for_greenlight') {
        setAutostartConsumed(true);
        void startWriting();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [autostart, autostartConsumed, isStreaming, novel, startWriting]);

  useEffect(() => {
    if (isStreaming || !novel || batchDone) return;
    if (autostart && autostartConsumed) return;
    if (novel.stage !== 'autonomous_writing') return;
    if (!novel.blueprint?.chapters?.length) return;
    if (chapters.length >= novel.blueprint.chapters.length) return;
    if ((novel.writingLockExpiresAt ?? 0) > Date.now()) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setResumePromptVisible(true);
    });
    if (!autostart) {
      return () => {
        cancelled = true;
      };
    }

    resumeCancelledRef.current = false;
    queueMicrotask(() => {
      if (!cancelled) setResumeCountdown(RESUME_COUNTDOWN_SEC);
    });
    clearResumeTimer();
    resumeTimerRef.current = setInterval(() => {
      setResumeCountdown(current => {
        if (resumeCancelledRef.current) {
          clearResumeTimer();
          return null;
        }
        if (current === null) return null;
        if (current <= 1) {
          clearResumeTimer();
          setAutostartConsumed(true);
          void startWriting();
          return null;
        }
        return current - 1;
      });
    }, 1000);

    return () => {
      cancelled = true;
      clearResumeTimer();
    };
  }, [
    autostart,
    autostartConsumed,
    batchDone,
    chapters.length,
    clearResumeTimer,
    isStreaming,
    novel,
    startWriting,
  ]);

  useEffect(() => {
    if (!novel || isStreaming || transportRef.current.isRunning()) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || transportRef.current.isRunning()) return;
      const resolution = resolveDurableRun(writingRunState, {
        failed: t.errorWritingFailed,
        paused: t.writingPausedLabel || 'Writing paused',
        reading: t.manuscriptReading || 'Reading Copy',
      });
      if (resolution) {
        dispatchWritingRun({ type: 'durable-reconciled', resolution });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    isStreaming,
    novel,
    resolveDurableRun,
    t.errorWritingFailed,
    t.manuscriptReading,
    t.writingPausedLabel,
    writingRunState,
  ]);

  useEffect(() => {
    const transport = transportRef.current;
    return () => {
      transport.cancel();
      clearResumeTimer();
    };
  }, [clearResumeTimer]);

  const cancelResume = useCallback(() => {
    resumeCancelledRef.current = true;
    setResumeCountdown(null);
    setResumePromptVisible(false);
    clearResumeTimer();
  }, [clearResumeTimer]);

  return {
    novel,
    chapters,
    isLoading,
    statusLabel: writingRunState.statusLabel,
    didRequestAutostart,
    isStreaming,
    liveChapter,
    resumeCountdown,
    resumePromptVisible,
    batchDone,
    writingRunState,
    fetchNovel,
    fetchChapters,
    startWriting,
    pauseWriting,
    cancelResume,
    dismissBatchDone: () => setBatchDone(null),
    patchNovelLocal: patchNovel,
  };
}
