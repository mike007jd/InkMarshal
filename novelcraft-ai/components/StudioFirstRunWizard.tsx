'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Download, FolderOpen, Library, Sparkles, Upload } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import type { Translations } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  cancelDownload,
  getDesktopStatus,
  isMacPlatformName,
  isTauriRuntime,
  listInstalledLocalModels,
  type DesktopStatus,
  type EngineFormat,
} from '@/lib/desktop-runtime';
import { useClientMacPlatform } from '@/components/hooks/useClientMacPlatform';
import { startAndBindLocalEngine } from '@/lib/model-supply/orchestrator';
import type { EnginePlatform } from '@/lib/model-supply/catalog';
import { snapshotDownloadTaskId } from '@/lib/model-supply/download-task';
import {
  WIZARD_STARTER_COUNT,
  downloadStarterModel,
  getStarterModelDetails,
  pickPrimaryStarterId,
  repoForStarterEntry,
  resolveStarterFormat,
} from '@/lib/model-supply/starter-models';
import { notifyLocalModelStateChanged } from '@/lib/model-supply/local-model-events';
import type { CuratedModelEntry, InstalledLocalModel } from '@/lib/model-supply/types';

type StarterDownloadState =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'failed'
  | 'binding'
  | 'bindFailed';

interface StarterProgress {
  state: StarterDownloadState;
  percent: number | null;
  taskId: string;
  error?: string;
  // Retained on `bindFailed` so the user can retry binding the already-downloaded
  // file without re-downloading it.
  modelPath?: string;
  modelFormat?: EngineFormat;
}

/**
 * Single source of truth for which affordance a starter row shows. Critically,
 * `bindFailed` must win over `installedHere`: the model bytes are on disk (so it
 * looks "installed") but the engine never started, so we must NOT show a green
 * "Ready" badge — that would be a false success.
 */
export function resolveStarterRowAffordance(
  state: StarterDownloadState | undefined,
  installedHere: boolean,
): 'download' | 'downloading' | 'binding' | 'bindFailed' | 'ready' {
  if (state === 'downloading' || state === 'verifying') return 'downloading';
  if (state === 'binding') return 'binding';
  if (state === 'bindFailed') return 'bindFailed';
  if (installedHere) return 'ready';
  return 'download';
}

/** Map a raw engine-start error to one actionable hint. The single most likely
 *  first-run failure is "downloaded but couldn't start", and the raw message
 *  ("spawn failed", "exit code 1") is opaque — give the user a next move. */
function friendlyBindHint(rawError: string | undefined, t: Translations): string {
  const e = (rawError ?? '').toLowerCase();
  if (/\b(eaddrinuse|address (already )?in use|port)\b/.test(e)) return t.firstRunBindHintPort;
  if (/\b(oom|out of memory|insufficient|not enough|memory|ram)\b/.test(e)) return t.firstRunBindHintRam;
  if (/\b(metal|mlx|toolchain)\b/.test(e)) return t.firstRunBindHintMlx;
  return t.firstRunBindHintGeneric;
}

interface StudioFirstRunWizardProps {
  installedCount: number;
  onBrowseAllModels?: () => void;
  onImportGguf?: () => void;
  onImportMlx?: () => void;
  importing?: boolean;
  importError?: string | null;
}

export function StudioFirstRunWizard({
  installedCount,
  onBrowseAllModels,
  onImportGguf,
  onImportMlx,
  importing = false,
  importError,
}: StudioFirstRunWizardProps) {
  const { t } = useLanguage();
  const [desktop, setDesktop] = useState(false);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([]);
  const [progress, setProgress] = useState<Record<string, StarterProgress>>({});
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const downloadSeqRef = useRef<Record<string, number>>({});

  useEffect(() => {
    mountedRef.current = true;
    setDesktop(isTauriRuntime());
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const seq = ++loadSeqRef.current;
    void (async () => {
      try {
        const [s, models] = await Promise.all([
          getDesktopStatus().catch(() => null as DesktopStatus | null),
          listInstalledLocalModels().catch(() => [] as InstalledLocalModel[]),
        ]);
        if (cancelled || loadSeqRef.current !== seq) return;
        setStatus(s);
        setInstalled(models);
      } catch {
        // best-effort — wizard still renders with degraded info
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [installedCount]);

  const clientMacPlatform = useClientMacPlatform();
  const isMac = useMemo(() => {
    if (status) return isMacPlatformName(status.platform);
    return clientMacPlatform;
  }, [clientMacPlatform, status]);
  const activeFormat: EngineFormat = 'gguf';
  const platform: EnginePlatform = isMac ? 'macos' : 'windows';

  const starters = useMemo<CuratedModelEntry[]>(() => {
    return getStarterModelDetails(platform, activeFormat).slice(0, WIZARD_STARTER_COUNT);
  }, [activeFormat, platform]);

  const isInstalled = useCallback(
    (entry: CuratedModelEntry) => {
      const modelFormat = resolveStarterFormat(entry, activeFormat);
      if (!modelFormat) return false;
      const repo = repoForStarterEntry(entry, modelFormat);
      if (!repo) return false;
      return installed.some(model => {
        if (model.format !== modelFormat) return false;
        if (model.sourceRepo === repo) return true;
        return model.label === entry.name;
      });
    },
    [activeFormat, installed],
  );

  // Record a bind failure (bytes on disk, engine never started). Shared by the
  // download flow and the manual rebind retry so the "downloaded, not started"
  // shape lives in exactly one place.
  const markBindFailed = useCallback(
    (
      entryId: string,
      seq: number,
      taskId: string,
      bindErr: unknown,
      modelPath: string,
      modelFormat: EngineFormat,
    ) => {
      if (!mountedRef.current || downloadSeqRef.current[entryId] !== seq) return;
      setProgress(p => ({
        ...p,
        [entryId]: {
          state: 'bindFailed',
          percent: null,
          taskId,
          error: bindErr instanceof Error ? bindErr.message : String(bindErr),
          modelPath,
          modelFormat,
        },
      }));
    },
    [],
  );

  // Clear the row's progress and refresh the installed list after a successful
  // bind. Shared by the download flow and the manual rebind retry.
  const finishBindSuccess = useCallback(async (entryId: string, seq: number) => {
    if (downloadSeqRef.current[entryId] !== seq) return;
    notifyLocalModelStateChanged();
    if (!mountedRef.current) return;
    setProgress(p => {
      const next = { ...p };
      delete next[entryId];
      return next;
    });
    const refreshed = await listInstalledLocalModels().catch(
      () => [] as InstalledLocalModel[],
    );
    if (!mountedRef.current || downloadSeqRef.current[entryId] !== seq) return;
    setInstalled(refreshed);
  }, []);

  const handleDownload = useCallback(
    async (entry: CuratedModelEntry) => {
      if (!desktop) return;
      const seq = (downloadSeqRef.current[entry.id] ?? 0) + 1;
      downloadSeqRef.current[entry.id] = seq;
      // Resolve model_dir lazily — initial `getDesktopStatus()` may still be
      // in flight (or may have transiently failed) when the user clicks; we
      // refetch on demand instead of leaving the button silently disabled.
      let modelDir = status?.model_dir ?? null;
      if (!modelDir) {
        const fresh = await getDesktopStatus().catch(
          () => null as DesktopStatus | null,
        );
        if (fresh && mountedRef.current && downloadSeqRef.current[entry.id] === seq) {
          setStatus(fresh);
        }
        modelDir = fresh?.model_dir ?? null;
      }
      if (!modelDir) {
        if (downloadSeqRef.current[entry.id] !== seq) return;
        setProgress(p => ({
          ...p,
          [entry.id]: {
            state: 'failed',
            percent: null,
            taskId: entry.id,
            error: desktop ? t.modelManagerModelDirUnavailable : t.modelManagerDesktopOnly,
          },
        }));
        return;
      }
      const modelFormat = resolveStarterFormat(entry, activeFormat);
      if (!modelFormat) return;
      const repo = repoForStarterEntry(entry, modelFormat);
      if (!repo) return;
      const taskId = snapshotDownloadTaskId(repo);
      let currentTaskId = taskId;
      if (downloadSeqRef.current[entry.id] !== seq) return;
      setProgress(p => ({
        ...p,
        [entry.id]: { state: 'downloading', percent: 0, taskId },
      }));
      try {
        const modelPath = await downloadStarterModel({
          id: entry.id,
          format: modelFormat,
          modelDir,
          onTaskId: taskId => {
            currentTaskId = taskId;
            if (!mountedRef.current || downloadSeqRef.current[entry.id] !== seq) return;
            setProgress(p => ({
              ...p,
              [entry.id]: p[entry.id]
                ? { ...p[entry.id], taskId }
                : { state: 'downloading', percent: 0, taskId },
            }));
          },
          onProgress: prog => {
            if (!mountedRef.current || downloadSeqRef.current[entry.id] !== seq) return;
            const pct =
              prog.totalBytes > 0
                ? Math.min(100, Math.round((prog.receivedBytes / prog.totalBytes) * 100))
                : null;
            setProgress(p => ({
              ...p,
              [entry.id]: {
                state:
                  prog.phase === 'error'
                    ? 'failed'
                    : prog.phase === 'verifying'
                      ? 'verifying'
                      : 'downloading',
                percent: pct,
                taskId: currentTaskId,
                error: prog.phase === 'error' ? prog.message : undefined,
              },
            }));
          },
        });
        if (downloadSeqRef.current[entry.id] !== seq) return;
        if (!modelPath) {
          if (mountedRef.current) {
            setProgress(p => ({
              ...p,
              [entry.id]: { state: 'failed', percent: null, taskId: currentTaskId, error: 'no_file' },
            }));
          }
          return;
        }
        try {
          await startAndBindLocalEngine(modelPath, modelFormat, entry.name);
        } catch (bindErr) {
          // The bytes downloaded fine but the engine failed to start/bind. The
          // model now shows as "installed" on disk, so silently swallowing this
          // would render a false-green "Ready". Refresh the installed list, then
          // surface a "downloaded, not started" state with a rebind action that
          // reuses the file.
          if (downloadSeqRef.current[entry.id] !== seq) return;
          notifyLocalModelStateChanged();
          if (!mountedRef.current) return;
          const refreshedAfterBindFail = await listInstalledLocalModels().catch(
            () => [] as InstalledLocalModel[],
          );
          if (!mountedRef.current || downloadSeqRef.current[entry.id] !== seq) return;
          setInstalled(refreshedAfterBindFail);
          markBindFailed(entry.id, seq, currentTaskId, bindErr, modelPath, modelFormat);
          return;
        }
        await finishBindSuccess(entry.id, seq);
      } catch (err) {
        if (!mountedRef.current || downloadSeqRef.current[entry.id] !== seq) return;
        setProgress(p => ({
          ...p,
          [entry.id]: {
            state: 'failed',
            percent: null,
            taskId: currentTaskId,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [activeFormat, desktop, status, t.modelManagerDesktopOnly, t.modelManagerModelDirUnavailable, markBindFailed, finishBindSuccess],
  );

  const handleCancel = useCallback(async (entry: CuratedModelEntry) => {
    const current = progress[entry.id];
    if (!current) return;
    downloadSeqRef.current[entry.id] = (downloadSeqRef.current[entry.id] ?? 0) + 1;
    try {
      await cancelDownload(current.taskId);
    } catch {
      // best-effort
    }
    if (mountedRef.current) {
      setProgress(p => {
        const next = { ...p };
        delete next[entry.id];
        return next;
      });
    }
  }, [progress]);

  // Retry binding a model whose bytes are already on disk (bindFailed). Does NOT
  // re-download — it reuses the stored modelPath/modelFormat.
  const handleStartEngine = useCallback(async (entry: CuratedModelEntry) => {
    const current = progress[entry.id];
    if (!current || current.state !== 'bindFailed' || !current.modelPath || !current.modelFormat) {
      return;
    }
    const { modelPath, modelFormat } = current;
    const seq = (downloadSeqRef.current[entry.id] ?? 0) + 1;
    downloadSeqRef.current[entry.id] = seq;
    setProgress(p => ({
      ...p,
      [entry.id]: { ...current, state: 'binding', error: undefined },
    }));
    try {
      await startAndBindLocalEngine(modelPath, modelFormat, entry.name);
    } catch (bindErr) {
      markBindFailed(entry.id, seq, current.taskId, bindErr, modelPath, modelFormat);
      return;
    }
    await finishBindSuccess(entry.id, seq);
  }, [progress, markBindFailed, finishBindSuccess]);

  // Promote ONE obvious starting point and demote the rest, so the heavier
  // options no longer look equally actionable on a new user's first screen.
  // Shares pickPrimaryStarterId with the model manager so the first-run
  // recommendation and the Models page never disagree on the same machine.
  const primaryStarterId = pickPrimaryStarterId(starters, status?.total_memory_bytes);
  const primaryStarter = starters.find(e => e.id === primaryStarterId) ?? starters[0] ?? null;
  const otherStarters = starters.filter(e => e.id !== primaryStarter?.id);

  const renderStarterRow = (entry: CuratedModelEntry, isPrimary: boolean) => {
    const item = progress[entry.id];
    const installedHere = isInstalled(entry);
    const affordance = resolveStarterRowAffordance(item?.state, installedHere);
    const downloading = affordance === 'downloading';
    const label =
      item?.state === 'verifying'
        ? t.modelManagerStateVerifying
        : t.starterModelDownloading;
    return (
      <div
        key={entry.id}
        className={cn(
          'rounded-md border',
          isPrimary
            ? 'border-book-gold/50 bg-book-bg-card p-3.5 shadow-sm ring-1 ring-book-gold/15'
            : 'border-book-border bg-book-bg-secondary/40 p-3',
        )}
      >
        {isPrimary && (
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-book-gold-dark">
            <Sparkles className="h-3.5 w-3.5" />
            {t.modelManagerRecommendedStarter}
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={isPrimary ? 'truncate text-base font-medium text-book-ink-primary' : 'truncate text-sm font-medium text-book-ink-primary'}>
              {entry.name}
            </div>
            <div className="mt-1 text-xs-tight text-book-ink-muted">
              {entry.category}
              {entry.sizeHint ? ` · ${entry.sizeHint}` : ''}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {affordance === 'ready' ? (
              <Badge variant="success">{t.modelManagerStateReady}</Badge>
            ) : affordance === 'downloading' ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleCancel(entry)}
              >
                {t.modelManagerCancelDownload}
              </Button>
            ) : affordance === 'binding' ? (
              <Button type="button" variant="accent" size="sm" disabled>
                <Spinner size="sm" />
                {t.modelManagerStartEngine}
              </Button>
            ) : affordance === 'bindFailed' ? (
              <>
                <Badge variant="danger">{t.modelManagerStateNotStarted}</Badge>
                <Button
                  type="button"
                  variant="accent"
                  size="sm"
                  disabled={!desktop}
                  onClick={() => void handleStartEngine(entry)}
                >
                  {t.modelManagerStartEngine}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant={isPrimary ? 'accent' : 'outline'}
                size="sm"
                disabled={!desktop}
                onClick={() => void handleDownload(entry)}
              >
                <Download className="h-3.5 w-3.5" />
                {item?.state === 'failed'
                  ? t.modelManagerRetry
                  : t.modelManagerInstallAndUse}
              </Button>
            )}
          </div>
        </div>
        {downloading && (
          <div className="mt-2 space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-book-bg-secondary">
              <div
                className="motion-essential h-full rounded-full bg-book-gold transition-progress"
                style={{ width: `${item?.percent ?? 8}%` }}
              />
            </div>
            <div className="flex items-center gap-2 text-xs-tight text-book-ink-muted">
              <Spinner size="sm" />
              <span>
                {label}
                {item?.percent != null ? ` ${item.percent}%` : ''}
              </span>
            </div>
          </div>
        )}
        {item?.state === 'bindFailed' ? (
          <div className="mt-2 space-y-0.5">
            <p className="text-xs-tight font-medium text-book-danger">
              {t.firstRunBindFailedTitle}
            </p>
            <p className="text-xs-tight text-book-ink-secondary">
              {friendlyBindHint(item.error, t)}
            </p>
            {item.error && (
              <p className="text-xs-tight text-book-ink-muted break-words">{item.error}</p>
            )}
          </div>
        ) : item?.state === 'failed' ? (
          <p className="mt-2 text-xs-tight text-book-danger break-words">
            {item.error ?? t.modelManagerStateFailed}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <section
      data-testid="studio-first-run-wizard"
      className="mb-8"
    >
      <header className="mb-4 min-w-0">
        <h2 className="text-lg font-semibold leading-snug text-book-ink-primary">
          {t.firstRunStep1Title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-book-ink-secondary">
          {t.firstRunInstallSubtitle}
        </p>
      </header>

      <div className="space-y-3">
        <Badge variant="muted">{t.firstRunStarterShelfHint}</Badge>
        {primaryStarter ? (
          <div className="space-y-2">
            {renderStarterRow(primaryStarter, true)}
            {otherStarters.length > 0 && (
              <div className="space-y-2 pt-1">
                <div className="px-0.5 text-xs font-semibold text-book-ink-secondary">
                  {t.modelManagerMoreStarters}
                </div>
                {otherStarters.map(entry => renderStarterRow(entry, false))}
              </div>
            )}
          </div>
        ) : (
          // No starter shelf for this platform/catalog state — never a dead end:
          // route the user to the full model manager.
          <p className="rounded-md border border-dashed border-book-border px-3 py-3 text-xs text-book-ink-muted">
            {t.firstRunNoStarters}
          </p>
        )}
        {!desktop && (
          <p className="rounded-md border border-dashed border-book-border px-3 py-2 text-xs text-book-ink-muted">
            {t.modelManagerDesktopOnly}
          </p>
        )}
        {desktop && onImportGguf && (
          <div className="rounded-md border border-book-border bg-book-bg-secondary/45 p-3">
            <div className="text-xs font-semibold text-book-ink-primary">
              {t.firstRunUseOwnModel}
            </div>
            <p className="mt-1 text-xs-tight leading-5 text-book-ink-muted">
              {t.modelManagerLocalFormatHelp}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={importing}
                onClick={onImportGguf}
              >
                {importing ? <Spinner size="sm" /> : <Upload className="h-3.5 w-3.5" />}
                {t.modelManagerImportGguf}
              </Button>
              {onImportMlx && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={importing}
                  onClick={onImportMlx}
                >
                  {importing ? <Spinner size="sm" /> : <FolderOpen className="h-3.5 w-3.5" />}
                  {t.modelManagerImportMlx}
                </Button>
              )}
            </div>
            {importError && <p className="mt-2 text-xs-tight text-book-danger">{importError}</p>}
          </div>
        )}
        {desktop && (
          // Persistent escape hatch — the sidebar Models entry is easy to miss
          // during onboarding, so always offer the full catalog from here.
          onBrowseAllModels ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onBrowseAllModels}
              className="gap-1.5 text-book-gold hover:text-book-gold-dark"
            >
              <Library className="h-3.5 w-3.5" />
              {t.firstRunBrowseAllModels}
              <ArrowRight className="h-3 w-3" />
            </Button>
          ) : (
            <Link
              href="/desktop-studio/models"
              className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-book-gold transition-colors hover:text-book-gold-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-book-gold focus-visible:ring-offset-1"
            >
              <Library className="h-3.5 w-3.5" />
              {t.firstRunBrowseAllModels}
              <ArrowRight className="h-3 w-3" />
            </Link>
          )
        )}
      </div>
    </section>
  );
}
