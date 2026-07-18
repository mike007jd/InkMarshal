'use client';

import { Clock3, Cpu, FileText, WalletCards } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { useCapabilityBinding } from '@/components/WritingModelStatusBar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isOnDeviceRuntimeConnection } from '@/lib/model-supply/readiness';
import { resolvePricing } from '@/lib/pricing';

function estimatedChapterWords(targetWords: number): number {
  const safeTarget = Number.isFinite(targetWords) && targetWords > 0 ? targetWords : 80_000;
  const wordsPerChapter = safeTarget <= 300_000 ? 5_000 : safeTarget <= 800_000 ? 4_000 : 3_500;
  const chapterCount = Math.max(8, Math.min(300, Math.round(safeTarget / wordsPerChapter)));
  return Math.max(800, Math.min(5_000, Math.round(safeTarget / chapterCount)));
}

function formatUsdRange(value: number): string {
  const low = value * 0.75;
  const high = value * 1.5;
  const format = (amount: number) => amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`;
  return `${format(low)}–${format(high)}`;
}

export function WritingStartPreviewDialog({
  open,
  targetWords,
  onOpenChange,
  onStart,
}: {
  open: boolean;
  targetWords: number;
  onOpenChange: (open: boolean) => void;
  onStart: () => void;
}) {
  const { t, locale } = useLanguage();
  const planning = useCapabilityBinding('outline');
  const drafting = useCapabilityBinding('chapter');
  const chapterWords = estimatedChapterWords(targetWords);

  const bindings = [planning.resolved, drafting.resolved];
  const configured = bindings.every(item => item.binding && item.conn);
  const onDeviceCount = bindings.filter(item => item.conn && isOnDeviceRuntimeConnection(item.conn)).length;
  const timeLabel = !configured
    ? t.writingPreviewTimeAfterSetup
    : onDeviceCount === bindings.length
      ? t.writingPreviewTimeLocal
      : onDeviceCount > 0
        ? t.writingPreviewTimeMixed
        : t.writingPreviewTimeOnline;

  let costLabel = t.writingPreviewCostAfterSetup;
  if (configured && onDeviceCount === bindings.length) {
    costLabel = t.writingPreviewCostLocal;
  } else if (configured) {
    const tokenFactor = locale === 'en' ? 1.35 : 1.8;
    const estimatedUsage = [
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
      const usage = estimatedUsage[index];
      total += (usage.input / 1_000_000) * pricing.inputPerMTokUsd;
      total += (usage.output / 1_000_000) * pricing.outputPerMTokUsd;
    });
    costLabel = unknown
      ? t.writingPreviewCostUnknown
      : t.writingPreviewCostRange.replace('{range}', formatUsdRange(total));
  }

  const bindingLabel = (resolved: typeof planning.resolved) => (
    resolved.binding && resolved.conn
      ? `${resolved.conn.label} · ${resolved.binding.modelId}`
      : t.writingPreviewModelPending
  );

  const start = () => {
    onOpenChange(false);
    onStart();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">{t.writingPreviewTitle}</DialogTitle>
          <DialogDescription className="leading-relaxed text-book-ink-secondary">
            {t.writingPreviewDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          <PreviewRow
            icon={<FileText className="h-4 w-4" />}
            label={t.writingPreviewScopeLabel}
            value={t.writingPreviewScope.replace('{words}', chapterWords.toLocaleString(locale))}
          />
          <PreviewRow
            icon={<Cpu className="h-4 w-4" />}
            label={t.writingPreviewModelsLabel}
            value={`${t.writingPreviewPlanningModel}: ${bindingLabel(planning.resolved)}\n${t.writingPreviewDraftModel}: ${bindingLabel(drafting.resolved)}`}
          />
          <PreviewRow icon={<Clock3 className="h-4 w-4" />} label={t.writingPreviewTimeLabel} value={timeLabel} />
          <PreviewRow icon={<WalletCards className="h-4 w-4" />} label={t.writingPreviewCostLabel} value={costLabel} />
        </div>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button variant="ink" type="button" onClick={start}>
            {t.writingPreviewStart}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex gap-3 rounded-lg border border-book-border bg-book-bg-secondary/60 px-3 py-2.5">
      <span className="mt-0.5 text-book-gold-dark" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-book-ink-secondary">{label}</div>
        <div className="mt-0.5 whitespace-pre-line text-sm leading-relaxed text-book-ink-primary">{value}</div>
      </div>
    </div>
  );
}
