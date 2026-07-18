'use client';

import { useEffect, useState } from 'react';
import { Archive, BookOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { StopStreamingButton } from '@/components/ui/StopStreamingButton';
import { Spinner } from '@/components/ui/spinner';
import { NibIcon } from '@/components/Icons';
import { useLanguage } from '@/components/LanguageProvider';
import type { Novel } from '@/lib/db-types';
import { WritingStartPreviewDialog } from '@/components/WritingStartPreviewDialog';

interface StageActionPillProps {
  novel: Novel | null;
  onStartWriting: () => void;
  onDownloadBundle?: () => void;
  /** True while a writing stream is in flight. Surfaces the Pause button so
   *  the user can abort without leaving the manuscript view. */
  isStreaming?: boolean;
  /** Abort the in-flight writing stream. The parent is responsible for any
   *  follow-up resume banner. */
  onPauseWriting?: () => void;
  /** When true, the pill defaults to collapsed regardless of stage. Useful
   *  when the action is already prominent elsewhere on screen. */
  forceCollapsed?: boolean;
}

/**
 * Floating "project status + recommended action" pill that replaces the old
 * fixed-width right sidebar (Wave 3 commit 1).
 *
 * Default state:
 *   - stage = discovery_interview / ready_for_greenlight → expanded (these
 *     stages have a primary CTA the user is expected to click next).
 *   - other stages → collapsed badge with stage label + progress ring. Click
 *     to expand.
 *
 * Positioning is `absolute top-3 right-3` so the host pane just needs to be
 * `relative`. The pill never grabs more than ~280px width when expanded.
 */
export function StageActionPill({
  novel,
  onStartWriting,
  onDownloadBundle,
  isStreaming,
  onPauseWriting,
  forceCollapsed = false,
}: StageActionPillProps) {
  const { t } = useLanguage();

  const isExportReady =
    novel?.stage === 'whole_book_unification' || novel?.stage === 'completed';
  const stageNeedsCTA = novel?.stage === 'ready_for_greenlight';

  const [expanded, setExpanded] = useState(false);
  const [startPreviewOpen, setStartPreviewOpen] = useState(false);
  // Re-evaluate default expansion whenever stage flips between needs-CTA and
  // not. The user can still close manually; this only sets the baseline.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setExpanded(forceCollapsed ? false : stageNeedsCTA);
    });
    return () => {
      cancelled = true;
    };
  }, [stageNeedsCTA, forceCollapsed]);

  // Wave 3 commit 4 — listen for the global "toggle right panel" shortcut
  // (⌘\ + View → Toggle Right Panel) so the pill can be popped open or
  // collapsed from anywhere in the shell.
  useEffect(() => {
    const handler = () => setExpanded(prev => !prev);
    window.addEventListener('inkmarshal:shell:toggle-right', handler);
    return () => window.removeEventListener('inkmarshal:shell:toggle-right', handler);
  }, []);

  if (!novel) return null;

  const progress = Math.max(0, Math.min(100, novel.progress ?? 0));
  const stageLabel = t.stages[novel.stage];

  return (
    <>
      <div className="pointer-events-none absolute top-3 right-3 z-20">
        <div className="pointer-events-auto">
          <Popover open={expanded} onOpenChange={setExpanded}>
            <PopoverTrigger asChild>
              <Button
                variant="unstyled"
                size="unstyled"
                type="button"
                title={t.stagePillCollapsedHint}
                aria-expanded={expanded}
                // Documented design exception: this control IS the product status
                // pill/toggle, so it keeps pill geometry while every other business
                // Button inherits the canonical radius.
                data-shape="stage-pill"
                className="flex items-center gap-2 rounded-full border border-book-border bg-book-bg-card/90 px-3 py-1.5 text-xs font-medium text-book-ink-secondary shadow-sm backdrop-blur transition-feedback hover:bg-book-bg-card"
              >
                <ProgressRing progress={progress} size={16} stroke={2} />
                <span className="font-serif text-book-ink-primary">{stageLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              sideOffset={8}
              className="w-72 border-book-border bg-book-bg-card/95 p-4 text-book-ink-primary shadow-md backdrop-blur"
            >
              <div className="mb-3 min-w-0">
                <div className="text-2xs uppercase tracking-widest text-book-ink-muted">
                  {t.projectStatus}
                </div>
                <div className="font-serif text-sm font-medium text-book-ink-primary">
                  {stageLabel}
                </div>
              </div>

              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between px-1">
                  <span className="text-2xs uppercase tracking-wider text-book-ink-muted">
                    {t.progress}
                  </span>
                  <span className="text-2xs font-medium text-book-ink-secondary">
                    {progress}%
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-book-bg-secondary">
                  <div
                    className="motion-essential h-1 rounded-full bg-book-ink-primary transition-progress"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>

              <div className="space-y-2">
                {novel.stage === 'ready_for_greenlight' && (
                  <Button
                    variant="ink"
                    onClick={() => setStartPreviewOpen(true)}
                    disabled={Boolean(isStreaming)}
                    className="h-auto w-full gap-2 px-4 py-2.5 text-sm font-medium shadow-sm"
                  >
                    <NibIcon className="h-4 w-4" />
                    {t.approveStart}
                  </Button>
                )}

                {novel.stage === 'autonomous_writing' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-center gap-2 rounded-lg border border-book-border bg-book-bg-secondary px-3 py-2 text-sm font-serif font-medium text-book-ink-primary">
                      {isStreaming ? <Spinner size="sm" /> : null}
                      {stageLabel}
                    </div>
                    {isStreaming && onPauseWriting && (
                      <StopStreamingButton fullWidth onStop={onPauseWriting} label={t.writingPause} />
                    )}
                  </div>
                )}

                {isExportReady && (
                  // The pill only renders at export-ready while the user is
                  // already on the manuscript view, so the old "Open Manuscript"
                  // tile was a primary-styled <div> that did nothing. Exporting
                  // the finished bundle is the real next action — surface it as
                  // the primary button instead of a dead affordance.
                  onDownloadBundle ? (
                    <Button
                      variant="ink"
                      type="button"
                      onClick={onDownloadBundle}
                      className="h-auto w-full gap-2 px-4 py-2.5 text-sm font-medium shadow-sm"
                    >
                      <Archive className="h-4 w-4" />
                      {t.submissionBundleShortcut}
                    </Button>
                  ) : (
                    <div
                      role="status"
                      className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-book-border bg-book-bg-secondary px-3 py-2 text-sm font-medium text-book-ink-secondary"
                    >
                      <BookOpen className="h-4 w-4" />
                      {stageLabel}
                    </div>
                  )
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <WritingStartPreviewDialog
        open={startPreviewOpen}
        targetWords={novel.targetWords}
        onOpenChange={setStartPreviewOpen}
        onStart={onStartWriting}
      />
    </>
  );
}

/**
 * Pure SVG ring — pre-W3-3, the global SaveStatusIndicator owns ring + status;
 * here we just need a static progress ring for the collapsed badge.
 */
function ProgressRing({ progress, size, stroke }: { progress: number; size: number; stroke: number }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (progress / 100) * circumference;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        opacity={0.2}
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${circumference - dash}`}
        strokeDashoffset={circumference / 4}
        strokeLinecap="round"
        className="motion-essential text-book-gold transition-progress"
      />
    </svg>
  );
}
