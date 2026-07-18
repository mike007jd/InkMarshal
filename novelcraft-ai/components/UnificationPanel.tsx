'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { WritingModelStatusBar } from '@/components/WritingModelStatusBar';
import {
  UnificationPagerControls,
  useUnificationPager,
} from '@/components/studio/unification-pager';
import { buildAIRequestHeaders, consumeNdjsonStream } from '@/lib/streaming-client';
import type { UnificationEdit, UnificationReport } from '@/lib/db-types';

interface UnificationPanelProps {
  novelId: string;
  initialReport?: UnificationReport | null;
  /** Called when at least one edit was applied so the parent can refetch chapters. */
  onApplied?: () => void;
  /** Called when stage advances to 'completed' after all edits applied. */
  onComplete?: () => void;
}

interface ApplyResult {
  editId: string;
  status: 'applied' | 'skipped' | 'not_found' | 'conflict';
  reason?: string;
}

// Drives the whole_book_unification stage: kicks off the scan, lists edits with
// per-row severity + apply state, and lets the user apply selected/all.
export function UnificationPanel({ novelId, initialReport, onApplied, onComplete }: UnificationPanelProps) {
  const { t, locale } = useLanguage();
  const { toast } = useToast();
  const [report, setReport] = useState<UnificationReport | null>(initialReport ?? null);
  const [running, setRunning] = useState(false);
  const [scanProgress, setScanProgress] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resultByEdit, setResultByEdit] = useState<Record<string, ApplyResult>>({});
  const activeNovelRef = useRef(novelId);
  const runningRef = useRef(false);
  const applyingRef = useRef(false);

  useEffect(() => {
    activeNovelRef.current = novelId;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setReport(initialReport ?? null);
      setSelected(new Set());
      setResultByEdit({});
      setRunning(false);
      setApplying(false);
      setConfirmAllOpen(false);
      runningRef.current = false;
      applyingRef.current = false;
    });
    return () => {
      cancelled = true;
    };
  }, [novelId, initialReport]);

  const pendingEdits = useMemo(
    () => (report?.edits ?? []).filter(e => !e.applied && !e.skipped),
    [report?.edits],
  );
  const pendingMajorCount = useMemo(
    () => pendingEdits.filter(edit => edit.severity === 'major').length,
    [pendingEdits],
  );
  const pendingChapterCount = useMemo(
    () => new Set(pendingEdits.map(edit => edit.chapterNumber)).size,
    [pendingEdits],
  );

  const runScan = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const requestNovelId = novelId;
    setRunning(true);
    setScanProgress(null);
    try {
      const r = await fetch(`/api/novels/${novelId}/unify`, {
        method: 'POST',
        headers: await buildAIRequestHeaders(locale, 'unify'),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        if (activeNovelRef.current === requestNovelId) {
          toast(data.error || `HTTP ${r.status}`);
        }
        return;
      }
      await consumeNdjsonStream(r, {
        onEvent(evt) {
          if (evt.type === 'done' && evt.report) {
            if (activeNovelRef.current !== requestNovelId) return;
            const nextReport = evt.report as UnificationReport;
            setReport(nextReport);
            setResultByEdit({});
            setSelected(new Set());
            onComplete?.();
          } else if (evt.type === 'progress') {
            // The server streams per-batch progress (e.g. "Unification scan 2/5")
            // plus heartbeats; surface the message so a multi-minute whole-book
            // scan doesn't look frozen. Ignore heartbeats (no message).
            if (activeNovelRef.current !== requestNovelId) return;
            if (typeof evt.message === 'string' && evt.message) setScanProgress(evt.message);
          } else if (evt.type === 'error') {
            if (activeNovelRef.current !== requestNovelId) return;
            const detail = typeof evt.error === 'string' ? evt.error : null;
            toast(detail ?? 'Unification failed');
          }
        },
      });
    } catch (err) {
      if (activeNovelRef.current === requestNovelId) {
        toast(err instanceof Error ? err.message : 'Unification failed');
      }
    } finally {
      if (activeNovelRef.current === requestNovelId) {
        setRunning(false);
        setScanProgress(null);
      }
      runningRef.current = false;
    }
  }, [locale, novelId, onComplete, toast]);

  const apply = useCallback(async (mode: 'selected' | 'all' | 'skip-selected') => {
    if (applyingRef.current) return;
    if (!report) return;
    if ((mode === 'selected' || mode === 'skip-selected') && selected.size === 0) {
      toast(t.unificationApplySelected);
      return;
    }
    const requestNovelId = novelId;
    const body = mode === 'all'
      ? { applyAll: true }
      : mode === 'skip-selected'
        ? { skipIds: Array.from(selected) }
        : { editIds: Array.from(selected) };
    applyingRef.current = true;
    setApplying(true);
    try {
      const r = await fetch(`/api/novels/${requestNovelId}/unify/apply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (activeNovelRef.current !== requestNovelId) return;
      if (!r.ok) {
        toast(data.error || `HTTP ${r.status}`);
        return;
      }
      const map: Record<string, ApplyResult> = { ...resultByEdit };
      for (const result of (data.results as ApplyResult[]) ?? []) {
        map[result.editId] = result;
      }
      setResultByEdit(map);
      // Refresh local report flags using the latest applied state.
      setReport(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          edits: prev.edits.map(e => {
            const r2 = map[e.id];
            if (r2?.status === 'applied') return { ...e, applied: true, appliedAt: new Date().toISOString() };
            if (r2?.status === 'skipped') return { ...e, skipped: true, skippedAt: new Date().toISOString() };
            return e;
          }),
        };
      });
      setSelected(new Set());
      onApplied?.();
      onComplete?.();
    } catch (err) {
      if (activeNovelRef.current === requestNovelId) {
        toast(err instanceof Error ? err.message : 'Apply failed');
      }
    } finally {
      if (activeNovelRef.current === requestNovelId) setApplying(false);
      applyingRef.current = false;
    }
  }, [novelId, onApplied, onComplete, report, resultByEdit, selected, t.unificationApplySelected, toast]);

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    // Lives inside a right-docked floating panel that already supplies the
    // border/background/shadow — so this fills the panel height and owns a
    // single internal scroll region instead of being its own bordered card.
    <section className="flex h-full min-h-0 flex-col">
      <WritingModelStatusBar operation="unify" />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h3 className="font-serif text-lg text-book-ink-primary">{t.unificationTitle}</h3>
        <Button
          variant="unstyled"
          size="unstyled"
          type="button"
          onClick={runScan}
          disabled={running}
          className="border border-book-border bg-book-bg-secondary px-3 py-1 text-xs font-medium text-book-ink-primary transition hover:bg-book-bg-card disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? t.unificationRunning : t.unificationRun}
        </Button>
      </header>

      {!report && !running && (
        <p className="text-sm text-book-ink-secondary">{t.unificationNotRun}</p>
      )}

      {running && (
        <div className="mb-3 flex items-center gap-2 text-sm text-book-ink-secondary" role="status" aria-live="polite">
          <Spinner size="sm" />
          <span>{scanProgress || t.unificationScanning}</span>
        </div>
      )}

      {report && (
        // Dim + disable the prior report while a re-scan is in flight so the
        // stale edit list doesn't look interactive mid-rescan.
        <div className={running ? 'pointer-events-none opacity-50 transition-opacity' : 'transition-opacity'}>
          {report.summary && (
            <p className="mb-3 text-xs leading-relaxed text-book-ink-secondary">{report.summary}</p>
          )}

          {pendingEdits.length === 0 ? (
            <p className="text-sm text-book-ink-secondary">{t.unificationEmpty}</p>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2">
                <Button
                  variant="accent"
                  type="button"
                  onClick={() => apply('selected')}
                  disabled={applying || selected.size === 0}
                  className="h-auto px-3 py-1 text-xs font-semibold disabled:cursor-not-allowed"
                >
                  {t.unificationApplySelected} ({selected.size})
                </Button>
                <Button
                  variant="unstyled"
                  size="unstyled"
                  type="button"
                  onClick={() => setConfirmAllOpen(true)}
                  disabled={applying}
                  className="border border-book-border px-3 py-1 text-xs font-medium text-book-ink-primary transition hover:bg-book-bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t.unificationApplyAll}
                </Button>
                <Button
                  variant="unstyled"
                  size="unstyled"
                  type="button"
                  onClick={() => apply('skip-selected')}
                  disabled={applying || selected.size === 0}
                  className="border border-book-border px-3 py-1 text-xs font-medium text-book-ink-secondary transition hover:bg-book-bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t.unificationSkipSelected}
                </Button>
              </div>

              <UnificationEditList
                edits={report.edits}
                resultByEdit={resultByEdit}
                selected={selected}
                toggle={toggle}
                applying={applying}
                t={t}
              />
            </>
          )}
        </div>
      )}
      </div>

      <Dialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.unificationApplyAllConfirmTitle}</DialogTitle>
            <DialogDescription>
              {t.unificationApplyAllConfirmDescription
                .replace('{count}', String(pendingEdits.length))
                .replace('{chapters}', String(pendingChapterCount))
                .replace('{major}', String(pendingMajorCount))}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmAllOpen(false)}
            >
              {t.modelManagerCancel}
            </Button>
            <Button
              type="button"
              variant="accent"
              disabled={applying || pendingEdits.length === 0}
              onClick={() => {
                setConfirmAllOpen(false);
                void apply('all');
              }}
            >
              {t.unificationApplyAllConfirmAction.replace('{count}', String(pendingEdits.length))}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

interface UnificationEditListProps {
  edits: UnificationEdit[];
  resultByEdit: Record<string, ApplyResult>;
  selected: Set<string>;
  toggle: (id: string) => void;
  applying: boolean;
  t: ReturnType<typeof useLanguage>['t'];
}

function UnificationEditList({ edits, resultByEdit, selected, toggle, applying, t }: UnificationEditListProps) {
  const pager = useUnificationPager(edits, 20);
  const showing = t.unificationPagerShowing
    .replace('{start}', String(pager.start + 1))
    .replace('{end}', String(pager.end))
    .replace('{total}', String(pager.total));
  return (
    <>
      <ul className="space-y-2 pr-1">
        {pager.pageItems.map(edit => {
          const result = resultByEdit[edit.id];
          const isApplied = edit.applied || result?.status === 'applied';
          const isSkipped = edit.skipped || result?.status === 'skipped';
          const conflict = result?.status === 'conflict';
          const notFound = result?.status === 'not_found';
          return (
            <li
              key={edit.id}
              className={`rounded-xl border px-3 py-2 text-sm transition ${editRowClass({ isApplied, isSkipped, conflict, notFound })}`}
            >
              <div className="flex items-start gap-2">
                <Checkbox
                  checked={selected.has(edit.id)}
                  disabled={isApplied || isSkipped || applying}
                  onCheckedChange={() => toggle(edit.id)}
                  className="mt-0.5 cursor-pointer border-book-border bg-book-bg-card data-[state=checked]:border-book-gold data-[state=checked]:bg-book-gold data-[state=checked]:text-book-on-gold disabled:cursor-not-allowed"
                  aria-label={`${t.blueprintChapterLabel}${edit.chapterNumber}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs text-book-ink-secondary">
                      {t.blueprintChapterLabel}{edit.chapterNumber}
                    </span>
                    <SeverityBadge severity={edit.severity} t={t} />
                    {isApplied && (
                      <Badge variant="success">{t.unificationApplied}</Badge>
                    )}
                    {isSkipped && (
                      <Badge variant="muted">{t.unificationSkipped}</Badge>
                    )}
                    {conflict && (
                      <span className="text-2xs text-book-warning">
                        {t.unificationConflict}
                      </span>
                    )}
                    {notFound && (
                      <span className="text-2xs text-book-warning">
                        {t.unificationNotFound}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs italic text-book-ink-secondary">{edit.rationale}</p>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-book-danger-light p-2 text-xs text-book-danger">
                      {edit.original}
                    </pre>
                    <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-book-success-light p-2 text-xs text-book-success">
                      {edit.replacement}
                    </pre>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <UnificationPagerControls
        page={pager.page}
        pageCount={pager.pageCount}
        start={pager.start}
        end={pager.end}
        total={pager.total}
        isFirst={pager.isFirst}
        isLast={pager.isLast}
        onPrev={pager.prev}
        onNext={pager.next}
        labels={{
          previous: t.unificationPagerPrev,
          next: t.unificationPagerNext,
          showing: () => showing,
        }}
      />
    </>
  );
}

function editRowClass(state: { isApplied: boolean; isSkipped: boolean; conflict: boolean; notFound: boolean }): string {
  if (state.isApplied) return 'border-book-success-border bg-book-success-light/50';
  if (state.isSkipped) return 'border-book-border bg-book-bg-secondary/60';
  if (state.conflict || state.notFound) return 'border-book-warning-border bg-book-warning-light/60';
  return 'border-book-border/60 bg-book-bg-secondary/40';
}

function SeverityBadge({ severity, t }: { severity: UnificationEdit['severity']; t: ReturnType<typeof useLanguage>['t'] }) {
  return severity === 'major' ? (
    <Badge variant="danger">{t.unificationSeverityMajor}</Badge>
  ) : (
    <Badge variant="muted">{t.unificationSeverityMinor}</Badge>
  );
}
