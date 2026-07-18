'use client';

// ImportWizard (W2-1) — the modal that walks an author through bringing an
// existing manuscript into the studio:
//
//   pick → parse (server action) → preview & correct (ChapterSplitEditor)
//        → confirm (server action transaction) → optional background KB extract.
//
// The wizard owns all transient state (candidates, edits, dedupe decisions); the
// server actions are pure round-trips. i18n is the self-contained `importCopy`
// table — the shared bundle is untouched per the W2-1 constraint.

import { useCallback, useMemo, useState } from 'react';
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
import { isTauriRuntime, readLocalFile } from '@/lib/desktop-runtime';
import { buildAIRequestHeaders } from '@/lib/streaming-client';
import { parseImportedFile, importPlanToNovel } from '@/app/actions/import';
import { renumberCandidates } from '@/lib/import/detect-chapters';
import { ChapterSplitEditor } from '@/components/studio/import/ChapterSplitEditor';
import { importCopy } from '@/components/studio/import/import-copy';
import type {
  ChapterCandidate,
  DedupeAction,
  DedupeResult,
  ImportPlan,
  ImportSource,
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

  const [source, setSource] = useState<ImportSource>('txt');
  const [filename, setFilename] = useState('');
  const [novelTitle, setNovelTitle] = useState('');
  const [candidates, setCandidates] = useState<ChapterCandidate[]>([]);
  const [dedupe, setDedupe] = useState<DedupeResult[] | undefined>(undefined);
  const [actions, setActions] = useState<Record<string, DedupeAction>>({});

  const hasNovels = novels.length > 0;
  const [mode, setMode] = useState<'new' | 'merge'>(
    initialTargetNovelId && hasNovels ? 'merge' : 'new',
  );
  const [targetNovelId, setTargetNovelId] = useState<string>(
    initialTargetNovelId ?? novels[0]?.id ?? '',
  );

  const totalWords = useMemo(
    () => candidates.reduce((sum, c) => sum + c.wordCount, 0),
    [candidates],
  );
  const conflictCount = useMemo(
    () => (dedupe ?? []).filter(d => d.status === 'conflict').length,
    [dedupe],
  );

  // Recompute the merge dedupe report against `targetId`. We no longer hold the
  // source bytes, so the report is rebuilt from the in-memory candidates via the
  // dedicated /import/dedupe endpoint (the server owns the target's chapters).
  // Driven from the mode/target change handlers (not an effect) so the network
  // round-trip is an explicit user action, never a render side effect.
  const runDedupe = useCallback(async (targetId: string) => {
    if (!targetId || candidates.length === 0) return;
    setBusy(true);
    try {
      const report = await fetchDedupeReport(targetId, candidates);
      setDedupe(report);
      const nextActions: Record<string, DedupeAction> = {};
      for (const d of report) nextActions[d.candidateId] = d.defaultAction;
      setActions(nextActions);
    } catch {
      setDedupe(undefined);
    } finally {
      setBusy(false);
    }
  }, [candidates]);

  const selectMode = (nextMode: 'new' | 'merge') => {
    setMode(nextMode);
    if (nextMode === 'merge') {
      if (targetNovelId) void runDedupe(targetNovelId);
    } else {
      setDedupe(undefined);
    }
  };

  const selectTarget = (nextTarget: string) => {
    setTargetNovelId(nextTarget);
    if (mode === 'merge' && nextTarget) void runDedupe(nextTarget);
  };

  const handlePick = async () => {
    if (!isTauriRuntime()) {
      setError(copy.desktopOnly);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const picked = await readLocalFile(['txt', 'md', 'docx']);
      if (!picked) return; // user dismissed the dialog
      const name = picked.path.split(/[\\/]/).pop() ?? 'manuscript';
      const result = await parseImportedFile({
        filename: name,
        contentsBase64: picked.contentsBase64,
      });
      setSource(result.source);
      setFilename(result.filename);
      setNovelTitle(result.suggestedTitle);
      setCandidates(result.candidates);
      setStep('preview');
      // Launched against a specific novel (from its "…" menu): run the merge
      // dedupe immediately so the preview opens with the report populated.
      if (mode === 'merge' && targetNovelId) {
        const report = await fetchDedupeReport(targetNovelId, result.candidates);
        setDedupe(report);
        const nextActions: Record<string, DedupeAction> = {};
        for (const d of report) nextActions[d.candidateId] = d.defaultAction;
        setActions(nextActions);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.parseFailed);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (busy) return;
    if (mode === 'merge' && !targetNovelId) return;
    setBusy(true);
    setError(null);

    const runKb = kbEnabled;
    const plan: ImportPlan = {
      source,
      filename,
      novelTitle: novelTitle.trim() || copy.novelTitlePlaceholder,
      chapters: candidates.map(c => ({
        chapterNumber: c.chapterNumber,
        title: c.title,
        content: c.content,
      })),
    };

    try {
      const result = await importPlanToNovel({
        plan,
        mode,
        targetNovelId: mode === 'merge' ? targetNovelId : undefined,
        dedupeDecisions:
          mode === 'merge'
            ? (dedupe ?? []).map(d => {
                const cand = candidates.find(c => c.id === d.candidateId);
                return {
                  chapterNumber: cand?.chapterNumber ?? 0,
                  action: actions[d.candidateId] ?? d.defaultAction,
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
            {copy.previewHeading(candidates.length, totalWords)}
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

          {mode === 'merge' && conflictCount > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-book-warning-border bg-book-warning-light px-3 py-2 text-xs text-book-stage-writing">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{copy.conflictWarning(conflictCount)}</span>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <ChapterSplitEditor
              candidates={candidates}
              onChange={(next) => setCandidates(renumberCandidates(next))}
              dedupe={mode === 'merge' ? dedupe : undefined}
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
            disabled={busy || (mode === 'merge' && !targetNovelId)}
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
 * Recompute the dedupe report for the current candidates against a target
 * novel. Uses the import server action's parse path is unsuitable (needs file
 * bytes), so we call a thin dedicated endpoint via the action layer: the
 * server reads the target's chapters and runs the pure `dedupeCandidates`.
 */
async function fetchDedupeReport(
  targetNovelId: string,
  candidates: ChapterCandidate[],
): Promise<DedupeResult[]> {
  const res = await fetch(`/api/novels/${targetNovelId}/import/dedupe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidates: candidates.map(c => ({
        id: c.id,
        title: c.title,
        content: c.content,
      })),
    }),
  });
  if (!res.ok) throw new Error(`dedupe ${res.status}`);
  return (await res.json()) as DedupeResult[];
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
