'use client';

import { AlertCircle } from 'lucide-react';

import { ReadyCompletionCard, type ReadyRunDetails } from '@/components/ReadyCompletionCard';
import { useCapabilityBinding } from '@/components/WritingModelStatusBar';
import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import type { Novel } from '@/lib/db-types';
import { isOnDeviceRuntimeConnection } from '@/lib/model-supply/readiness';
import { resolvePricing } from '@/lib/pricing';

type DeckCounts = { character: number; world: number; outline: number };

function estimatedChapterWords(targetWords: number): number {
  const safeTarget = Number.isFinite(targetWords) && targetWords > 0 ? targetWords : 80_000;
  const wordsPerChapter = safeTarget <= 300_000 ? 5_000 : safeTarget <= 800_000 ? 4_000 : 3_500;
  const chapterCount = Math.max(8, Math.min(300, Math.round(safeTarget / wordsPerChapter)));
  return Math.max(800, Math.min(5_000, Math.round(safeTarget / chapterCount)));
}

function formatUsdRange(value: number): string {
  const format = (amount: number) => amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`;
  return `${format(value * 0.75)}–${format(value * 1.5)}`;
}

export function ProposalReviewPanel({
  novel,
  counts,
  coverageLoading,
  onApprove,
  onReviewDeck,
  onAdjustProposal,
  onCompleteDeck,
  busy,
}: {
  novel: Novel;
  counts: DeckCounts;
  coverageLoading: boolean;
  onApprove: () => void;
  onReviewDeck: () => void;
  onAdjustProposal: () => void;
  onCompleteDeck: () => void;
  busy: boolean;
}) {
  const { t, locale } = useLanguage();
  const planning = useCapabilityBinding('outline');
  const drafting = useCapabilityBinding('chapter');
  const complete = counts.character > 0 && counts.world > 0 && counts.outline > 0;

  if (!coverageLoading && !complete) {
    const missing = [
      counts.character === 0 ? t.storyDeckCharacters : null,
      counts.world === 0 ? t.storyDeckWorld : null,
      counts.outline === 0 ? t.storyDeckOutline : null,
    ].filter((value): value is string => Boolean(value));
    return (
      <section className="border border-book-danger-border bg-book-danger-light p-5 shadow-sm" role="status">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-book-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <h3 className="font-serif text-lg font-semibold text-book-ink-primary">{t.storyDeckIncompleteTitle}</h3>
            <p className="mt-1 text-sm leading-6 text-book-ink-secondary">
              {t.storyDeckIncompleteDescription.replace('{missing}', missing.join(' · '))}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="ink" type="button" onClick={onCompleteDeck}>
                {t.storyDeckCompleteAction}
              </Button>
              <Button variant="outline" type="button" onClick={onReviewDeck}>
                {t.storyDeckReviewAction}
              </Button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const bindings = [planning.resolved, drafting.resolved];
  const configured = bindings.every(item => item.binding && item.conn);
  const onDeviceCount = bindings.filter(item => item.conn && isOnDeviceRuntimeConnection(item.conn)).length;
  const chapterWords = estimatedChapterWords(novel.targetWords);
  const modelLabel = (resolved: typeof planning.resolved) => (
    resolved.binding && resolved.conn
      ? `${resolved.conn.label} · ${resolved.binding.modelId}`
      : t.writingPreviewModelPending
  );

  let costLabel = t.writingPreviewCostAfterSetup;
  if (configured && onDeviceCount === bindings.length) {
    costLabel = t.writingPreviewCostLocal;
  } else if (configured) {
    const tokenFactor = locale === 'en' ? 1.35 : 1.8;
    const usages = [
      { input: 8_000, output: 4_000 },
      { input: 12_000, output: Math.round(chapterWords * tokenFactor) },
    ];
    let total = 0;
    let unknown = false;
    bindings.forEach((item, index) => {
      if (!item.binding || !item.conn || isOnDeviceRuntimeConnection(item.conn)) return;
      const pricing = resolvePricing(item.conn.id, item.binding.modelId);
      if (!pricing) {
        unknown = true;
        return;
      }
      total += (usages[index].input / 1_000_000) * pricing.inputPerMTokUsd;
      total += (usages[index].output / 1_000_000) * pricing.outputPerMTokUsd;
    });
    costLabel = unknown
      ? t.writingPreviewCostUnknown
      : t.writingPreviewCostRange.replace('{range}', formatUsdRange(total));
  }

  const run: ReadyRunDetails = {
    targetWords: novel.targetWords,
    planningModelLabel: modelLabel(planning.resolved),
    draftingModelLabel: modelLabel(drafting.resolved),
    estimatedTimeLabel: !configured
      ? t.writingPreviewTimeAfterSetup
      : onDeviceCount === bindings.length
        ? t.writingPreviewTimeLocal
        : onDeviceCount > 0
          ? t.writingPreviewTimeMixed
          : t.writingPreviewTimeOnline,
    estimatedCostLabel: costLabel,
  };

  return (
    <ReadyCompletionCard
      proposalSummary={novel.storySummary}
      characterCount={counts.character}
      worldCount={counts.world}
      outlineCount={counts.outline}
      run={run}
      onApprove={onApprove}
      onReviewDeck={onReviewDeck}
      onAdjustProposal={onAdjustProposal}
      approveDisabled={coverageLoading || !complete}
      busy={busy}
      labels={{
        reviewDeck: t.storyDeckReviewAction,
        adjustProposal: t.storyDeckAdjustAction,
        targetLength: t.writingTargetLength,
      }}
      className="mx-auto w-full max-w-3xl"
    />
  );
}
