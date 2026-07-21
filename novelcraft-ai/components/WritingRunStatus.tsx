'use client';

import { useState } from 'react';
import { AlertCircle, ChevronDown } from 'lucide-react';

import type { WritingRunState } from '@/lib/writing-session';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { StopStreamingButton } from '@/components/ui/StopStreamingButton';
import { Spinner } from '@/components/ui/spinner';
import { progressBarWidthClass } from './StageBar';

export interface WritingRunControls {
  onPause?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
}

/** Seconds → compact "1h 5m" / "3m 20s" / "42s". */
export function formatRunElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function isBusyPhase(phase: WritingRunState['phase']): boolean {
  return phase === 'preparing' || phase === 'planning' || phase === 'drafting' || phase === 'saving';
}

interface WritingRunStatusProps {
  state: WritingRunState;
  controls?: WritingRunControls;
  /** Wall-clock "now" — the caller owns the 1s heartbeat so panel + bar tick together. */
  nowMs: number;
  /** panel: full detail block (sidebar). bar: single ≤40px line (narrow screens). */
  density: 'panel' | 'bar';
  className?: string;
}

export function WritingRunStatus({ state, controls, nowMs, density, className }: WritingRunStatusProps) {
  const { t } = useLanguage();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const busy = isBusyPhase(state.phase);
  const progress = Math.max(0, Math.min(100, Math.round(state.progress ?? 0)));
  const startedSec = state.startedAt
    ? Math.max(0, (nowMs - Date.parse(state.startedAt)) / 1000)
    : null;
  const lastActivitySec = state.lastActivityAt
    ? Math.max(0, (nowMs - Date.parse(state.lastActivityAt)) / 1000)
    : null;
  const planningWaitSec =
    state.phase === 'preparing' || state.phase === 'planning' ? startedSec : null;
  const planningLong = planningWaitSec != null && planningWaitSec >= 60;
  const planningMinutes = planningWaitSec != null ? Math.floor(planningWaitSec / 60) : 0;

  // The planning-slow hint and the failure summary REPLACE the main status
  // line — they never stack extra explanation paragraphs beneath it. The full
  // error stays readable via the title tooltip.
  let statusText = state.statusLabel;
  let statusTitle: string | undefined;
  if (state.phase === 'failed' && state.error) {
    statusText = state.error;
    statusTitle = state.error;
  } else if (planningLong) {
    statusTitle = state.statusLabel || undefined;
    statusText = t.writingPlanningSlow.replace('{minutes}', String(planningMinutes));
  }

  const chapterLabel = state.chapterNumber != null
    ? `${t.blueprintChapterLabel}${state.chapterNumber}${state.chapterTitle ? ` · ${state.chapterTitle}` : ''}`
    : null;

  const action = busy && controls?.onPause ? (
    <StopStreamingButton onStop={controls.onPause} label={t.writingPause} />
  ) : state.phase === 'paused' && controls?.onResume ? (
    <Button
      variant="outline"
      type="button"
      onClick={controls.onResume}
      className="h-auto px-3 py-1.5 text-xs font-medium"
    >
      {t.resumeWritingNow}
    </Button>
  ) : state.phase === 'failed' && controls?.onRetry ? (
    <Button
      variant="outline"
      type="button"
      onClick={controls.onRetry}
      className="h-auto px-3 py-1.5 text-xs font-medium"
    >
      {t.toastRetry}
    </Button>
  ) : null;

  const statusIcon = busy ? (
    <Spinner size="sm" />
  ) : state.phase === 'failed' ? (
    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-book-danger" aria-hidden />
  ) : null;

  const progressTrack = (
    <div
      role="progressbar"
      aria-valuenow={progress}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={state.statusLabel}
      className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-book-bg-secondary"
    >
      <div
        className={`motion-essential h-1 rounded-full book-progress-bar transition-progress ${progressBarWidthClass(progress)}`}
      />
    </div>
  );

  const detailRows = (
    <>
      {state.modelLabel && (
        <span className="truncate text-xs text-book-ink-muted">{state.modelLabel}</span>
      )}
      {chapterLabel && (
        <span className="truncate text-xs font-medium text-book-ink-secondary">{chapterLabel}</span>
      )}
      <span className="tabular-nums text-xs text-book-ink-muted">
        {t.writingLiveWords.replace('{count}', state.liveWordCount.toLocaleString())}
      </span>
      {state.totalChapters != null && (
        <span className="tabular-nums text-xs text-book-ink-muted">
          {state.completedChapters}/{state.totalChapters}
        </span>
      )}
      {startedSec != null && (
        <span className="tabular-nums text-xs text-book-ink-muted">
          {t.writingElapsed.replace('{time}', formatRunElapsed(startedSec))}
        </span>
      )}
      {lastActivitySec != null && (
        <span className="tabular-nums text-xs text-book-ink-muted">
          {t.writingLastActivity.replace('{time}', formatRunElapsed(lastActivitySec))}
        </span>
      )}
    </>
  );

  if (density === 'bar') {
    return (
      <div className={cn('relative', className)}>
        <div
          role="status"
          aria-live="polite"
          className="flex h-10 max-h-10 items-center gap-2 overflow-hidden whitespace-nowrap rounded-lg border border-book-border bg-book-bg-card/90 px-3 shadow-sm"
        >
          {statusIcon}
          <span
            className={`min-w-0 flex-1 truncate text-xs font-medium ${state.phase === 'failed' ? 'text-book-danger' : 'text-book-ink-primary'}`}
            title={statusTitle}
          >
            {statusText}
          </span>
          {chapterLabel && (
            <span className="shrink-0 truncate text-2xs font-medium text-book-ink-secondary">
              {t.blueprintChapterLabel}{state.chapterNumber}
            </span>
          )}
          <span className="flex w-16 shrink-0 items-center gap-1.5">
            {progressTrack}
            <span className="shrink-0 tabular-nums text-2xs font-medium text-book-ink-secondary">
              {progress}%
            </span>
          </span>
          {action}
          <Button
            type="button"
            variant="unstyled"
            size="unstyled"
            onClick={() => setDetailsOpen(open => !open)}
            aria-expanded={detailsOpen}
            aria-label={t.writingRunDetails}
            className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-book-ink-muted transition-feedback hover:bg-book-bg-secondary hover:text-book-ink-primary"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-toggle', detailsOpen && 'rotate-180')} />
          </Button>
        </div>
        {detailsOpen && (
          <div className="absolute right-0 top-full z-20 mt-1 flex w-64 flex-col gap-1.5 rounded-md border border-book-border bg-book-bg-card p-3 shadow-lg">
            {detailRows}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex flex-col gap-1.5', className)}
    >
      <div className="flex items-center gap-2">
        {statusIcon}
        <span
          className={`min-w-0 flex-1 truncate font-serif text-sm font-medium ${state.phase === 'failed' ? 'text-book-danger' : 'text-book-ink-primary'}`}
          title={statusTitle}
        >
          {statusText}
        </span>
        {action}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {detailRows}
      </div>
      <div className="flex items-center gap-2">
        {progressTrack}
        <span className="shrink-0 tabular-nums text-2xs font-medium text-book-ink-secondary">
          {progress}%
        </span>
      </div>
    </div>
  );
}
