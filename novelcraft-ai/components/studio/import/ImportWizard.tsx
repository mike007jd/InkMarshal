'use client';

// ImportWizard — the modal that walks an author through bringing an
// existing manuscript into the studio:
//
//   pick (native stage) → open session (server) → preview & correct
//        → confirm (compact refs) → optional background KB extract.
//
// Full prose never leaves the server session; the wizard only holds bounded
// previews + reconstruction `parts`. i18n is the self-contained `importCopy`
// table.

import { useCallback, useMemo, useRef, useState } from 'react';
import { FileUp, AlertTriangle } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isTauriRuntime, stageManuscriptImport } from '@/lib/desktop-runtime';
import { buildAIRequestHeaders } from '@/lib/streaming-client';
import {
  openImportSessionAction,
  confirmImportSessionAction,
} from '@/app/actions/import';
import { renumberPreviewChapters } from '@/lib/import/preview';
import { ChapterSplitEditor } from '@/components/studio/import/ChapterSplitEditor';
import { importCopy } from '@/components/studio/import/import-copy';
import type {
  DedupeAction,
  DedupeResult,
  ImportPreviewChapter,
} from '@/lib/import/types';

interface NovelOption {
  id: string;
  title: string;
}

interface ImportWizardProps {
  open: boolean;
  onClose: () => void;
  /** Existing novels (for the merge target picker). */
  novels: NovelOption[];
  /** Called after a successful import with the resulting novel id. */
  onImported: (novelId: string) => void;
  /** Pre-selected merge target (when launched from a novel's "…" menu). */
  initialTargetNovelId?: string;
}

type Step = 'pick' | 'preview';

/**
 * Merge dedupe is a real state machine — never undefined ambiguity:
 *
 *   idle    — new-import mode, or nothing to check yet. Confirm is free.
 *   loading — a report request is in flight for `fingerprint`.
 *   ready   — a complete report for `fingerprint` is in hand; decisions exist.
 *   stale   — candidates/target changed after the last check; decisions were
 *             discarded and the user must re-check before merging.
 *   error   — the request failed; localized message + retry control shown.
 *
 * `fingerprint` binds a report to the exact target + candidate set it was
 * computed from, so a stale async response can never satisfy a newer set.
 */
type DedupeState =
  | { status: 'idle' }
  | { status: 'loading'; fingerprint: string }
  | { status: 'ready'; fingerprint: string; report: DedupeResult[] }
  | { status: 'stale' }
  | { status: 'error' };

/** Bind a dedupe report to the exact target + candidate set it describes. */
function dedupeFingerprint(targetNovelId: string, chapters: ImportPreviewChapter[]): string {
  return JSON.stringify([
    targetNovelId,
    chapters.map(c => [c.id, c.chapterNumber, c.title, c.wordCount, c.parts]),
  ]);
}

export function ImportWizard(props: ImportWizardProps) {
  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      {props.open && <ImportWizardBody {...props} />}
    </Dialog>
  );
}

function ImportWizardBody({
  onClose,
  novels,
  onImported,
  initialTargetNovelId,
}: ImportWizardProps) {
  const { locale } = useLanguage();
  const { toast } = useToast();
  const copy = useMemo(() => importCopy(locale), [locale]);

  const [step, setStep] = useState<Step>('pick');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kbEnabled, setKbEnabled] = useState(true);

  const [sessionToken, setSessionToken] = useState('');
  const [novelTitle, setNovelTitle] = useState('');
  const [chapters, setChapters] = useState<ImportPreviewChapter[]>([]);
  const [dedupeState, setDedupeState] = useState<DedupeState>({ status: 'idle' });
  const [actions, setActions] = useState<Record<string, DedupeAction>>({});
  // Monotonic request id: a late response from an older target/candidate set
  // sees a stale seq and is discarded instead of overwriting current state.
  const dedupeSeqRef = useRef(0);

  const hasNovels = novels.length > 0;
  const [mode, setMode] = useState<'new' | 'merge'>(
    initialTargetNovelId && hasNovels ? 'merge' : 'new',
  );
  const [targetNovelId, setTargetNovelId] = useState<string>(
    initialTargetNovelId ?? novels[0]?.id ?? '',
  );

  const totalWords = useMemo(
    () => chapters.reduce((sum, c) => sum + c.wordCount, 0),
    [chapters],
  );
  const currentFingerprint = useMemo(
    () => dedupeFingerprint(targetNovelId, chapters),
    [targetNovelId, chapters],
  );
  // The merge confirm is gated on a COMPLETE report for the exact target +
  // candidate set currently on screen — nothing older, nothing partial.
  const dedupeReady =
    dedupeState.status === 'ready' && dedupeState.fingerprint === currentFingerprint;
  const dedupeReport = dedupeReady ? dedupeState.report : undefined;
  const conflictCount = useMemo(
    () => (dedupeReport ?? []).filter(d => d.status === 'conflict').length,
    [dedupeReport],
  );
  const duplicateOverwriteTargets = useMemo(() => {
    const counts = new Map<number, number>();
    for (const decision of dedupeReport ?? []) {
      if (
        decision.matchedChapterNumber !== null
        && (actions[decision.candidateId] ?? decision.defaultAction) === 'overwrite'
      ) {
        counts.set(
          decision.matchedChapterNumber,
          (counts.get(decision.matchedChapterNumber) ?? 0) + 1,
        );
      }
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([chapterNumber]) => chapterNumber)
      .sort((a, b) => a - b);
  }, [actions, dedupeReport]);

  // Recompute the merge dedupe report against `targetId` via compact parts +
  // session token (server reconstructs prose). Driven from mode/target change
  // handlers (not an effect) so the network round-trip is an explicit user
  // action, never a render side effect.
  const runDedupe = useCallback(
    async (targetId: string, reportChapters: ImportPreviewChapter[], token: string) => {
      if (!targetId || reportChapters.length === 0 || !token) return;
      const fingerprint = dedupeFingerprint(targetId, reportChapters);
      const seq = ++dedupeSeqRef.current;
      setDedupeState({ status: 'loading', fingerprint });
      try {
        const report = await fetchDedupeReport(targetId, token, reportChapters);
        if (dedupeSeqRef.current !== seq) return; // superseded by a newer request
        setDedupeState({ status: 'ready', fingerprint, report });
        const nextActions: Record<string, DedupeAction> = {};
        for (const d of report) nextActions[d.candidateId] = d.defaultAction;
        setActions(nextActions);
      } catch {
        if (dedupeSeqRef.current !== seq) return;
        setDedupeState({ status: 'error' });
      }
    },
    [],
  );

  const selectMode = (nextMode: 'new' | 'merge') => {
    setMode(nextMode);
    if (nextMode === 'merge') {
      if (targetNovelId) void runDedupe(targetNovelId, chapters, sessionToken);
    } else {
      // New-import mode needs no report; discard any merge decisions so they
      // can never leak into a later confirm.
      dedupeSeqRef.current += 1;
      setDedupeState({ status: 'idle' });
      setActions({});
    }
  };

  const selectTarget = (nextTarget: string) => {
    setTargetNovelId(nextTarget);
    if (mode === 'merge') {
      setActions({});
      if (nextTarget) void runDedupe(nextTarget, chapters, sessionToken);
      else {
        dedupeSeqRef.current += 1;
        setDedupeState({ status: 'idle' });
      }
    }
  };

  // Any chapter edit (title, merge, split — renumbering included) invalidates
  // the report computed for the old set: decisions are dropped and the merge
  // confirm stays locked until the user re-checks.
  const handleChaptersChange = (next: ImportPreviewChapter[]) => {
    const renumbered = renumberPreviewChapters(next);
    setChapters(renumbered);
    if (mode === 'merge') {
      dedupeSeqRef.current += 1;
      setDedupeState(prev => (prev.status === 'idle' ? prev : { status: 'stale' }));
      setActions({});
    }
  };

  const handlePick = async () => {
    if (!isTauriRuntime()) {
      setError(copy.desktopOnly);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const staged = await stageManuscriptImport();
      if (!staged) return; // user dismissed the dialog
      const result = await openImportSessionAction({
        token: staged.token,
        basename: staged.basename,
      });
      setSessionToken(result.sessionToken);
      setNovelTitle(result.suggestedTitle);
      setChapters(result.chapters);
      setStep('preview');
      // Launched against a specific novel (from its "…" menu): run the merge
      // dedupe immediately so the preview opens with the report populated.
      if (mode === 'merge' && targetNovelId) {
        void runDedupe(targetNovelId, result.chapters, result.sessionToken);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.parseFailed);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (busy) return;
    // Fail closed: merge confirm requires a complete, current dedupe report.
    if (
      mode === 'merge'
      && (!targetNovelId || !dedupeReport || duplicateOverwriteTargets.length > 0)
    ) return;
    if (!sessionToken) return;
    setBusy(true);
    setError(null);

    const runKb = kbEnabled;

    try {
      const result = await confirmImportSessionAction({
        sessionToken,
        mode,
        targetNovelId: mode === 'merge' ? targetNovelId : undefined,
        novelTitle: novelTitle.trim() || copy.novelTitlePlaceholder,
        chapters: chapters.map(c => ({
          title: c.title,
          parts: c.parts,
        })),
        dedupeDecisions:
          mode === 'merge'
            ? // Exactly one decision per current chapter, from the report
              // whose fingerprint matches the chapter set being submitted.
              dedupeReport!.map(d => {
                const cand = chapters.find(c => c.id === d.candidateId);
                return {
                  chapterNumber: cand?.chapterNumber ?? 0,
                  action: actions[d.candidateId] ?? d.defaultAction,
                  matchedChapterNumber: d.matchedChapterNumber,
                };
              })
            : undefined,
        runKbExtraction: runKb,
      });

      toast(copy.importedToast(result.importedChapters), 'success');
      onImported(result.novelId);
      onClose();

      // Fire-and-forget KB extraction — never blocks navigation. Progress is
      // surfaced via toasts.
      if (runKb) void runKbExtraction(result.novelId, locale, copy, toast);
    } catch {
      setError(copy.importFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="max-h-[85vh] w-full max-w-2xl overflow-hidden">
      <DialogHeader>
        <DialogTitle className="font-serif text-xl">{copy.dialogTitle}</DialogTitle>
        {step === 'pick' && (
          <DialogDescription className="text-book-ink-secondary leading-relaxed">
            {copy.pickBody}
          </DialogDescription>
        )}
        {step === 'preview' && (
          <DialogDescription className="text-book-ink-secondary">
            {copy.previewHeading(chapters.length, totalWords)}
          </DialogDescription>
        )}
      </DialogHeader>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-book-danger-border bg-book-danger-light px-3 py-2 text-sm text-book-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {step === 'pick' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="rounded-full bg-book-bg-secondary p-4 text-book-ink-muted">
            <FileUp className="h-8 w-8" />
          </div>
          <h3 className="font-serif text-lg text-book-ink-primary">{copy.pickHeading}</h3>
          <Button
            variant="accent"
            type="button"
            onClick={handlePick}
            disabled={busy}
            className="h-auto px-5 py-2"
          >
            {busy ? <Spinner /> : <FileUp className="h-4 w-4" />}
            {busy ? copy.parsing : copy.pickButton}
          </Button>
          <p className="text-xs text-book-ink-muted">{copy.pickHint}</p>
        </div>
      )}

      {step === 'preview' && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-book-ink-secondary">{copy.novelTitleLabel}</span>
              <Input
                variant="boxed"
                type="text"
                value={novelTitle}
                onChange={e => setNovelTitle(e.target.value)}
                placeholder={copy.novelTitlePlaceholder}
                disabled={mode === 'merge'}
                className="mt-1 w-full text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-book-ink-secondary">{copy.modeLabel}</span>
              <Select
                value={mode}
                onValueChange={(v) => selectMode(v as 'new' | 'merge')}
              >
                <SelectTrigger variant="boxed" className="mt-1 w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">{copy.modeNew}</SelectItem>
                  <SelectItem value="merge" disabled={!hasNovels}>{copy.modeMerge}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          {mode === 'merge' && (
            <label className="block">
              <span className="text-xs font-medium text-book-ink-secondary">{copy.mergeTargetLabel}</span>
              <Select value={targetNovelId} onValueChange={selectTarget}>
                <SelectTrigger variant="boxed" className="mt-1 w-full text-sm">
                  <SelectValue placeholder={copy.mergeTargetPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {novels.map(n => (
                    <SelectItem key={n.id} value={n.id}>{n.title || copy.novelTitlePlaceholder}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {mode === 'merge' && dedupeState.status === 'loading' && (
            <div
              className="flex items-center gap-2 rounded-md border border-book-border bg-book-bg-card px-3 py-2 text-xs text-book-ink-muted"
              role="status"
            >
              <Spinner />
              <span>{copy.dedupeChecking}</span>
            </div>
          )}

          {mode === 'merge' && dedupeState.status === 'error' && (
            <div
              className="flex items-start gap-2 rounded-md border border-book-danger-border bg-book-danger-light px-3 py-2 text-xs text-book-danger"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{copy.dedupeFailed}</span>
              <Button
                variant="ghost"
                type="button"
                onClick={() => void runDedupe(targetNovelId, chapters, sessionToken)}
                disabled={busy}
                className="h-auto shrink-0 border border-book-danger-border bg-book-bg-card px-2 py-1 text-xs"
              >
                {copy.dedupeRetry}
              </Button>
            </div>
          )}

          {mode === 'merge' && dedupeState.status === 'stale' && (
            <div
              className="flex items-start gap-2 rounded-md border border-book-warning-border bg-book-warning-light px-3 py-2 text-xs text-book-stage-writing"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{copy.dedupeStale}</span>
              <Button
                variant="ghost"
                type="button"
                onClick={() => void runDedupe(targetNovelId, chapters, sessionToken)}
                disabled={busy}
                className="h-auto shrink-0 border border-book-warning-border bg-book-bg-card px-2 py-1 text-xs"
              >
                {copy.dedupeRecheck}
              </Button>
            </div>
          )}

          {mode === 'merge' && conflictCount > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-book-warning-border bg-book-warning-light px-3 py-2 text-xs text-book-stage-writing">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{copy.conflictWarning(conflictCount)}</span>
            </div>
          )}

          {mode === 'merge' && duplicateOverwriteTargets.length > 0 && (
            <div
              className="flex items-start gap-2 rounded-md border border-book-danger-border bg-book-danger-light px-3 py-2 text-xs text-book-danger"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{copy.duplicateOverwriteTargets(duplicateOverwriteTargets)}</span>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <ChapterSplitEditor
              chapters={chapters}
              onChange={handleChaptersChange}
              dedupe={mode === 'merge' ? dedupeReport : undefined}
              actions={actions}
              onActionChange={(id, action) =>
                setActions(prev => ({ ...prev, [id]: action }))
              }
              copy={copy}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-book-border bg-book-bg-card px-3 py-2">
            <Checkbox
              checked={kbEnabled}
              onCheckedChange={(value) => setKbEnabled(value === true)}
              className="mt-0.5 shrink-0"
            />
            <span className="min-w-0">
              <span className="block text-sm text-book-ink-primary">{copy.runKbLabel}</span>
              <span className="block text-xs text-book-ink-muted">{copy.runKbHint}</span>
            </span>
          </label>
        </div>
      )}

      <DialogFooter className="border-t border-book-border pt-3">
        {step === 'preview' && (
          <Button
            variant="ghost"
            type="button"
            onClick={() => { setStep('pick'); setError(null); }}
            disabled={busy}
            className="h-auto border border-book-border bg-book-bg-card px-4 py-2 text-sm"
          >
            {copy.back}
          </Button>
        )}
        <Button
          variant="ghost"
          type="button"
          onClick={onClose}
          disabled={busy}
          className="h-auto border border-book-border bg-book-bg-card px-4 py-2 text-sm"
        >
          {copy.cancel}
        </Button>
        {step === 'preview' && (
          <Button
            variant="ink"
            type="button"
            onClick={handleConfirm}
            disabled={
              busy
              || (
                mode === 'merge'
                && (!targetNovelId || !dedupeReady || duplicateOverwriteTargets.length > 0)
              )
            }
            className="h-auto px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Spinner /> : null}
            {busy ? copy.importing : mode === 'merge' ? copy.confirmMerge : copy.confirmNew}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Recompute the dedupe report for the current compact chapter refs against a
 * target novel. The server reconstructs exact prose from the opaque session.
 */
async function fetchDedupeReport(
  targetNovelId: string,
  sessionToken: string,
  chapters: ImportPreviewChapter[],
): Promise<DedupeResult[]> {
  const res = await fetch(`/api/novels/${targetNovelId}/import/dedupe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionToken,
      chapters: chapters.map(c => ({
        id: c.id,
        title: c.title,
        parts: c.parts,
      })),
    }),
  });
  if (!res.ok) throw new Error(`dedupe ${res.status}`);
  const raw: unknown = await res.json();
  const expectedIds = new Set(chapters.map(chapter => chapter.id));
  if (expectedIds.size !== chapters.length || !Array.isArray(raw) || raw.length !== chapters.length) {
    throw new Error('incomplete dedupe report');
  }

  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('invalid dedupe row');
    const row = item as Record<string, unknown>;
    const candidateId = row.candidateId;
    const status = row.status;
    const defaultAction = row.defaultAction;
    if (
      typeof candidateId !== 'string'
      || !expectedIds.has(candidateId)
      || seen.has(candidateId)
      || (status !== 'new' && status !== 'duplicate' && status !== 'conflict')
      || (defaultAction !== 'skip' && defaultAction !== 'overwrite' && defaultAction !== 'append')
    ) {
      throw new Error('invalid dedupe row identity or decision');
    }
    const matchedChapterNumber = row.matchedChapterNumber;
    const matchedTitle = row.matchedTitle;
    const expectedDefaultAction = status === 'new'
      ? 'append'
      : status === 'duplicate'
        ? 'skip'
        : 'overwrite';
    const matchIsValid = status === 'new'
      ? matchedChapterNumber === null && matchedTitle === null
      : Number.isInteger(matchedChapterNumber)
        && Number(matchedChapterNumber) > 0
        && typeof matchedTitle === 'string';
    if (!matchIsValid || defaultAction !== expectedDefaultAction) {
      throw new Error('invalid dedupe match');
    }
    seen.add(candidateId);
  }
  if (seen.size !== expectedIds.size) throw new Error('incomplete dedupe report');
  return raw as DedupeResult[];
}

async function runKbExtraction(
  novelId: string,
  locale: string,
  copy: ReturnType<typeof importCopy>,
  toast: (message: string, type?: 'success' | 'error' | 'info') => void,
): Promise<void> {
  toast(copy.kbRunning, 'info');
  try {
    const headers = await buildAIRequestHeaders(locale, 'summarize');
    const res = await fetch(`/api/novels/${novelId}/import/extract-knowledge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      toast(copy.kbFailed, 'info');
      return;
    }
    const data = (await res.json()) as { outcome: string; created: number };
    if (data.outcome === 'done') toast(copy.kbDone(data.created), 'success');
    else toast(copy.kbFailed, 'info');
  } catch {
    toast(copy.kbFailed, 'info');
  }
}
