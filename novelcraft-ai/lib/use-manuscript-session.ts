'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import {
  IDLE_WRITING_RUN_STATE,
  startWritingSession,
  type LiveWritingChapter,
  type WritingRunState,
} from '@/lib/writing-session';
import { creativityFromSettings, readCachedNovelCreativity } from '@/hooks/useNovelCreativity';
import type { Chapter, Novel } from '@/lib/db-types';
import { isAIActionGateCancellation } from '@/lib/ai-action-gate';
import { countWords } from '@/lib/utils';
import type { WritingJob } from '@/lib/db/queries-writing-jobs';

// Auto-resume only counts down when the caller explicitly opted in via the
// `autostart` flag (the post-greenlight redirect). All other entries default
// to a manual "Continue" CTA so we don't burn tokens unexpectedly.
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

interface MutableFlag {
  current: boolean;
}

export function claimWritingStart(flag: MutableFlag): boolean {
  if (flag.current) return false;
  flag.current = true;
  return true;
}

export function releaseWritingStart(flag: MutableFlag): void {
  flag.current = false;
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

/**
 * Centralised manuscript-session state.
 *
 * Extracted from the (now-deprecated) `/novel/[id]/manuscript` route so
 * `NovelWorkspace` can embed the same logic in-place inside the new IA. The
 * hook owns:
 *   - novel + chapter fetch
 *   - writing-session lifecycle (start / abort / refresh)
 *   - 5s resume countdown (only on autostart entry)
 *   - batch-done banner state
 *
 * It does NOT own UI; it returns the slices the page used to render in-line.
 */
export function useManuscriptSession(opts: { novelId: string; autostart: boolean }): ManuscriptSession {
  const { novelId, autostart } = opts;
  const { t, locale } = useLanguage();
  const { toast } = useToast();

  const [novel, setNovel] = useState<Novel | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusLabel, setStatusLabel] = useState('');
  const [didRequestAutostart, setDidRequestAutostart] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveChapter, setLiveChapter] = useState<LiveWritingChapter | null>(null);
  const [resumeCountdown, setResumeCountdown] = useState<number | null>(null);
  const [resumePromptVisible, setResumePromptVisible] = useState(false);
  const [batchDone, setBatchDone] = useState<BatchDoneInfo | null>(null);
  const [writingRunState, setWritingRunState] = useState<WritingRunState>(IDLE_WRITING_RUN_STATE);
  const [latestWritingJob, setLatestWritingJob] = useState<WritingJob | null>(null);

  const writingAbortRef = useRef<AbortController | null>(null);
  const writingStartRef = useRef(false);
  const writingRunSeqRef = useRef(0);
  const activeWritingRunRef = useRef<number | null>(null);
  const pausedWritingRunsRef = useRef(new Set<number>());
  const partialChapterByRunRef = useRef(new Map<number, LiveWritingChapter>());
  const resumeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resumeCancelledRef = useRef(false);
  const activeNovelRef = useRef(novelId);
  // Latest startWriting reference, used by toast retry actions so they fire
  // the freshest closure without re-rendering every error.
  const startWritingRef = useRef<((opts?: { chapters?: number }) => Promise<void>) | null>(null);

  const clearResumeTimer = useCallback(() => {
    if (!resumeTimerRef.current) return;
    clearInterval(resumeTimerRef.current);
    resumeTimerRef.current = null;
  }, []);

  useLayoutEffect(() => {
    activeNovelRef.current = novelId;
  }, [novelId]);

  const fetchNovel = useCallback(async () => {
    const requestNovelId = novelId;
    const response = await fetch(`/api/novels/${novelId}`);
    if (!response.ok) throw new Error(`Failed to fetch novel (HTTP ${response.status})`);
    const data = await response.json() as Novel & { writingJob?: WritingJob | null };
    if (activeNovelRef.current === requestNovelId) {
      setNovel(data);
      setLatestWritingJob(data.writingJob ?? null);
    }
    return data;
  }, [novelId]);

  const fetchChapters = useCallback(async () => {
    const requestNovelId = novelId;
    const response = await fetch(`/api/novels/${novelId}/chapters`);
    if (!response.ok) throw new Error('Failed to fetch chapters');
    const data = await response.json();
    if (activeNovelRef.current === requestNovelId) setChapters(data);
    return data as Chapter[];
  }, [novelId]);

  useEffect(() => {
    activeWritingRunRef.current = null;
    pausedWritingRunsRef.current.clear();
    partialChapterByRunRef.current.clear();
    writingRunSeqRef.current += 1;
    writingAbortRef.current?.abort();
    writingAbortRef.current = null;
    writingStartRef.current = false;
    clearResumeTimer();
    resumeCancelledRef.current = false;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setNovel(null);
      setChapters([]);
      setIsLoading(true);
      setStatusLabel('');
      setDidRequestAutostart(false);
      setIsStreaming(false);
      setLiveChapter(null);
      setResumeCountdown(null);
      setResumePromptVisible(false);
      setBatchDone(null);
      setWritingRunState(IDLE_WRITING_RUN_STATE);
      setLatestWritingJob(null);
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
    load();
    return () => { cancelled = true; };
  }, [fetchChapters, fetchNovel, t.errorLoadManuscript, t.toastRetry, toast]);

  const startWriting = useCallback(async (opts?: { chapters?: number }) => {
    if (!claimWritingStart(writingStartRef)) return;
    const runId = ++writingRunSeqRef.current;
    activeWritingRunRef.current = runId;
    const requestNovelId = novelId;
    const isActiveRun = () =>
      activeNovelRef.current === requestNovelId && activeWritingRunRef.current === runId;
    const canApplyPausedFlush = () =>
      activeNovelRef.current === requestNovelId
      && pausedWritingRunsRef.current.has(runId)
      && activeWritingRunRef.current === null;
    setDidRequestAutostart(true);
    setIsStreaming(true);
    setBatchDone(null);
    setResumePromptVisible(false);
    setStatusLabel(t.manuscriptWriting || 'Writing Live');
    const startedAt = new Date().toISOString();
    setWritingRunState({
      ...IDLE_WRITING_RUN_STATE,
      phase: 'preparing',
      statusLabel: t.manuscriptWriting || 'Writing Live',
      progress: novel?.progress ?? 0,
      completedChapters: chapters.length,
      totalChapters: novel?.blueprint?.chapters?.length,
      startedAt,
      lastActivityAt: startedAt,
    });
    setResumeCountdown(null);
    setLiveChapter(null);
    partialChapterByRunRef.current.delete(runId);

    writingAbortRef.current?.abort();
    const abortController = new AbortController();
    writingAbortRef.current = abortController;

    try {
      await startWritingSession({
        novelId,
        locale,
        signal: abortController.signal,
        copy: {
          writingLabel: t.manuscriptWriting || 'Writing Live',
          readingLabel: t.manuscriptReading || 'Reading Copy',
          errorLabel: t.errorWritingFailed,
          timeoutLabel: 'Writing stream timed out — no data received for 90 seconds.',
        },
        options: {
          chapters: opts?.chapters ?? 1,
          creativity: resolveStartWritingCreativity(novelId, novel?.settings),
        },
        handlers: {
          setStatusLabel: next => {
            if (isActiveRun()) setStatusLabel(next);
          },
          patchNovel: patch => {
            if (isActiveRun()) setNovel(current => (current ? { ...current, ...patch } : current));
          },
          replaceNovel: next => {
            if (isActiveRun()) setNovel(next);
          },
          appendLiveChapter: chunk => {
            if (!isActiveRun() && !canApplyPausedFlush()) return;
            setLiveChapter(current => {
              if (!current) return current;
              const next = { ...current, content: current.content + chunk };
              setWritingRunState(run => ({
                ...run,
                phase: 'drafting',
                liveWordCount: countWords(next.content),
                lastActivityAt: new Date().toISOString(),
              }));
              return next;
            });
          },
          setLiveChapter: chapter => {
            if (!isActiveRun() && !canApplyPausedFlush()) return;
            setLiveChapter(current => chapter ? (current ?? chapter) : null);
          },
          upsertChapter: chapter => {
            if (!isActiveRun()) return;
            setChapters(prev => {
              const filtered = prev.filter(c => c.chapterNumber !== chapter.chapterNumber);
              return [...filtered, chapter].sort((a, b) => a.chapterNumber - b.chapterNumber);
            });
          },
          refreshNovel: async () => { await fetchNovel(); },
          refreshChapters: async () => { await fetchChapters(); },
          onBatchDone: info => {
            if (!isActiveRun()) return;
            setIsStreaming(false);
            setDidRequestAutostart(false);
            if (info.remaining > 0) {
              setBatchDone({
                completedChapter: info.completedChapters,
                remaining: info.remaining,
              });
            }
            setWritingRunState(current => ({
              ...current,
              phase: 'paused',
              completedChapters: info.completedChapters,
              totalChapters: info.totalChapters,
              lastActivityAt: new Date().toISOString(),
            }));
          },
          onDone: () => {
            if (!isActiveRun()) return;
            setIsStreaming(false);
            setDidRequestAutostart(false);
            setWritingRunState(current => ({
              ...current,
              phase: 'complete',
              progress: 100,
              lastActivityAt: new Date().toISOString(),
            }));
          },
          onError: message => {
            if (!isActiveRun()) return;
            console.error('Writing error:', message);
            setIsStreaming(false);
            setDidRequestAutostart(false);
            const partial = partialChapterByRunRef.current.get(runId) ?? null;
            partialChapterByRunRef.current.delete(runId);
            if (partial) setLiveChapter(partial);
            setWritingRunState(current => ({
              ...current,
              phase: 'failed',
              statusLabel: message,
              error: message,
              lastActivityAt: new Date().toISOString(),
            }));
            toast(message, 'error', {
              action: { label: t.toastRetry, onClick: () => { void startWritingRef.current?.(opts); } },
            });
          },
          onPartialChapter: chapter => {
            if (isActiveRun() || canApplyPausedFlush()) {
              partialChapterByRunRef.current.set(runId, chapter);
            }
          },
          updateRunState: patch => {
            if (!isActiveRun() && !canApplyPausedFlush()) return;
            setWritingRunState(current => ({ ...current, ...patch }));
          },
        },
      });
    } catch (error) {
      const pausedRun = pausedWritingRunsRef.current.has(runId);
      if (!isActiveRun() && !pausedRun) return;
      if (pausedRun) {
        const partial = partialChapterByRunRef.current.get(runId);
        if (canApplyPausedFlush() && partial) setLiveChapter(partial);
        setWritingRunState(current => ({
          ...current,
          phase: 'paused',
          lastActivityAt: new Date().toISOString(),
        }));
        return;
      }
      setIsStreaming(false);
      setDidRequestAutostart(false);
      const partial = partialChapterByRunRef.current.get(runId) ?? null;
      partialChapterByRunRef.current.delete(runId);
      const liveChapterAfterFailure = liveChapterAfterWritingFailure(error, partial);
      if (error instanceof DOMException && error.name === 'AbortError') {
        // liveChapterAfterWritingFailure already returns null for AbortError.
        setLiveChapter(null);
        return;
      }
      if (isAIActionGateCancellation(error)) {
        setLiveChapter(null);
        setStatusLabel('');
        setWritingRunState(IDLE_WRITING_RUN_STATE);
        return;
      }
      setLiveChapter(liveChapterAfterFailure);
      await Promise.allSettled([fetchNovel(), fetchChapters()]);
      console.error('Failed to start writing:', error);
      toast(error instanceof Error ? error.message : t.errorWritingFailed, 'error', {
        action: { label: t.toastRetry, onClick: () => { void startWritingRef.current?.(opts); } },
      });
      setStatusLabel('');
      const message = error instanceof Error ? error.message : t.errorWritingFailed;
      setWritingRunState(current => ({
        ...current,
        phase: 'failed',
        statusLabel: message,
        error: message,
        lastActivityAt: new Date().toISOString(),
      }));
    } finally {
      pausedWritingRunsRef.current.delete(runId);
      partialChapterByRunRef.current.delete(runId);
      if (isActiveRun()) {
        activeWritingRunRef.current = null;
        releaseWritingStart(writingStartRef);
      }
    }
  }, [chapters.length, fetchChapters, fetchNovel, locale, novel, novelId, t.manuscriptWriting, t.manuscriptReading, t.errorWritingFailed, t.toastRetry, toast]);
  useEffect(() => { startWritingRef.current = startWriting; }, [startWriting]);

  const pauseWriting = useCallback(() => {
    const pausedRun = activeWritingRunRef.current;
    if (pausedRun !== null) pausedWritingRunsRef.current.add(pausedRun);
    activeWritingRunRef.current = null;
    writingRunSeqRef.current += 1;
    writingAbortRef.current?.abort();
    writingStartRef.current = false;
    setIsStreaming(false);
    setDidRequestAutostart(false);
    setStatusLabel(t.writingPausedLabel || 'Writing paused');
    setWritingRunState(current => ({
      ...current,
      phase: 'paused',
      statusLabel: t.writingPausedLabel || 'Writing paused',
      lastActivityAt: new Date().toISOString(),
    }));
    toast(t.writingStopped, 'info');
  }, [t.writingPausedLabel, t.writingStopped, toast]);

  // Autostart from explicit autostart flag (post-greenlight redirect).
  useEffect(() => {
    if (!autostart || didRequestAutostart || !novel) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (novel.stage === 'ready_for_greenlight') {
        startWriting();
        return;
      }
      if (novel.stage === 'autonomous_writing') {
        setStatusLabel(t.manuscriptWriting || 'Writing Live');
        return;
      }
      setStatusLabel(t.manuscriptReading || 'Reading Copy');
    });
    return () => {
      cancelled = true;
    };
  }, [autostart, didRequestAutostart, novel, startWriting, t.manuscriptReading, t.manuscriptWriting]);

  // Mid-writing resume: when the novel is mid-writing, blueprint exists and
  // the writing lock is free or expired, surface the resume banner. Only the
  // autostart path triggers the 5s countdown — anywhere else we let the user
  // decide so we never burn tokens silently.
  useEffect(() => {
    if (didRequestAutostart || !novel || batchDone) return;
    if (novel.stage !== 'autonomous_writing') return;
    if (!novel.blueprint || !novel.blueprint.chapters?.length) return;
    if (chapters.length >= novel.blueprint.chapters.length) return;

    const lockExpiry = novel.writingLockExpiresAt ?? 0;
    const lockHeld = lockExpiry > Date.now();
    if (lockHeld) return;

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
      setResumeCountdown(prev => {
        if (resumeCancelledRef.current) {
          clearResumeTimer();
          return null;
        }
        if (prev === null) return null;
        if (prev <= 1) {
          clearResumeTimer();
          startWriting();
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      cancelled = true;
      clearResumeTimer();
    };
  }, [autostart, batchDone, chapters.length, clearResumeTimer, didRequestAutostart, novel, startWriting]);

  // Status-label fallback (when not in a writing flow).
  useEffect(() => {
    if (!novel || autostart) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (novel.stage === 'completed' || novel.stage === 'whole_book_unification') {
        setStatusLabel(t.manuscriptReading || 'Reading Copy');
      } else if (novel.stage !== 'autonomous_writing') {
        setStatusLabel(t.manuscriptWriting || 'Writing Live');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [autostart, novel, t.manuscriptReading, t.manuscriptWriting]);

  // Reconstruct a truthful resumable state from durable novel/chapter data
  // after relaunch or refocus. A running HTTP stream will immediately replace
  // this with its more specific preparing/planning/drafting phase events.
  useEffect(() => {
    if (!novel || isStreaming) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (latestWritingJob?.status === 'failed') {
        setWritingRunState({
          ...IDLE_WRITING_RUN_STATE,
          phase: 'failed',
          statusLabel: latestWritingJob.errorMessage || t.errorWritingFailed,
          error: latestWritingJob.errorMessage || t.errorWritingFailed,
          chapterNumber: latestWritingJob.currentChapter ?? undefined,
          completedChapters: chapters.length,
          totalChapters: novel.blueprint?.chapters?.length,
          progress: novel.progress,
          startedAt: latestWritingJob.startedAt,
          lastActivityAt: latestWritingJob.updatedAt,
        });
        return;
      }
      if (novel.stage === 'autonomous_writing') {
        setWritingRunState(current => current.phase === 'failed' ? current : ({
          ...current,
          phase: 'paused',
          statusLabel: t.writingPausedLabel || 'Writing paused',
          progress: novel.progress,
          completedChapters: chapters.length,
          totalChapters: novel.blueprint?.chapters?.length,
          startedAt: current.startedAt ?? latestWritingJob?.startedAt,
          lastActivityAt: latestWritingJob?.updatedAt ?? current.lastActivityAt ?? new Date().toISOString(),
        }));
        return;
      }
      if (novel.stage === 'completed' || novel.stage === 'whole_book_unification') {
        setWritingRunState(current => ({
          ...current,
          phase: 'complete',
          statusLabel: t.manuscriptReading || 'Reading Copy',
          progress: 100,
          completedChapters: chapters.length,
          totalChapters: novel.blueprint?.chapters?.length ?? chapters.length,
        }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chapters.length, isStreaming, latestWritingJob, novel, t.errorWritingFailed, t.manuscriptReading, t.writingPausedLabel]);

  // Abort writing + clear timers on unmount.
  useEffect(() => {
    return () => {
      writingAbortRef.current?.abort();
      clearResumeTimer();
    };
  }, [clearResumeTimer]);

  const cancelResume = useCallback(() => {
    resumeCancelledRef.current = true;
    setResumeCountdown(null);
    setResumePromptVisible(false);
    clearResumeTimer();
  }, [clearResumeTimer]);

  const dismissBatchDone = useCallback(() => setBatchDone(null), []);

  const patchNovelLocal = useCallback((patch: Partial<Novel>) => {
    setNovel(current => current ? { ...current, ...patch } : current);
  }, []);

  return {
    novel,
    chapters,
    isLoading,
    statusLabel,
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
    dismissBatchDone,
    patchNovelLocal,
  };
}
