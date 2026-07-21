'use client';

import { BookUser, FileText, Globe, SlidersHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { NibIcon } from '@/components/Icons';
import { useLanguage } from '@/components/LanguageProvider';

/**
 * ReadyCompletionCard — the "story is ready, approve to write" summary card.
 *
 * Purely presentational: it consumes props and fires callbacks, it never
 * fetches. Run details (target length, planning/drafting models, estimated
 * time/cost) are resolved by the parent, which owns the capability bindings.
 *
 * Copy resolves through `useLanguage()` where a shipped key exists; the rest
 * accepts overrides via `labels` and defaults to English literals (marked
 * TODO(i18n) — wired when the keys land).
 */

export interface ReadyRunDetails {
  /** Whole-book target length in words. */
  targetWords?: number | null;
  planningModelLabel?: string | null;
  draftingModelLabel?: string | null;
  estimatedTimeLabel?: string | null;
  estimatedCostLabel?: string | null;
}

interface ReadyCompletionCardLabels {
  title?: string;
  reviewDeck?: string;
  adjustProposal?: string;
  targetLength?: string;
}

export interface ReadyCompletionCardProps {
  /** Short proposal synopsis from the brainstorm. */
  proposalSummary?: string | null;
  characterCount?: number;
  worldCount?: number;
  outlineCount?: number;
  run?: ReadyRunDetails;
  /** Approve the plan and begin writing immediately — no confirmation step. */
  onApprove: () => void;
  /** Secondary: open the Story Deck for review. */
  onReviewDeck?: () => void;
  /** Tertiary: go back and adjust the proposal. */
  onAdjustProposal?: () => void;
  approveDisabled?: boolean;
  /** True while the writing run is being prepared after approval. */
  busy?: boolean;
  labels?: ReadyCompletionCardLabels;
  className?: string;
}

export function ReadyCompletionCard({
  proposalSummary,
  characterCount = 0,
  worldCount = 0,
  outlineCount = 0,
  run,
  onApprove,
  onReviewDeck,
  onAdjustProposal,
  approveDisabled = false,
  busy = false,
  labels,
  className,
}: ReadyCompletionCardProps) {
  const { t } = useLanguage();

  const title = labels?.title ?? t.writingPreviewTitle;
  const counts = [
    { key: 'character', label: t.storyDeckCharacters, count: characterCount, Icon: BookUser },
    { key: 'world', label: t.storyDeckWorld, count: worldCount, Icon: Globe },
    { key: 'outline', label: t.storyDeckOutline, count: outlineCount, Icon: FileText },
  ];
  const runRows: Array<{ key: string; label: string; value: string }> = [];
  if (run?.targetWords) {
    runRows.push({
      key: 'target',
      label: labels?.targetLength ?? t.writingTargetLength,
      value: t.writingWordsCount.replace('{count}', run.targetWords.toLocaleString()),
    });
  }
  if (run?.planningModelLabel) {
    runRows.push({ key: 'planning', label: t.writingPreviewPlanningModel, value: run.planningModelLabel });
  }
  if (run?.draftingModelLabel) {
    runRows.push({ key: 'drafting', label: t.writingPreviewDraftModel, value: run.draftingModelLabel });
  }
  if (run?.estimatedTimeLabel) {
    runRows.push({ key: 'time', label: t.writingPreviewTimeLabel, value: run.estimatedTimeLabel });
  }
  if (run?.estimatedCostLabel) {
    runRows.push({ key: 'cost', label: t.writingPreviewCostLabel, value: run.estimatedCostLabel });
  }

  return (
    <section
      aria-label={title}
      className={`border border-book-border bg-book-bg-card p-5 shadow-sm md:p-6 ${className ?? ''}`}
    >
      <h3 className="font-serif text-lg font-semibold text-book-ink-primary">{title}</h3>

      {proposalSummary?.trim() && (
        <p className="mt-2 text-sm leading-6 text-book-ink-secondary">
          {proposalSummary.trim()}
        </p>
      )}

      <ul className="mt-4 flex flex-wrap gap-2">
        {counts.map(({ key, label, count, Icon }) => (
          <li
            key={key}
            className="flex items-center gap-1.5 border border-book-border bg-book-bg-secondary px-2.5 py-1 text-xs font-medium text-book-ink-secondary"
          >
            <Icon className="h-3.5 w-3.5 text-book-gold-dark" aria-hidden />
            <span>{label}</span>
            <span className="tabular-nums text-book-ink-primary">{count}</span>
          </li>
        ))}
      </ul>

      {runRows.length > 0 && (
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-book-border pt-4 sm:grid-cols-2">
          {runRows.map(row => (
            <div key={row.key} className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-2xs font-semibold uppercase tracking-widest text-book-ink-muted">
                {row.label}
              </dt>
              <dd className="min-w-0 truncate text-xs font-medium text-book-ink-primary">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          variant="ink"
          type="button"
          onClick={onApprove}
          disabled={approveDisabled || busy}
          className="h-auto gap-2 px-4 py-2.5 text-sm font-medium shadow-sm"
        >
          <NibIcon className="h-4 w-4" />
          {t.approveStart}
        </Button>
        {onReviewDeck && (
          <Button
            variant="outline"
            type="button"
            onClick={onReviewDeck}
            className="h-auto px-4 py-2.5 text-sm font-medium"
          >
            {labels?.reviewDeck ?? t.storyDeckReviewAction}
          </Button>
        )}
        {onAdjustProposal && (
          <Button
            variant="ghost"
            type="button"
            onClick={onAdjustProposal}
            className="h-auto gap-1.5 px-3 py-2.5 text-xs font-medium text-book-ink-secondary"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            {labels?.adjustProposal ?? t.storyDeckAdjustAction}
          </Button>
        )}
      </div>
    </section>
  );
}
