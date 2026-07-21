'use client';

import { useId, useState } from 'react';
import { Archive, Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { NibIcon } from '@/components/Icons';
import { useLanguage } from '@/components/LanguageProvider';
import {
  isInStages,
  STAGES_THAT_SHOW_UNIFICATION_PANEL,
  type NovelStage,
} from '@/lib/novel-stages';

/**
 * StageBar — the persistent, inline-mountable stage strip shared by the
 * Assistant / Story Deck / Manuscript views. Replaces the old floating
 * popover pill: the recommended next action is always visible, never hidden
 * behind a disclosure, and there is exactly one primary action per stage.
 *
 * Flow: Brainstorm → Story Ready → Approval → Writing.
 *
 * All copy resolves through `useLanguage()` where a key exists; the few
 * strings without a shipped key accept overrides via `labels` and default to
 * English literals (marked TODO(i18n) — wired when the keys land).
 */

type StageBarStepKey = 'brainstorm' | 'story_ready' | 'approval' | 'writing';

interface StageBarLabels {
  /** Nav landmark label. Defaults to t.projectStatus ("Writing Stage"). */
  navAriaLabel?: string;
  stepBrainstorm?: string;
  stepStoryReady?: string;
  stepApproval?: string;
  stepWriting?: string;
  /** Secondary action at the ready stage. Default: "Review Story Deck". */
  reviewDeck?: string;
}

export interface StageBarProps {
  stage: NovelStage | null | undefined;
  /** 0–100 whole-book progress, shown as text next to the steps. */
  progress?: number;
  /** Primary action at the approval step — "Approve & Begin Writing". */
  onApprove?: () => void;
  /** Required Story Deck coverage. False replaces Approve with the repair CTA. */
  storyDeckComplete?: boolean;
  onCompleteDeck?: () => void;
  /** Secondary action at the approval step — review the Story Deck first. */
  onReviewDeck?: () => void;
  /** Primary action once the book is export-ready. */
  onDownloadBundle?: () => void;
  /** True while a writing stream is in flight — animates writing status. */
  isStreaming?: boolean;
  /** Disable the primary action (e.g. while a run is being prepared). */
  approveDisabled?: boolean;
  labels?: StageBarLabels;
  className?: string;
}

interface StepModel {
  key: StageBarStepKey;
  label: string;
  state: 'done' | 'current' | 'upcoming';
}

export interface StageBarProjection {
  /** False while required Story Deck coverage is missing: a
   *  `ready_for_greenlight` stage then projects onto the Story Ready step
   *  (the deck still needs repair) instead of Approval. Defaults to true. */
  storyDeckComplete?: boolean;
}

export function buildStageBarSteps(
  stage: NovelStage | null | undefined,
  labels: { brainstorm: string; storyReady: string; approval: string; writing: string },
  projection: StageBarProjection = {},
): StepModel[] {
  const storyDeckComplete = projection.storyDeckComplete ?? true;
  // Index of the step the stage maps onto; everything before it is done.
  const currentIndex = stage === 'discovery_interview'
    ? 0
    : stage === 'ready_for_greenlight'
      ? storyDeckComplete ? 2 : 1
      : 3;
  const writingDone = !!stage && isInStages(stage, STAGES_THAT_SHOW_UNIFICATION_PANEL);
  const defs: Array<{ key: StageBarStepKey; label: string }> = [
    { key: 'brainstorm', label: labels.brainstorm },
    { key: 'story_ready', label: labels.storyReady },
    { key: 'approval', label: labels.approval },
    { key: 'writing', label: labels.writing },
  ];
  return defs.map((def, index) => ({
    ...def,
    state: index < currentIndex || (writingDone && index === currentIndex)
      ? 'done'
      : index === currentIndex
        ? 'current'
        : 'upcoming',
  }));
}

/** Progress bar fill width without inline styles (design-system contract:
 *  runtime widths are debt outside the one documented pill exception). */
const PROGRESS_WIDTH_CLASSES = [
  'w-0', 'w-[5%]', 'w-[10%]', 'w-[15%]', 'w-[20%]', 'w-[25%]', 'w-[30%]',
  'w-[35%]', 'w-[40%]', 'w-[45%]', 'w-1/2', 'w-[55%]', 'w-[60%]', 'w-[65%]',
  'w-[70%]', 'w-3/4', 'w-[80%]', 'w-[85%]', 'w-[90%]', 'w-[95%]', 'w-full',
] as const;

export function progressBarWidthClass(progress: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  const bucket = Math.min(PROGRESS_WIDTH_CLASSES.length - 1, Math.round(clamped / 5));
  return PROGRESS_WIDTH_CLASSES[bucket];
}

export function StageBar({
  stage,
  progress = 0,
  onApprove,
  storyDeckComplete = true,
  onCompleteDeck,
  onReviewDeck,
  onDownloadBundle,
  isStreaming = false,
  approveDisabled = false,
  labels,
  className,
}: StageBarProps) {
  const { t } = useLanguage();
  const stepsId = useId();
  const [stepsOpen, setStepsOpen] = useState(false);

  if (!stage) return null;

  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));
  const stepLabels = {
    brainstorm: labels?.stepBrainstorm ?? t.agentMainThread,
    storyReady: labels?.stepStoryReady ?? t.stageStoryReady,
    approval: labels?.stepApproval ?? t.stageApproval,
    writing: labels?.stepWriting ?? t.stages.autonomous_writing,
  };
  const steps = buildStageBarSteps(stage, stepLabels, { storyDeckComplete });
  const currentStep = steps.find(step => step.state === 'current') ?? steps[steps.length - 1];

  const isReady = stage === 'ready_for_greenlight';
  const isWritingStage = stage === 'autonomous_writing';
  const isExportReady = isInStages(stage, STAGES_THAT_SHOW_UNIFICATION_PANEL);

  return (
    <nav
      aria-label={labels?.navAriaLabel ?? t.projectStatus}
      className={`relative rounded-lg border border-book-border bg-book-bg-card/90 px-3 py-2 shadow-sm ${className ?? ''}`}
    >
      <div className="flex items-center gap-3">
        {/* Narrow windows: the step list collapses to the current step plus a
            pill toggle that expands the full list inline (no popover). */}
        <Button
          variant="unstyled"
          size="unstyled"
          type="button"
          aria-expanded={stepsOpen}
          aria-controls={stepsId}
          onClick={() => setStepsOpen(open => !open)}
          title={t.stagePillCollapsedHint}
          // Documented design exception: this control IS the product status
          // pill/toggle, so it keeps pill geometry while every other business
          // Button inherits the canonical radius.
          data-shape="stage-pill"
          className="flex items-center gap-2 rounded-full border border-book-border bg-book-bg-card px-3 py-1.5 text-xs font-medium text-book-ink-secondary transition-feedback hover:bg-book-bg-secondary md:hidden"
        >
          <StageDot state={currentStep.state} />
          <span className="font-serif text-book-ink-primary">{currentStep.label}</span>
        </Button>

        <ol
          id={stepsId}
          className={`${stepsOpen ? 'flex' : 'hidden'} absolute left-0 right-0 top-full z-10 mt-1 flex-col gap-1 rounded-lg border border-book-border bg-book-bg-card p-2 shadow-md md:static md:mt-0 md:flex md:min-w-0 md:flex-1 md:flex-row md:items-center md:gap-0 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none`}
        >
          {steps.map((step, index) => (
            <li
              key={step.key}
              aria-current={step.state === 'current' ? 'step' : undefined}
              className="flex items-center gap-1.5 px-2 py-1 md:py-0"
            >
              <StageDot state={step.state} />
              <span
                className={`whitespace-nowrap text-xs font-medium ${
                  step.state === 'current'
                    ? 'font-serif text-book-ink-primary'
                    : step.state === 'done'
                      ? 'text-book-ink-secondary'
                      : 'text-book-ink-muted'
                }`}
              >
                {step.label}
              </span>
              {index < steps.length - 1 && (
                <span aria-hidden className="ml-1.5 hidden h-px w-4 bg-book-border md:inline-block" />
              )}
            </li>
          ))}
        </ol>

        <div className="ml-auto flex shrink-0 items-center gap-2 md:ml-0">
          <span
            role="status"
            className="hidden text-2xs font-medium tabular-nums text-book-ink-muted sm:inline"
          >
            {t.progress} {clampedProgress}%
          </span>

          {isReady && !storyDeckComplete && onCompleteDeck && (
            <Button
              variant="ink"
              type="button"
              onClick={onCompleteDeck}
              disabled={approveDisabled}
              className="h-auto gap-2 px-4 py-2 text-sm font-medium shadow-sm"
            >
              <NibIcon className="h-4 w-4" />
              {t.storyDeckCompleteAction}
            </Button>
          )}
          {isReady && storyDeckComplete && onApprove && (
            <Button
              variant="ink"
              type="button"
              onClick={onApprove}
              disabled={approveDisabled || isStreaming}
              className="h-auto gap-2 px-4 py-2 text-sm font-medium shadow-sm"
            >
              <NibIcon className="h-4 w-4" />
              {t.approveStart}
            </Button>
          )}
          {isReady && onReviewDeck && (
            <Button
              variant="outline"
              type="button"
              onClick={onReviewDeck}
              className="h-auto px-3 py-2 text-xs font-medium"
            >
              {labels?.reviewDeck ?? t.storyDeckReviewAction}
            </Button>
          )}

          {isWritingStage && (
            <>
              <span className="hidden items-center gap-2 border border-book-border bg-book-bg-secondary px-3 py-1.5 text-xs font-serif font-medium text-book-ink-primary lg:inline-flex">
                {isStreaming ? <Spinner size="sm" /> : null}
                {t.stages.autonomous_writing}
              </span>
            </>
          )}

          {isExportReady && onDownloadBundle && (
            <Button
              variant="ink"
              type="button"
              onClick={onDownloadBundle}
              className="h-auto gap-2 px-4 py-2 text-sm font-medium shadow-sm"
            >
              <Archive className="h-4 w-4" />
              {t.submissionBundleShortcut}
            </Button>
          )}
        </div>
      </div>

      {/* Whole-book progress track. The fill width is runtime-dynamic, which
          Tailwind cannot generate as a class — inline style is the documented
          canonical path for this bar (same justification as the old pill). */}
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-book-bg-secondary">
        <div
          className="motion-essential h-1 rounded-full bg-book-ink-primary transition-progress"
          style={{ width: `${clampedProgress}%` }}
        />
      </div>
    </nav>
  );
}

function StageDot({ state }: { state: StepModel['state'] }) {
  if (state === 'done') {
    return (
      <span
        aria-hidden
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-book-gold/15 text-book-gold-dark"
      >
        <Check className="h-2.5 w-2.5" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`h-2 w-2 shrink-0 rounded-full ${
        state === 'current' ? 'bg-book-gold' : 'bg-book-border'
      }`}
    />
  );
}
