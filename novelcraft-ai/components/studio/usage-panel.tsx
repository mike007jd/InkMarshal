'use client';

// AI activity & cost panel. Self-contained client surface mounted at
// /desktop-studio/usage. Fetches the ai_runs aggregates from /api/usage and the
// novel list from /api/novels. On-device activity and online-provider billing
// are deliberately separate: local work is time/generations, never fake $0.
//
// i18n is shipped inline (en / zh-CN / zh-TW) rather than widening the shared
// i18n bag — the bag is co-edited by every Wave 2 writer in parallel, so a
// single self-contained analytics surface keeps its own copy to avoid merge
// churn (same convention as the command-center panel).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, RefreshCw, AlertTriangle, Coins, ChevronDown, Laptop, Cloud } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useLanguage } from '@/components/LanguageProvider';
import { usageCopy, type TimeWindow } from '@/components/studio/usage-panel-copy';

// ---- Payload mirrors (shapes returned by GET /api/usage) ----

interface AggregateRow {
  operation: string;
  modelId: string | null;
  providerId: string | null;
  connectionKind: string | null;
  runs: number;
  successes: number;
  failures: number;
  truncated: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgFirstTokenMs: number | null;
  avgDurationMs: number | null;
  estCostUsd: number;
  pricedRuns: number;
}

interface CostPerKWordRow {
  modelId: string | null;
  providerId: string | null;
  connectionKind: string | null;
  estCostUsd: number;
  acceptedWords: number;
  costPerKWord: number | null;
  hasUnpricedRuns: boolean;
}

interface UsagePayload {
  window: TimeWindow;
  novelId: string | null;
  aggregate: AggregateRow[];
  costPerKWord: CostPerKWordRow[];
}

interface NovelLite {
  id: string;
  title: string;
}

const ALL_NOVELS = '__all__';
const WINDOWS: TimeWindow[] = ['7d', '30d', 'all'];

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtDuration(ms: number): string {
  if (ms < 1_000) return '<1s';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

/** Format an online-provider cost scalar. Unpriced rows show the unknown label. */
function fmtCost(usd: number, pricedRuns: number, unknownLabel: string): string {
  if (pricedRuns === 0) return unknownLabel;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(2)}`;
}

function fmtCostPerKWord(row: CostPerKWordRow, unknownLabel: string): string {
  if (row.costPerKWord == null) return unknownLabel;
  if (row.costPerKWord === 0) return '$0.00';
  if (row.costPerKWord < 0.01) return '<$0.01';
  return `$${row.costPerKWord.toFixed(2)}`;
}

function rate(part: number, total: number): string {
  if (total === 0) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

export function UsagePanel() {
  const { locale } = useLanguage();
  const t = useMemo(() => usageCopy(locale), [locale]);

  const [novels, setNovels] = useState<NovelLite[]>([]);
  const [novelId, setNovelId] = useState<string>(ALL_NOVELS);
  const [window, setWindow] = useState<TimeWindow>('30d');
  const [data, setData] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/novels');
        if (!res.ok) return;
        const list = (await res.json()) as NovelLite[];
        if (!cancelled) setNovels(list.map(n => ({ id: n.id, title: n.title })));
      } catch {
        // Non-fatal: the panel still works scoped to "all novels".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ window });
      if (novelId !== ALL_NOVELS) params.set('novelId', novelId);
      const res = await fetch(`/api/usage?${params.toString()}`);
      if (!res.ok) throw new Error(String(res.status));
      const payload = (await res.json()) as UsagePayload;
      setData(payload);
    } catch {
      setError(t.loadError);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [novelId, window, t.loadError]);

  useEffect(() => {
    // queueMicrotask so the synchronous setLoading(true) inside load() doesn't
    // run directly in the effect body (set-state-in-effect) — same pattern as
    // the command-center panel.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const aggregate = useMemo(() => data?.aggregate ?? [], [data]);
  const hasData = (data?.aggregate.length ?? 0) > 0 || (data?.costPerKWord.length ?? 0) > 0;

  const usageSummary = useMemo(() => {
    const localRows = aggregate.filter(row => row.connectionKind === 'local');
    const onlineRows = aggregate.filter(row => row.connectionKind !== 'local');
    const summarize = (rows: AggregateRow[]) => ({
      runs: rows.reduce((sum, row) => sum + row.runs, 0),
      models: new Set(rows.map(row => row.modelId).filter(Boolean)).size,
    });
    const local = summarize(localRows);
    const online = summarize(onlineRows);
    return {
      local: {
        ...local,
        computeMs: localRows.reduce(
          (sum, row) => sum + (row.avgDurationMs == null ? 0 : row.avgDurationMs * row.runs),
          0,
        ),
      },
      online: {
        ...online,
        cost: onlineRows.reduce((sum, row) => sum + row.estCostUsd, 0),
        pricedRuns: onlineRows.reduce((sum, row) => sum + row.pricedRuns, 0),
      },
    };
  }, [aggregate]);

  // Only online providers belong in the cost comparison. A local generation
  // has compute value, but ranking its provider cost as "$0 / best value" is a
  // category error that obscures device time and model quality.
  const rankedCostRows = useMemo(() => {
    return (data?.costPerKWord ?? []).filter(row => row.connectionKind !== 'local').sort((a, b) => {
      const av = a.costPerKWord;
      const bv = b.costPerKWord;
      if (av == null && bv == null) return b.acceptedWords - a.acceptedWords;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    });
  }, [data]);
  const bestValueIndex = rankedCostRows.findIndex(
    row => row.costPerKWord != null && !row.hasUnpricedRuns,
  );

  const operationLabel = useCallback((op: string) => t.operations[op] ?? op, [t.operations]);
  const kindLabel = useCallback(
    (kind: string | null) => (kind ? t.kinds[kind] ?? kind : t.kinds.unknown),
    [t.kinds],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-book-bg-primary">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3 border-b border-book-border px-6 py-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-book-gold" aria-hidden />
          <h1 className="text-lg font-semibold text-book-ink-primary">{t.title}</h1>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select value={novelId} onValueChange={setNovelId}>
            <SelectTrigger className="h-9 w-52" aria-label={t.novelSelectLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_NOVELS}>{t.allNovels}</SelectItem>
              {novels.map(n => (
                <SelectItem key={n.id} value={n.id}>
                  {n.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <ToggleGroup
            type="single"
            value={window}
            onValueChange={value => {
              if (value) setWindow(value as TimeWindow);
            }}
            variant="outline"
            aria-label={t.windowLabel}
          >
            {WINDOWS.map(w => (
              <ToggleGroupItem key={w} value={w} className="h-9">
                {t.windows[w]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw className="size-4" />}
            {t.refresh}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-book-danger-border bg-book-danger-light px-4 py-3 text-sm text-book-danger">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </div>
        )}

        {!error && !loading && !hasData && (
          <Empty className="mt-10 border-0 p-0 md:p-0">
            <EmptyHeader>
              <EmptyMedia>
                <BarChart3 className="h-8 w-8 text-book-ink-muted" aria-hidden />
              </EmptyMedia>
              <EmptyDescription className="text-sm text-book-ink-secondary">
                {t.empty}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {hasData && (
          <div className="flex flex-col gap-6">
            <section>
              <div className="mb-2 flex items-center gap-2">
                <Laptop className="h-4 w-4 text-book-gold" aria-hidden />
                <h2 className="text-sm font-semibold text-book-ink-primary">
                  {t.localTitle}
                </h2>
              </div>
              <p className="mb-3 text-xs text-book-ink-muted">{t.localHint}</p>
              {usageSummary.local.runs === 0 ? (
                <div className="rounded-md border border-book-border bg-book-bg-card px-4 py-3 text-sm text-book-ink-muted">
                  {t.noLocalUsage}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    [t.localRuns, fmtInt(usageSummary.local.runs)],
                    [t.localComputeTime, fmtDuration(usageSummary.local.computeMs)],
                    [t.localModels, fmtInt(usageSummary.local.models)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-book-border bg-book-bg-card p-4">
                      <div className="text-xs text-book-ink-muted">{label}</div>
                      <div className="mt-1 text-2xl font-semibold tabular-nums text-book-ink-primary">{value}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="mb-2 flex items-center gap-2">
                <Cloud className="h-4 w-4 text-book-gold" aria-hidden />
                <h2 className="text-sm font-semibold text-book-ink-primary">
                  {t.onlineTitle}
                </h2>
              </div>
              <p className="mb-3 text-xs text-book-ink-muted">{t.onlineHint}</p>
              {usageSummary.online.runs === 0 ? (
                <div className="rounded-md border border-book-border bg-book-bg-card px-4 py-3 text-sm text-book-ink-muted">
                  {t.noOnlineUsage}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-book-border bg-book-bg-card p-4">
                    <div className="text-xs text-book-ink-muted">{t.onlineSpend}</div>
                    <div className="mt-1 flex items-center gap-2 text-2xl font-semibold tabular-nums text-book-ink-primary">
                      {fmtCost(usageSummary.online.cost, usageSummary.online.pricedRuns, t.unknown)}
                      {usageSummary.online.pricedRuns < usageSummary.online.runs && (
                        <Badge variant="muted">{t.partialPrice}</Badge>
                      )}
                    </div>
                  </div>
                  {[
                    [t.onlineCalls, fmtInt(usageSummary.online.runs)],
                    [t.onlineModels, fmtInt(usageSummary.online.models)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-book-border bg-book-bg-card p-4">
                      <div className="text-xs text-book-ink-muted">{label}</div>
                      <div className="mt-1 text-2xl font-semibold tabular-nums text-book-ink-primary">{value}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {usageSummary.online.runs > 0 && (
            <section>
              <div className="mb-2 flex items-center gap-2">
                <Coins className="h-4 w-4 text-book-gold" aria-hidden />
                <h2 className="text-sm font-semibold text-book-ink-primary">
                  {t.costPerKWordTitle}
                </h2>
              </div>
              <p className="mb-3 text-xs text-book-ink-muted">{t.costPerKWordHint}</p>

              {rankedCostRows.length === 0 ? (
                <div className="rounded-md border border-book-border bg-book-bg-card px-4 py-3 text-sm text-book-ink-muted">
                  {t.noAcceptedYet}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {rankedCostRows.map((row, i) => (
                    <div
                      key={`${row.modelId}-${row.providerId}-${i}`}
                      className={`rounded-lg border bg-book-bg-card p-4 ${
                        i === bestValueIndex
                          ? 'border-book-gold ring-1 ring-book-gold'
                          : 'border-book-border'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-sm font-medium text-book-ink-primary">
                          {row.modelId ?? t.unknownModel}
                        </span>
                        {i === bestValueIndex && <Badge variant="gold">{t.bestValue}</Badge>}
                      </div>
                      <div className="mt-2 flex items-baseline gap-1.5">
                        <span className="text-2xl font-semibold tabular-nums text-book-ink-primary">
                          {fmtCostPerKWord(row, t.unknown)}
                        </span>
                        <span className="text-xs text-book-ink-muted">{t.perKWord}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-book-ink-muted">
                        <span>{kindLabel(row.connectionKind)}</span>
                        <span>
                          {fmtInt(row.acceptedWords)} {t.acceptedWordsUnit}
                        </span>
                        {row.hasUnpricedRuns && (
                          <Badge variant="muted">{t.partialPrice}</Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
            )}

            {/* Engineering metrics stay available without competing with the
                writer-facing cost overview. */}
            <Collapsible className="rounded-lg border border-book-border bg-book-bg-card p-4">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className="group h-auto w-full justify-between px-0 py-0 hover:bg-transparent">
                  <span className="text-sm font-semibold text-book-ink-primary">
                    {t.advancedDiagnostics}
                  </span>
                  <ChevronDown className="h-4 w-4 text-book-ink-muted transition-transform group-data-[state=open]:rotate-180" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
              <h2 className="mb-3 text-xs font-semibold text-book-ink-muted">
                {t.breakdownTitle}
              </h2>
              {aggregate.length === 0 ? (
                <div className="rounded-md border border-book-border bg-book-bg-card px-4 py-3 text-sm text-book-ink-muted">
                  {t.empty}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-book-border">
                  <table className="w-full min-w-[820px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-book-border bg-book-bg-secondary text-left text-xs text-book-ink-secondary">
                        <th className="px-3 py-2 font-medium">{t.colOperation}</th>
                        <th className="px-3 py-2 font-medium">{t.colModel}</th>
                        <th className="px-3 py-2 text-right font-medium">{t.colRuns}</th>
                        <th className="px-3 py-2 text-right font-medium">{t.colSuccess}</th>
                        <th className="px-3 py-2 text-right font-medium">{t.colFailTrunc}</th>
                        <th className="px-3 py-2 text-right font-medium">{t.colTokens}</th>
                        <th className="px-3 py-2 text-right font-medium">{t.colFirstToken}</th>
                        <th className="px-3 py-2 text-right font-medium">{t.colDuration}</th>
                        <th className="px-3 py-2 text-right font-medium">{t.colCost}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aggregate.map((row, i) => (
                        <tr
                          key={`${row.operation}-${row.modelId}-${row.providerId}-${i}`}
                          className="border-b border-book-border-light last:border-b-0"
                        >
                          <td className="px-3 py-2">
                            <Badge variant="book">{operationLabel(row.operation)}</Badge>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-mono text-xs text-book-ink-primary">
                              {row.modelId ?? t.unknownModel}
                            </div>
                            <div className="text-xs text-book-ink-muted">
                              {kindLabel(row.connectionKind)}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-book-ink-secondary">
                            {fmtInt(row.runs)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-book-ink-secondary">
                            {rate(row.successes, row.runs)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-book-ink-secondary">
                            {row.failures + row.truncated + row.cancelled > 0 ? (
                              <span className="text-book-danger">
                                {rate(row.failures + row.truncated + row.cancelled, row.runs)}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-book-ink-secondary">
                            {fmtInt(row.totalTokens)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-book-ink-secondary">
                            {fmtMs(row.avgFirstTokenMs)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-book-ink-secondary">
                            {fmtMs(row.avgDurationMs)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-book-ink-primary">
                            {row.connectionKind === 'local'
                              ? t.notApplicable
                              : fmtCost(row.estCostUsd, row.pricedRuns, t.unknown)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-xs text-book-ink-muted">{t.costNote}</p>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </div>
    </div>
  );
}
