'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  FolderDown,
  FolderOpen,
  HardDrive,
  Layers,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  cancelDownload,
  engineStatus,
  getDesktopStatus,
  hfDownloadGguf,
  hfDownloadRepoSnapshot,
  importLocalModel,
  isTauriRuntime,
  isMacPlatformName,
  listInstalledLocalModels,
  modelDirFreeBytes,
  pickModelDir,
  pickLocalGgufModel,
  pickLocalMlxModelFolder,
  removeInstalledLocalModel,
  revealModelDir,
  resetModelDir,
  revealLocalModel,
  setModelDir,
  type DesktopStatus,
  type EngineFormat,
  type EngineInfo,
} from '@/lib/desktop-runtime';
import { removeStoredSetting, setStoredSetting } from '@/lib/app-settings-client';
import {
  getCapabilityProfile,
  getConnections,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import { ggufDownloadTaskId, snapshotDownloadTaskId } from '@/lib/model-supply/download-task';
import { formatBytes } from '@/lib/model-supply/format';
import { formatLabel, installDate, recoveryMessage, roleChipLabel, roleSummary } from '@/components/models/model-presentation';
import {
  getStarterModelDetails,
  pickPrimaryStarterId,
  resolveStarterFormat,
} from '@/lib/model-supply/starter-models';
import { safeRepoToDir } from '@/lib/model-supply/repo-paths';
import {
  installedGgufDownloadTaskId,
  normalizeModelDownloadProgress,
  pruneStaleDownloadFailures,
  type ModelProgress,
} from '@/lib/model-download-progress';
import {
  listRoleEngineBindings,
  normalizeModelPathForCompare,
  stopEngineAndUnbind,
} from '@/lib/model-supply/orchestrator';
import { EngineLaunchRoleDialog } from '@/components/EngineLaunchRoleDialog';
import { StudioFirstRunWizard } from '@/components/StudioFirstRunWizard';
import { useClientMacPlatform } from '@/components/hooks/useClientMacPlatform';
import {
  buildCapabilityCoverageSummary,
  EMPTY_CAPABILITY_PROFILE,
  type CapabilityCoverageRole,
} from '@/components/models/capability-coverage';
import {
  DownloadProgressBar,
  UseModelButton,
  type EngineUseState,
} from '@/components/models/LocalModelControls';
import {
  findInstalledStarterModel,
  fitForStarterEntry,
  groupRolesByEngineId,
  groupRunningEnginesByModelPath,
  localModelHardwareLabel,
  repoForStarterFormat,
  type FitState,
  type FitResult,
  type RoleBindingInfo,
} from '@/components/models/local-model-derived';
import {
  downloadCancelledProgress,
  downloadFailedProgress,
  downloadReadyProgress,
  downloadStartedProgress,
  progressFromDownloadEvent,
  type DownloadProgressLabels,
} from '@/components/models/local-model-progress';
import { useHfModelSearch } from '@/components/models/use-hf-model-search';
import {
  starterCatalogFilesKey,
  useStarterCatalogFiles,
} from '@/components/models/use-starter-catalog-files';
import { notifyLocalModelStateChanged } from '@/lib/model-supply/local-model-events';
import type {
  CapabilityProfile,
  CapabilityRole,
  CuratedModelEntry,
  HfModelFile,
  InstalledLocalModel,
  RuntimeConnection,
} from '@/lib/model-supply/types';

const FIT_BADGE_VARIANT: Record<FitState, React.ComponentProps<typeof Badge>['variant']> = {
  good: 'success',
  tight: 'gold',
  bad: 'danger',
  unknown: 'muted',
};

const DOWNLOAD_PROGRESS_KEY = 'inkmarshal:model-download-progress:v1';
const MODEL_ROOT_SETTING_KEY = 'inkmarshal_model_root_v1';
const RECOMMENDED_FORMAT: EngineFormat = 'gguf';

function compactHomePath(value: string | null | undefined): string {
  if (!value) return '';
  if (typeof window === 'undefined') return value;
  const userMatch = value.match(/^\/Users\/([^/]+)(\/.*)?$/);
  if (!userMatch) return value;
  return `~${userMatch[2] ?? ''}`;
}

export function LocalModelsPanel({
  openProviders,
}: {
  openProviders?: () => void;
}) {
  const { t } = useLanguage();
  const desktop = isTauriRuntime();

  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([]);
  const [runningEngines, setRunningEngines] = useState<EngineInfo[]>([]);
  const [connections, setConnections] = useState<RuntimeConnection[]>([]);
  const [capabilityProfile, setCapabilityProfile] = useState<CapabilityProfile>(EMPTY_CAPABILITY_PROFILE);
  const [format, setFormat] = useState<EngineFormat>('gguf');

  const [progress, setProgress] = useState<Record<string, ModelProgress>>({});
  const [progressHydrated, setProgressHydrated] = useState(false);
  const [useStates, setUseStates] = useState<Record<string, EngineUseState>>({});
  const [removingPaths, setRemovingPaths] = useState<Record<string, boolean>>({});
  // Model pending a remove/unregister confirmation — replaces window.confirm so
  // the gate matches the book Dialog idiom and is localizable.
  const [pendingRemoval, setPendingRemoval] = useState<InstalledLocalModel | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [modelDirBusy, setModelDirBusy] = useState(false);
  const [modelDirError, setModelDirError] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<{
    modelPath: string;
    format: EngineFormat;
    modelLabel: string;
    presetRoles?: readonly CapabilityRole[];
  } | null>(null);
  // Wave 4 commit C: per-engine reverse lookup of which roles are bound. Kept
  // as state (not a per-render derive) so a re-bind via Settings re-renders
  // the chips here too via the store subscription below.
  const [roleBindings, setRoleBindings] = useState<Map<CapabilityRole, RoleBindingInfo>>(() => new Map());
  const [showAdvancedManager, setShowAdvancedManager] = useState(false);

  const mountedRef = useRef(true);
  const progressHydratedRef = useRef(false);
  const cancelledTasksRef = useRef<Set<string>>(new Set());
  const activeDownloadTasksRef = useRef<Set<string>>(new Set());
  const removingModelPathsRef = useRef<Set<string>>(new Set());
  const refreshSeqRef = useRef(0);
  // Anchor for the coverage CTA to scroll the user to the Recommended shelf
  // when there is no primary starter entry to install directly.
  const recommendedShelfRef = useRef<HTMLDivElement>(null);
  const clientMacPlatform = useClientMacPlatform();

  const isMac = useMemo(() => {
    if (status) return isMacPlatformName(status.platform);
    return clientMacPlatform;
  }, [clientMacPlatform, status]);

  const activeFormat: EngineFormat = isMac ? format : 'gguf';
  const {
    open: hfSearchOpen,
    setOpen: setHfSearchOpen,
    query: hfQuery,
    setQuery: setHfQuery,
    searching: hfSearching,
    results: hfResults,
    repo: hfRepo,
    files: hfFiles,
    filename: hfFilename,
    setFilename: setHfFilename,
    searchError: hfSearchError,
    filesError: hfFilesError,
    filesLoading: hfFilesLoading,
    selectedFile: selectedHfFile,
    resetSelection: resetHfSelection,
    runSearch: runHfSearch,
    pickRepo,
  } = useHfModelSearch({ activeFormat, t });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (progressHydratedRef.current) return;
    progressHydratedRef.current = true;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (typeof localStorage === 'undefined') {
        setProgressHydrated(true);
        return;
      }
      try {
        const raw = localStorage.getItem(DOWNLOAD_PROGRESS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        setProgress(
          normalizeModelDownloadProgress(parsed, {
            interruptedLabel: t.modelManagerStateFailed,
            interruptedError: t.modelManagerRecoveryInterrupted,
          }),
        );
      } catch {
        setProgress({});
      } finally {
        setProgressHydrated(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [t.modelManagerRecoveryInterrupted, t.modelManagerStateFailed]);

  useEffect(() => {
    if (!progressHydrated || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(DOWNLOAD_PROGRESS_KEY, JSON.stringify(progress));
    } catch {
      // Private browser storage can reject writes; installed-model scanning is still authoritative.
    }
  }, [progress, progressHydrated]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const isCurrent = () => mountedRef.current && refreshSeqRef.current === seq;
    setLoading(true);
    try {
      const nextStatus = await getDesktopStatus();
      if (!isCurrent()) return;
      setStatus(nextStatus);
      if (nextStatus.desktop) {
        const [free, engines, localModels] = await Promise.all([
          modelDirFreeBytes().catch(() => null),
          engineStatus().catch(() => [] as EngineInfo[]),
          listInstalledLocalModels().catch(() => [] as InstalledLocalModel[]),
        ]);
        if (!isCurrent()) return;
        setFreeBytes(free);
        setRunningEngines(engines);
        setInstalled(localModels);
        notifyLocalModelStateChanged();
      } else {
        setFreeBytes(null);
        setRunningEngines([]);
        setInstalled([]);
        notifyLocalModelStateChanged();
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    // Wave 4 commit C: keep `roleBindings` synced through the same store sub
    // — a bind/unbind in CapabilityBindingPanel must update the chips here
    // without waiting for an explicit `refresh()` call.
    const readBindings = () => {
      if (!mountedRef.current) return;
      setRoleBindings(listRoleEngineBindings());
      setConnections(getConnections());
      setCapabilityProfile(getCapabilityProfile());
    };
    queueMicrotask(() => {
      if (!cancelled) readBindings();
    });
    const unsubscribe = subscribeConnectionsStore(() => {
      void refresh();
      readBindings();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh]);

  const platform = isMac ? 'macos' : 'windows';
  const recommended = useMemo(() => {
    return getStarterModelDetails(platform, RECOMMENDED_FORMAT);
  }, [platform]);
  const {
    loadingByKey: catalogFilesLoading,
    ensureCatalogFiles,
  } = useStarterCatalogFiles(RECOMMENDED_FORMAT);

  const runningByPath = useMemo(() => {
    return groupRunningEnginesByModelPath(runningEngines);
  }, [runningEngines]);

  // Wave 4 commit C: engineId -> roles bound to it. Used to render the
  // "Bound to: draft · rewrite" chips on each installed-model card. We
  // accumulate into an array because a single engine commonly serves more
  // than one role.
  const rolesByEngineId = useMemo(() => {
    return groupRolesByEngineId(roleBindings);
  }, [roleBindings]);

  const runningModel = runningEngines[0];
  const coverage = useMemo(() => {
    return buildCapabilityCoverageSummary({
      profile: capabilityProfile,
      connections,
      runningEngines,
    });
  }, [capabilityProfile, connections, runningEngines]);

  const hardwareLabel = useMemo(() => {
    return localModelHardwareLabel({
      isMac,
      status,
      copy: {
        mac: t.modelManagerHardwareMac,
        device: t.modelManagerHardwareDevice,
        unknown: t.modelManagerUnknown,
      },
    });
  }, [isMac, status, t]);

  const fitForEntry = useCallback(
    (entry: CuratedModelEntry): FitResult => {
      return fitForStarterEntry(entry, status?.total_memory_bytes, {
        bad: t.modelManagerFitBad,
        badDetail: t.modelManagerFitBadDesc,
        tight: t.modelManagerFitTight,
        tightDetail: t.modelManagerFitTightDesc,
        good: t.modelManagerFitGood,
        goodDetail: t.modelManagerFitGoodDesc,
        unknown: t.modelManagerFitUnknown,
        unknownDetail: t.modelManagerFitUnknownDesc,
      });
    },
    [status, t],
  );

  const repoForEntry = useCallback(
    (entry: CuratedModelEntry): string | null => {
      return repoForStarterFormat(entry, RECOMMENDED_FORMAT);
    },
    [],
  );

  const installedForEntry = useCallback(
    (entry: CuratedModelEntry): InstalledLocalModel | null => {
      return findInstalledStarterModel({ entry, activeFormat: RECOMMENDED_FORMAT, installed });
    },
    [installed],
  );

  // Reconcile restored "failed (Interrupted)" entries against the disk: when
  // the Rust side actually completed + verified the download but the app died
  // before the 'done' frame landed, the installed-model scan is authoritative
  // and the stale failure card must not demand a re-download.
  useEffect(() => {
    if (!progressHydrated) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const installedTaskIds = new Set<string>();
      for (const model of installed) {
        if (!model.sourceRepo) continue;
        if (model.format === 'gguf') {
          const taskId = installedGgufDownloadTaskId(model);
          if (taskId) installedTaskIds.add(taskId);
        } else {
          installedTaskIds.add(snapshotDownloadTaskId(model.sourceRepo));
        }
      }
      for (const entry of recommended) {
        const fmt = resolveStarterFormat(entry, RECOMMENDED_FORMAT);
        if (fmt && installedForEntry(entry)) installedTaskIds.add(`catalog:${entry.id}:${fmt}`);
      }
      setProgress(prev => pruneStaleDownloadFailures(prev, installedTaskIds));
    });
    return () => {
      cancelled = true;
    };
  }, [progressHydrated, installed, recommended, installedForEntry]);

  const setProgressItem = useCallback((key: string, item: ModelProgress) => {
    setProgress(prev => ({ ...prev, [key]: item }));
  }, []);

  const downloadProgressLabels: DownloadProgressLabels = useMemo(() => ({
    downloading: t.modelManagerStateDownloading,
    verifying: t.modelManagerStateVerifying,
    failed: t.modelManagerStateFailed,
    cancelled: t.modelManagerStateCancelled,
    ready: t.modelManagerStateReady,
  }), [
    t.modelManagerStateCancelled,
    t.modelManagerStateDownloading,
    t.modelManagerStateFailed,
    t.modelManagerStateReady,
    t.modelManagerStateVerifying,
  ]);

  const downloadGguf = useCallback(
    async (
      file: HfModelFile,
      modelDir: string,
      progressKey = ggufDownloadTaskId(file.repo, file.filename),
    ): Promise<string | null> => {
      const taskId = ggufDownloadTaskId(file.repo, file.filename);
      const destPath = `${modelDir.replace(/[\\/]$/, '')}/${file.filename}`;
      if (activeDownloadTasksRef.current.has(taskId)) return null;
      activeDownloadTasksRef.current.add(taskId);
      cancelledTasksRef.current.delete(taskId);
      setProgressItem(progressKey, downloadStartedProgress(downloadProgressLabels, taskId));
      try {
        await hfDownloadGguf(
          {
            repoId: file.repo,
            filename: file.filename,
            destPath,
            expectedSha256: file.sha256,
            expectedSizeBytes: file.sizeBytes > 0 ? file.sizeBytes : undefined,
          },
          prog => {
            if (!mountedRef.current) return;
            setProgressItem(progressKey, progressFromDownloadEvent({
              progress: prog,
              taskId,
              labels: downloadProgressLabels,
              cancelled: cancelledTasksRef.current.has(taskId),
            }));
          },
        );
        if (!mountedRef.current || cancelledTasksRef.current.has(taskId)) return null;
        setProgressItem(progressKey, downloadReadyProgress(downloadProgressLabels, taskId, destPath));
        await refresh();
        return destPath;
      } catch (err) {
        if (!mountedRef.current) return null;
        if (cancelledTasksRef.current.has(taskId)) {
          setProgressItem(progressKey, downloadCancelledProgress(downloadProgressLabels, taskId));
          return null;
        }
        setProgressItem(
          progressKey,
          downloadFailedProgress(
            downloadProgressLabels,
            err instanceof Error ? err.message : String(err),
            taskId,
          ),
        );
        return null;
      } finally {
        activeDownloadTasksRef.current.delete(taskId);
      }
    },
    [
      refresh,
      downloadProgressLabels,
      setProgressItem,
    ],
  );

  const downloadSnapshot = useCallback(
    async (
      repoId: string,
      files: HfModelFile[],
      modelDir: string,
      progressKey = repoId,
    ): Promise<string | null> => {
      const taskId = snapshotDownloadTaskId(repoId);
      const destDir = `${modelDir.replace(/[\\/]$/, '')}/${safeRepoToDir(repoId)}`;
      const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      if (freeBytes != null && totalBytes > freeBytes) {
        setProgressItem(progressKey, downloadFailedProgress(downloadProgressLabels, t.modelManagerLowSpace));
        return null;
      }
      if (activeDownloadTasksRef.current.has(taskId)) return null;
      activeDownloadTasksRef.current.add(taskId);
      cancelledTasksRef.current.delete(taskId);
      setProgressItem(progressKey, downloadStartedProgress(downloadProgressLabels, taskId));
      try {
        await hfDownloadRepoSnapshot(
          { repoId, files, destDir },
          prog => {
            if (!mountedRef.current) return;
            setProgressItem(progressKey, progressFromDownloadEvent({
              progress: prog,
              taskId,
              labels: downloadProgressLabels,
              cancelled: cancelledTasksRef.current.has(taskId),
            }));
          },
        );
        if (!mountedRef.current || cancelledTasksRef.current.has(taskId)) return null;
        setProgressItem(progressKey, downloadReadyProgress(downloadProgressLabels, taskId, destDir));
        await refresh();
        return destDir;
      } catch (err) {
        if (!mountedRef.current) return null;
        if (cancelledTasksRef.current.has(taskId)) {
          setProgressItem(progressKey, downloadCancelledProgress(downloadProgressLabels, taskId));
          return null;
        }
        setProgressItem(
          progressKey,
          downloadFailedProgress(
            downloadProgressLabels,
            err instanceof Error ? err.message : String(err),
            taskId,
          ),
        );
        return null;
      } finally {
        activeDownloadTasksRef.current.delete(taskId);
      }
    },
    [
      refresh,
      downloadProgressLabels,
      setProgressItem,
      t.modelManagerLowSpace,
      freeBytes,
    ],
  );

  const cancelKey = useCallback(
    async (progressKey: string) => {
      const taskId = progress[progressKey]?.cancelTaskId ?? progressKey;
      cancelledTasksRef.current.add(taskId);
      setProgressItem(progressKey, {
        state: 'cancelled',
        percent: null,
        label: t.modelManagerStateCancelled,
        cancelTaskId: taskId,
      });
      try {
        await cancelDownload(taskId);
      } catch {
        // Best-effort cancel; the task may have already finished.
      }
    },
    [progress, setProgressItem, t.modelManagerStateCancelled],
  );

  const startModel = useCallback(
    (
      modelPath: string,
      fmt: EngineFormat,
      label: string,
      presetRoles?: readonly CapabilityRole[],
    ) => {
      if (!desktop) return;
      // Wave 4: launches go through the role-selection dialog instead of a
      // silent 4-role bind. The dialog calls startEngineForRoles + handles the
      // QuotaConflict three-way panel; on success we refresh and clear state.
      setUseStates(s => ({ ...s, [modelPath]: { state: 'starting' } }));
      setPendingLaunch({
        modelPath,
        format: fmt,
        modelLabel: label,
        presetRoles:
          presetRoles ?? (coverage.notReadyRoles.length > 0 ? coverage.notReadyRoles : undefined),
      });
    },
    [coverage.notReadyRoles, desktop],
  );

  const cancelPendingLaunch = useCallback(() => {
    setPendingLaunch(prev => {
      if (prev) {
        setUseStates(s => ({ ...s, [prev.modelPath]: { state: 'idle' } }));
      }
      return null;
    });
  }, []);

  const handleLaunchSuccess = useCallback(() => {
    setPendingLaunch(prev => {
      if (prev) {
        setUseStates(s => ({ ...s, [prev.modelPath]: { state: 'running' } }));
      }
      return null;
    });
    void refresh();
  }, [refresh]);

  const stopModel = useCallback(
    async (engineId: string) => {
      // Wave 4: only clear the bindings of THIS engine — other engines (and
      // the roles they own) survive.
      try {
        await stopEngineAndUnbind(engineId);
      } catch {
        // engine_stop is idempotent; on a partial error we still refresh so the
        // panel converges to whatever the registry actually has.
      }
      await refresh();
    },
    [refresh],
  );

  const importExistingModel = useCallback(
    async (kind: EngineFormat) => {
      if (!desktop) return;
      setImporting(true);
      setImportError(null);
      try {
        const picked =
          kind === 'mlx' ? await pickLocalMlxModelFolder() : await pickLocalGgufModel();
        if (!picked) return;
        const model = await importLocalModel(picked);
        await refresh();
        await startModel(model.modelPath, model.format, model.label);
      } catch (err) {
        if (mountedRef.current) {
          setImportError(recoveryMessage(err instanceof Error ? err.message : String(err), t));
        }
      } finally {
        if (mountedRef.current) setImporting(false);
      }
    },
    [desktop, refresh, startModel, t],
  );

  const changeModelDir = useCallback(async () => {
    if (!desktop || modelDirBusy) return;
    setModelDirBusy(true);
    setModelDirError(null);
    try {
      const picked = await pickModelDir(status?.model_dir);
      if (!picked) return;
      const saved = await setModelDir(picked);
      setStoredSetting(MODEL_ROOT_SETTING_KEY, saved);
      await refresh();
    } catch (err) {
      if (mountedRef.current) {
        setModelDirError(recoveryMessage(err instanceof Error ? err.message : String(err), t));
      }
    } finally {
      if (mountedRef.current) setModelDirBusy(false);
    }
  }, [desktop, modelDirBusy, refresh, status, t]);

  const restoreDefaultModelDir = useCallback(async () => {
    if (!desktop || modelDirBusy) return;
    setModelDirBusy(true);
    setModelDirError(null);
    try {
      await resetModelDir();
      removeStoredSetting(MODEL_ROOT_SETTING_KEY);
      await refresh();
    } catch (err) {
      if (mountedRef.current) {
        setModelDirError(recoveryMessage(err instanceof Error ? err.message : String(err), t));
      }
    } finally {
      if (mountedRef.current) setModelDirBusy(false);
    }
  }, [desktop, modelDirBusy, refresh, t]);

  const revealConfiguredModelDir = useCallback(async () => {
    if (!desktop || !status?.model_dir || modelDirBusy) return;
    setModelDirBusy(true);
    setModelDirError(null);
    try {
      await revealModelDir();
    } catch (err) {
      if (mountedRef.current) {
        setModelDirError(recoveryMessage(err instanceof Error ? err.message : String(err), t));
      }
    } finally {
      if (mountedRef.current) setModelDirBusy(false);
    }
  }, [desktop, modelDirBusy, status, t]);

  const installAndUseCatalogEntry = useCallback(
    async (entry: CuratedModelEntry, progressKey: string) => {
      if (!desktop || !status?.model_dir) return;
      const fmt = resolveStarterFormat(entry, RECOMMENDED_FORMAT);
      if (!fmt) return;
      const existing = installedForEntry(entry);
      const existingPath = existing?.modelPath;
      if (existingPath) {
        await startModel(existingPath, fmt, entry.name);
        return;
      }

      const repo = repoForEntry(entry);
      if (!repo) return;
      const files = await ensureCatalogFiles(entry);
      if (files.length === 0) {
        setProgressItem(progressKey, {
          state: 'failed',
          percent: null,
          label: t.modelManagerStateFailed,
          error: t.modelManagerHfFilesFailed,
        });
        return;
      }

      let modelPath: string | null = null;
      if (fmt === 'mlx') {
        modelPath = await downloadSnapshot(repo, files, status.model_dir, progressKey);
      } else {
        const recQuant = entry.gguf?.recommendedQuant;
        const file =
          (recQuant ? files.find(f => f.quant === recQuant) : undefined) ?? files[0] ?? null;
        if (!file) return;
        if (freeBytes != null && file.sizeBytes > freeBytes) {
          setProgressItem(progressKey, {
            state: 'failed',
            percent: null,
            label: t.modelManagerStateFailed,
            error: t.modelManagerLowSpace,
          });
          return;
        }
        modelPath = await downloadGguf(file, status.model_dir, progressKey);
      }
      if (modelPath) await startModel(modelPath, fmt, entry.name);
    },
    [
      desktop,
      downloadGguf,
      downloadSnapshot,
      ensureCatalogFiles,
      freeBytes,
      installedForEntry,
      repoForEntry,
      setProgressItem,
      startModel,
      status,
      t.modelManagerHfFilesFailed,
      t.modelManagerLowSpace,
      t.modelManagerStateFailed,
    ],
  );

  const removeModel = useCallback(
    async (model: InstalledLocalModel) => {
      if (removingModelPathsRef.current.has(model.modelPath)) return;
      removingModelPathsRef.current.add(model.modelPath);
      setRemovingPaths(s => ({ ...s, [model.modelPath]: true }));
      try {
        const running = runningByPath.get(normalizeModelPathForCompare(model.modelPath)) ?? [];
        await Promise.all(running.map(engine => stopModel(engine.engineId)));
        await removeInstalledLocalModel(model.modelPath);
        setProgress(prev => {
          const next = { ...prev };
          for (const [key, item] of Object.entries(next)) {
            if (item.modelPath === model.modelPath) delete next[key];
          }
          return next;
        });
        await refresh();
      } finally {
        removingModelPathsRef.current.delete(model.modelPath);
        if (mountedRef.current) {
          setRemovingPaths(s => ({ ...s, [model.modelPath]: false }));
        }
      }
    },
    [
      refresh,
      runningByPath,
      stopModel,
    ],
  );

  const hfDownloadKey = selectedHfFile ? ggufDownloadTaskId(selectedHfFile.repo, selectedHfFile.filename) : '';
  const mlxDownloadKey = activeFormat === 'mlx' && hfRepo ? snapshotDownloadTaskId(hfRepo) : '';
  const activeKey = activeFormat === 'gguf' ? hfDownloadKey : mlxDownloadKey;
  const activeProgress = activeKey ? progress[activeKey] : undefined;
  const mlxTotalBytes = useMemo(
    () => hfFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    [hfFiles],
  );
  const lowSpace =
    activeFormat === 'gguf' &&
    selectedHfFile != null &&
    freeBytes != null &&
    selectedHfFile.sizeBytes > freeBytes;
  const lowSpaceMlx =
    activeFormat === 'mlx' &&
    hfFiles.length > 0 &&
    freeBytes != null &&
    mlxTotalBytes > freeBytes;

  // Promote ONE obvious default (most capable model that comfortably fits) and
  // demote the rest. Shares pickPrimaryStarterId with the first-run wizard so
  // the two surfaces never recommend different starters on the same machine.
  const primaryStarterId = pickPrimaryStarterId(recommended, status?.total_memory_bytes);
  const primaryEntry = recommended.find(e => e.id === primaryStarterId) ?? null;
  const otherStarters = recommended.filter(e => e.id !== primaryStarterId);

  const modelLabelForPath = useCallback(
    (modelPath: string): string => {
      const key = normalizeModelPathForCompare(modelPath);
      return (
        installed.find(model => normalizeModelPathForCompare(model.modelPath) === key)?.label ??
        modelPath.split(/[\\/]/).pop() ??
        t.modelManagerUnknown
      );
    },
    [installed, t.modelManagerUnknown],
  );

  // First-run coverage CTA: with no engine and no installed models, "fill
  // missing roles" has nothing to assign, so the button instead kicks off the
  // primary recommended install (same path the Recommended shelf uses). This
  // keeps the most prominent action alive on the fresh-install path instead of
  // rendering a dead disabled button. Falls back to scrolling to the shelf when
  // no primary entry exists (e.g. web preview / empty catalog).
  const installPrimaryStarter = useCallback(() => {
    if (primaryEntry) {
      const entryFormat =
        resolveStarterFormat(primaryEntry, RECOMMENDED_FORMAT) ?? RECOMMENDED_FORMAT;
      const progressKey = `catalog:${primaryEntry.id}:${entryFormat}`;
      void installAndUseCatalogEntry(primaryEntry, progressKey);
      return;
    }
    recommendedShelfRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [installAndUseCatalogEntry, primaryEntry]);

  const fillMissingRoles = useCallback(() => {
    const roles = coverage.notReadyRoles;
    if (roles.length === 0) return;
    if (runningModel) {
      startModel(
        runningModel.modelPath,
        runningModel.format,
        modelLabelForPath(runningModel.modelPath),
        roles,
      );
      return;
    }
    const firstInstalled = installed[0];
    if (firstInstalled) {
      startModel(firstInstalled.modelPath, firstInstalled.format, firstInstalled.label, roles);
      return;
    }
    // No engine and nothing installed: send the user to install the first model.
    installPrimaryStarter();
  }, [coverage.notReadyRoles, installed, installPrimaryStarter, modelLabelForPath, runningModel, startModel]);

  const roleStatusVariant = (status: CapabilityCoverageRole['status']) => {
    if (status === 'ready') return 'success' as const;
    if (status === 'stopped') return 'gold' as const;
    // Missing/unbound is a to-do state, not neutral filler — surface it with the
    // same danger semantic the Providers tab uses so "needs a model" reads
    // consistently across both tabs (was 'muted' grey).
    return 'danger' as const;
  };

  const roleStatusLabel = (status: CapabilityCoverageRole['status']) => {
    if (status === 'ready') return t.modelCapabilityReady;
    if (status === 'stopped') return t.modelCapabilityStopped;
    return t.modelCapabilityUnbound;
  };

  const modelDirDisplay = status?.model_dir_error
    ? t.modelManagerModelDirUnavailable
    : status?.model_dir
      ? compactHomePath(status.model_dir)
      : t.localModelsModelDirDesktopOnly;
  const modelDirProblem = modelDirError ?? (
    status?.model_dir_error ? recoveryMessage(status.model_dir_error, t) : null
  );

  const renderStarterCard = (entry: CuratedModelEntry, isPrimary: boolean) => {
    const fit = fitForEntry(entry);
    const installedModel = installedForEntry(entry);
    const entryFormat = resolveStarterFormat(entry, RECOMMENDED_FORMAT);
    const progressKey = `catalog:${entry.id}:${entryFormat ?? RECOMMENDED_FORMAT}`;
    const item = progress[progressKey];
    // An installed file outranks a stale failed/cancelled progress entry —
    // the reconcile effect prunes these from storage, but the precedence here
    // keeps the very first paint truthful too.
    const staleFailure = installedModel != null && (item?.state === 'failed' || item?.state === 'cancelled');
    const state = staleFailure ? 'ready' : item?.state ?? (installedModel ? 'ready' : 'idle');
    const modelPath = installedModel?.modelPath ?? item?.modelPath;
    const engineUseState = modelPath ? useStates[modelPath]?.state : undefined;
    const running = modelPath ? runningByPath.get(normalizeModelPathForCompare(modelPath))?.[0] : undefined;
    const catalogKey = starterCatalogFilesKey(entry, RECOMMENDED_FORMAT);
    const loadingFiles = Boolean(catalogFilesLoading[catalogKey]);
    const canInstall =
      desktop &&
      Boolean(status?.model_dir) &&
      fit.state !== 'bad' &&
      !loadingFiles &&
      state !== 'downloading' &&
      state !== 'verifying' &&
      !running;
    const unavailableLabel = desktop
      ? t.modelManagerModelDirUnavailable
      : t.modelManagerDesktopOnly;
    return (
      <div
        key={entry.id}
        className={cn(
          'rounded-md border bg-book-bg-card',
          isPrimary
            ? 'border-book-gold/50 p-4 shadow-sm ring-1 ring-book-gold/15'
            : 'border-book-border p-3',
        )}
      >
        {isPrimary && (
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-book-gold">
            <Sparkles className="h-3.5 w-3.5" />
            {installed.length > 0
              ? t.modelManagerSupplementStarter
              : t.modelManagerRecommendedStarter}
          </div>
        )}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={cn('truncate font-medium text-book-ink-primary', isPrimary ? 'text-base' : 'text-sm')}>
              {entry.name}
            </div>
            <div className="mt-1 text-xs-tight text-book-ink-muted">
              {roleSummary(entry, t)}
              {entry.sizeHint ? ` · ${entry.sizeHint}` : ''}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs-tight text-book-ink-muted">
              <Badge variant={FIT_BADGE_VARIANT[fit.state]}>{fit.label}</Badge>
              {entry.languages?.includes('zh') && (
                <Badge variant="gold">{t.modelLangBadgeZh}</Badge>
              )}
              <span>{fit.detail}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {running && <Badge variant="success">{t.modelManagerEngineRunning}</Badge>}
            {!running && state === 'ready' && (
              <Badge variant="success">{t.modelManagerInstalled}</Badge>
            )}
            {(state === 'downloading' || state === 'verifying') && (
              <Badge variant="info">
                {item?.percent != null
                  ? `${item.label} ${item.percent}%`
                  : item?.label ?? t.modelManagerStateDownloading}
              </Badge>
            )}
            {state === 'failed' && (
              <Badge variant="danger">{t.modelManagerStateFailed}</Badge>
            )}
            {state === 'cancelled' && (
              <Badge variant="muted">{t.modelManagerStateCancelled}</Badge>
            )}
            {state === 'idle' && fit.state === 'bad' && (
              <Badge variant="danger">{t.modelManagerFitBad}</Badge>
            )}
            {!running && (
              <Button
                type="button"
                variant={isPrimary ? (state === 'ready' ? 'outline' : 'accent') : 'outline'}
                size="sm"
                title={!status?.model_dir && state !== 'ready' ? unavailableLabel : undefined}
                disabled={!canInstall && state !== 'ready'}
                onClick={() => void installAndUseCatalogEntry(entry, progressKey)}
              >
                {state === 'failed' || state === 'cancelled' ? (
                  <RefreshCw className="h-3.5 w-3.5" />
                ) : engineUseState === 'starting' || state === 'downloading' || state === 'verifying' ? (
                  <Spinner size="sm" />
                ) : state === 'ready' ? (
                  <Play className="h-3.5 w-3.5" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {engineUseState === 'starting'
                  ? t.modelManagerEngineStarting
                  : state === 'ready'
                    ? t.modelManagerStartAndAssign
                    : state === 'failed' || state === 'cancelled'
                      ? t.modelManagerRetry
                      : installed.length > 0
                        ? t.modelManagerInstallSupplement
                        : t.modelManagerInstallAndUse}
              </Button>
            )}
            {(state === 'downloading' || state === 'verifying') && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void cancelKey(progressKey)}
              >
                {t.modelManagerCancelDownload}
              </Button>
            )}
          </div>
        </div>
        <DownloadProgressBar
          dlKey={progressKey}
          progress={progress}
          cancelKey={cancelKey}
          t={t}
        />
        {state === 'failed' && (
          <p className="mt-2 text-xs-tight text-book-danger">
            {recoveryMessage(item?.error, t)}
          </p>
        )}
        {modelPath && useStates[modelPath]?.state === 'failed' && (
          <p className="mt-2 text-xs-tight text-book-danger">
            {recoveryMessage(useStates[modelPath].error, t)}
          </p>
        )}
      </div>
    );
  };

  if (loading && installed.length === 0 && !showAdvancedManager) {
    return (
      <section className="flex min-h-48 items-center justify-center" aria-busy="true">
        <span className="text-sm text-book-ink-muted">{t.loading}...</span>
      </section>
    );
  }

  if (installed.length === 0 && !showAdvancedManager) {
    return (
      <StudioFirstRunWizard
        installedCount={0}
        onBrowseAllModels={() => setShowAdvancedManager(true)}
        onImportGguf={() => void importExistingModel('gguf')}
        onImportMlx={isMac ? () => void importExistingModel('mlx') : undefined}
        importing={importing}
        importError={importError}
      />
    );
  }

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-book-ink-muted" />
        <h3 className="flex-1 text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
          {t.localModelsTitle}
        </h3>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={t.desktopRuntimeRefresh}
          title={t.desktopRuntimeRefresh}
        >
          {loading ? <Spinner size="sm" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      <div className="rounded-md border border-book-border bg-book-bg-card p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-book-ink-primary">
              {t.modelManagerCapabilityTitle}
            </div>
            <div className="mt-1 text-xs leading-5 text-book-ink-muted">
              {coverage.complete
                ? t.modelManagerCapabilityComplete
                : coverage.readyCount > 0
                  ? t.modelManagerCapabilityPartial
                      .replace('{ready}', String(coverage.readyCount))
                      .replace('{total}', String(coverage.totalCount))
                  : installed.length > 0
                    ? t.modelManagerCapabilityInstalledNoRoles
                    : t.modelManagerCapabilityEmpty}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
            <Badge variant={coverage.complete ? 'success' : coverage.readyCount > 0 ? 'gold' : 'muted'}>
              {t.modelManagerCapabilityCount
                .replace('{ready}', String(coverage.readyCount))
                .replace('{total}', String(coverage.totalCount))}
            </Badge>
            {runningModel && <Badge variant="success">{t.modelManagerEngineRunning}</Badge>}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {coverage.roles.map(row => (
            <div
              key={row.role}
              className="rounded-md border border-book-border bg-book-bg-secondary/45 px-2.5 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-book-ink-primary">
                  {roleChipLabel(row.role, t)}
                </span>
                <Badge variant={roleStatusVariant(row.status)}>
                  {roleStatusLabel(row.status)}
                </Badge>
              </div>
              <div className="mt-1 truncate text-xs-tight text-book-ink-muted">
                {row.modelId
                  ? row.modelId
                  : t.modelCapabilityNoModel}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {coverage.notReadyRoles.length > 0 && (
            <Button
              type="button"
              variant="accent"
              size="sm"
              disabled={!desktop}
              onClick={fillMissingRoles}
            >
              {runningModel || installed.length > 0 ? (
                <Play className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {runningModel || installed.length > 0
                ? t.modelManagerCapabilityFillMissing
                : t.modelManagerCapabilityInstallFirst}
            </Button>
          )}
          {openProviders && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openProviders}
            >
              {t.modelManagerCapabilityOpenRouting}
            </Button>
          )}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 text-xs-tight text-book-ink-muted sm:grid-cols-2">
          <div className="flex min-w-0 items-center gap-2">
            <Cpu className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{hardwareLabel}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <HardDrive className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {freeBytes != null
                ? t.modelManagerFreeSpace.replace('{free}', formatBytes(freeBytes))
                : t.localModelsFreeSpaceDesktopOnly}
            </span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:col-span-2">
            <FolderDown className="h-3.5 w-3.5 shrink-0" />
            <span className="shrink-0 font-medium text-book-ink-secondary">
              {t.modelManagerModelDirLabel}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-mono text-xs',
                status?.model_dir_error ? 'text-book-danger' : 'text-book-ink-muted',
              )}
              title={status?.model_dir ?? undefined}
            >
              {modelDirDisplay}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!desktop || modelDirBusy}
              onClick={() => void changeModelDir()}
            >
              {modelDirBusy ? (
                <Spinner size="sm" />
              ) : (
                <FolderOpen className="h-3.5 w-3.5" />
              )}
              {t.modelManagerChangeFolder}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!desktop || !status?.model_dir || modelDirBusy}
              onClick={() => void revealConfiguredModelDir()}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t.modelManagerRevealFolder}
            </Button>
            {status?.model_dir_error && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!desktop || modelDirBusy}
                onClick={() => void restoreDefaultModelDir()}
              >
                {t.modelManagerRestoreDefaultFolder}
              </Button>
            )}
            {modelDirProblem && (
              <span className="basis-full text-xs-tight text-book-danger">
                {modelDirProblem}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {runningModel
                ? t.modelManagerReadinessRunning.replace(
                    '{model}',
                    runningModel.modelPath.split(/[\\/]/).pop() ?? t.modelManagerEngineRunning,
                  )
                : t.modelManagerReadinessInstalled.replace('{count}', String(installed.length))}
            </span>
          </div>
        </div>
        {!desktop && (
          <p className="mt-3 rounded-md border border-dashed border-book-border px-3 py-2 text-xs text-book-ink-muted">
            {t.modelManagerDesktopOnly}
          </p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <HardDrive className="h-3.5 w-3.5 text-book-ink-muted" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
              {t.modelManagerInstalled}
            </h4>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!desktop || importing}
              onClick={() => void importExistingModel('gguf')}
            >
              {importing ? (
                <Spinner size="sm" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {t.modelManagerImportGguf}
            </Button>
            {isMac && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!desktop || importing}
                onClick={() => void importExistingModel('mlx')}
              >
                {importing ? (
                  <Spinner size="sm" />
                ) : (
                  <FolderOpen className="h-3.5 w-3.5" />
                )}
                {t.modelManagerImportMlx}
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs-tight text-book-ink-muted">{t.modelManagerLocalFormatHelp}</p>
        {importError && <p className="text-xs-tight text-book-danger">{importError}</p>}
        {installed.length === 0 ? (
          <div className="rounded-md border border-dashed border-book-border px-3 py-3 text-xs text-book-ink-muted">
            {t.modelManagerInstalledEmpty}
          </div>
        ) : (
          <div className="space-y-2">
            {installed.map(model => {
              const fmt = model.format as EngineFormat;
              const running = runningByPath.get(normalizeModelPathForCompare(model.modelPath))?.[0];
              const removing = removingPaths[model.modelPath];
              const state = useStates[model.modelPath]?.state ?? 'idle';
              const boundRoles = running ? rolesByEngineId.get(running.engineId) ?? [] : [];
              return (
                <div
                  key={model.modelPath}
                  className="rounded-md border border-book-border bg-book-bg-card p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-book-ink-primary">
                        {model.label}
                      </div>
                      <div className="mt-1 grid grid-cols-1 gap-1 text-xs-tight text-book-ink-muted">
                        <span>
                          {formatLabel(fmt, t)} · {formatBytes(model.sizeBytes)}
                        </span>
                        <span className="truncate">
                          {t.modelManagerSource}:{' '}
                          {model.sourceRepo ?? t.modelManagerSourceLocal}
                        </span>
                        <span>
                          {t.modelManagerInstalledDate}:{' '}
                          {installDate(model.installedAtUnix, t)}
                        </span>
                        {running && (
                          <span>{t.modelManagerRunningPort.replace('{port}', String(running.port))}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <Badge variant={running ? 'success' : 'muted'}>
                        {running ? t.modelManagerEngineRunning : t.modelManagerStateReady}
                      </Badge>
                      <div className="flex max-w-[18rem] flex-wrap items-center justify-end gap-1">
                        <span className="text-xs-tight text-book-ink-muted">
                          {t.localModelsBoundRoles}:
                        </span>
                        {boundRoles.length > 0 ? (
                          boundRoles.map(role => (
                            <Badge key={role} variant="info">
                              {roleChipLabel(role, t)}
                            </Badge>
                          ))
                        ) : (
                          <Badge variant="muted">{t.localModelsUnassigned}</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {running ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void stopModel(running.engineId)}
                      >
                        <Square className="h-3.5 w-3.5" />
                        {t.modelManagerStop}
                      </Button>
                    ) : (
                      <UseModelButton
                        modelPath={model.modelPath}
                        fmt={fmt}
                        label={model.label}
                        useStates={useStates}
                        runningByPath={runningByPath}
                        desktop={desktop}
                        startModel={startModel}
                        t={t}
                      />
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void revealLocalModel(model.modelPath)}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      {t.modelManagerReveal}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={removing}
                      onClick={() => setPendingRemoval(model)}
                    >
                      {removing ? (
                        <Spinner size="sm" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      {removing
                        ? t.modelManagerRemoving
                        : model.managedByApp
                          ? t.modelManagerRemove
                          : t.modelManagerUnregister}
                    </Button>
                  </div>
                  {state === 'failed' && (
                    <p className="mt-2 text-xs-tight text-book-danger">
                      {recoveryMessage(useStates[model.modelPath]?.error, t)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div ref={recommendedShelfRef} className="scroll-mt-4 space-y-3">
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-book-ink-muted" />
          <h4 className="text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
            {installed.length > 0
              ? t.modelManagerSupplementRecommended
              : isMac
                ? t.modelManagerRecommendedForMac
                : t.modelManagerRecommendedForDevice}
          </h4>
        </div>
        <div className="space-y-2">
          {primaryEntry && renderStarterCard(primaryEntry, true)}
          {otherStarters.length > 0 && (
            <div className="space-y-2 pt-1">
              <div className="px-0.5 text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
                {t.modelManagerMoreStarters}
              </div>
              {otherStarters.map(entry => renderStarterCard(entry, false))}
            </div>
          )}
        </div>
      </div>

      <Collapsible
        open={hfSearchOpen}
        onOpenChange={setHfSearchOpen}
        className="rounded-md border border-book-border bg-book-bg-card p-3"
      >
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex w-full justify-start gap-2 px-0 text-book-ink-secondary hover:bg-transparent hover:text-book-ink-primary"
          >
            <Search className="h-3.5 w-3.5 text-book-ink-muted" />
            <span className="text-xs font-semibold uppercase tracking-wider">
              {t.modelManagerSearchTitle}
            </span>
            <Badge variant="muted">{t.modelManagerSearchHint}</Badge>
            {hfSearchOpen ? (
              <ChevronDown className="ml-auto h-3.5 w-3.5 text-book-ink-muted" />
            ) : (
              <ChevronRight className="ml-auto h-3.5 w-3.5 text-book-ink-muted" />
            )}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 space-y-3">
          {isMac && (
            <div className="space-y-2 rounded-md border border-book-border bg-book-bg-secondary/45 p-2.5">
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant={activeFormat === 'gguf' ? 'accent' : 'outline'}
                  size="sm"
                  onClick={() => {
                    resetHfSelection();
                    setFormat('gguf');
                  }}
                >
                  {t.modelManagerFormatGguf}
                </Button>
                <Button
                  type="button"
                  variant={activeFormat === 'mlx' ? 'accent' : 'outline'}
                  size="sm"
                  onClick={() => {
                    resetHfSelection();
                    setFormat('mlx');
                  }}
                >
                  {t.modelManagerFormatMlx}
                </Button>
              </div>
              <p className="text-xs-tight text-book-ink-muted">
                {activeFormat === 'mlx'
                  ? t.modelManagerMlxFormatHelp
                  : t.modelManagerGgufFormatHelp}
              </p>
            </div>
          )}
          <div className="flex items-end gap-2">
            <Input
              value={hfQuery}
              placeholder={
                activeFormat === 'mlx'
                  ? t.modelManagerHfSearchPlaceholderMlx
                  : t.modelManagerHfSearchPlaceholder
              }
              onChange={event => setHfQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void runHfSearch();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void runHfSearch()}
              disabled={hfSearching || !hfQuery.trim()}
            >
              <Search className="h-3.5 w-3.5" />
              {t.modelManagerHfSearch}
            </Button>
          </div>
          {hfSearchError && <p className="text-xs-tight text-book-danger">{hfSearchError}</p>}
          {!hfSearchError && hfResults.length === 0 && !hfSearching && hfQuery.trim() && (
            <p className="text-xs-tight text-book-ink-muted">{t.modelManagerHfNoResults}</p>
          )}
          {hfResults.length > 0 && (
            <ScrollArea className="max-h-40">
              <ul className="space-y-1 pr-3" aria-label={t.modelManagerHfSearch}>
                {hfResults.map(result => (
                  <li key={result.repo}>
                    <Button
                      type="button"
                      variant="unstyled"
                      size="unstyled"
                      aria-pressed={hfRepo === result.repo}
                      onClick={() => void pickRepo(result.repo)}
                      className={`flex w-full items-center justify-between gap-2 border px-2 py-1.5 text-left text-xs-tight transition-colors ${
                        hfRepo === result.repo
                          ? 'border-book-gold bg-book-bg-secondary'
                          : 'border-book-border hover:bg-book-bg-secondary'
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-book-ink-primary">{result.repo}</span>
                        {result.languageHint === 'zh' && (
                          <Badge variant="gold">{t.modelLangBadgeZh}</Badge>
                        )}
                      </span>
                      <span className="shrink-0 text-book-ink-muted">
                        {t.modelManagerHfDownloads.replace('{count}', String(result.downloads))}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
          {hfFilesError && <p className="text-xs-tight text-book-danger">{hfFilesError}</p>}
          {hfFilesLoading && (
            <p className="text-xs-tight text-book-ink-muted">{t.modelManagerHfLoadingFiles}</p>
          )}

          {activeFormat === 'gguf' && hfRepo && hfFiles.length > 0 && (
            <div className="space-y-2">
              <Select value={hfFilename} onValueChange={setHfFilename}>
                <SelectTrigger>
                  <SelectValue placeholder={t.modelManagerHfPickFile} />
                </SelectTrigger>
                <SelectContent>
                  {hfFiles.map(file => (
                    <SelectItem key={file.filename} value={file.filename}>
                      {file.filename}
                      {file.quant ? ` · ${file.quant}` : ''} · {formatBytes(file.sizeBytes)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {lowSpace && <p className="text-xs-tight text-book-danger">{t.modelManagerLowSpace}</p>}
              <DownloadProgressBar
                dlKey={hfDownloadKey}
                progress={progress}
                cancelKey={cancelKey}
                t={t}
              />
              {activeProgress?.state !== 'downloading' &&
                activeProgress?.state !== 'verifying' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!selectedHfFile || !desktop || !status?.model_dir || lowSpace}
                      onClick={() => {
                        if (selectedHfFile && status?.model_dir) {
                          void downloadGguf(selectedHfFile, status.model_dir);
                        }
                      }}
                    >
                      {activeProgress?.state === 'failed' ||
                      activeProgress?.state === 'cancelled' ? (
                        <RefreshCw className="h-3.5 w-3.5" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      {activeProgress?.state === 'failed'
                        ? t.modelManagerRetry
                        : activeProgress?.state === 'cancelled'
                          ? t.modelManagerRedownload
                          : t.modelManagerDownload}
                    </Button>
                    {activeProgress?.state === 'ready' && activeProgress.modelPath && (
                      <UseModelButton
                        modelPath={activeProgress.modelPath}
                        fmt="gguf"
                        label={hfFilename.replace(/\.gguf$/i, '')}
                        useStates={useStates}
                        runningByPath={runningByPath}
                        desktop={desktop}
                        startModel={startModel}
                        t={t}
                      />
                    )}
                  </div>
                )}
              {activeProgress?.state === 'failed' && (
                <p className="text-xs-tight text-book-danger">
                  {recoveryMessage(activeProgress.error, t)}
                </p>
              )}
            </div>
          )}

          {activeFormat === 'mlx' && hfRepo && !hfFilesLoading && (
            <div className="space-y-2">
              {hfFiles.length > 0 ? (
                <p className="text-xs-tight text-book-ink-muted">
                  {t.modelManagerMlxSnapshotSummary
                    .replace('{count}', String(hfFiles.length))
                    .replace('{size}', formatBytes(mlxTotalBytes))}
                </p>
              ) : !hfFilesError ? (
                <p className="text-xs-tight text-book-ink-muted">{t.modelManagerHfNoResults}</p>
              ) : null}
              <DownloadProgressBar
                dlKey={mlxDownloadKey}
                progress={progress}
                cancelKey={cancelKey}
                t={t}
              />
              {activeProgress?.state !== 'downloading' &&
                activeProgress?.state !== 'verifying' &&
                hfFiles.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!desktop || !status?.model_dir || lowSpaceMlx}
                      onClick={() => {
                        if (status?.model_dir && hfRepo) {
                          void downloadSnapshot(hfRepo, hfFiles, status.model_dir);
                        }
                      }}
                    >
                      {activeProgress?.state === 'failed' ||
                      activeProgress?.state === 'cancelled' ? (
                        <RefreshCw className="h-3.5 w-3.5" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      {activeProgress?.state === 'failed'
                        ? t.modelManagerRetry
                        : activeProgress?.state === 'cancelled'
                          ? t.modelManagerRedownload
                          : t.modelManagerDownload}
                    </Button>
                    {activeProgress?.state === 'ready' && activeProgress.modelPath && hfRepo && (
                      <UseModelButton
                        modelPath={activeProgress.modelPath}
                        fmt="mlx"
                        label={hfRepo.split('/').pop() ?? hfRepo}
                        useStates={useStates}
                        runningByPath={runningByPath}
                        desktop={desktop}
                        startModel={startModel}
                        t={t}
                      />
                    )}
                  </div>
                )}
              {activeProgress?.state === 'failed' && (
                <p className="text-xs-tight text-book-danger">
                  {recoveryMessage(activeProgress.error, t)}
                </p>
              )}
              {lowSpaceMlx && <p className="text-xs-tight text-book-danger">{t.modelManagerLowSpace}</p>}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      <EngineLaunchRoleDialog
        open={pendingLaunch !== null}
        plan={pendingLaunch}
        presetRoles={pendingLaunch?.presetRoles}
        onOpenChange={value => {
          if (!value) cancelPendingLaunch();
        }}
        onSuccess={handleLaunchSuccess}
        onCancel={cancelPendingLaunch}
      />

      <Dialog open={pendingRemoval !== null} onOpenChange={open => { if (!open) setPendingRemoval(null); }}>
        {pendingRemoval && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="font-serif text-xl">
                {pendingRemoval.managedByApp ? t.modelManagerRemove : t.modelManagerUnregister}
              </DialogTitle>
              <DialogDescription className="leading-relaxed text-book-ink-secondary">
                {(pendingRemoval.managedByApp ? t.modelManagerRemoveConfirm : t.modelManagerUnregisterConfirm).replace('{model}', pendingRemoval.label)}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setPendingRemoval(null)}
                className="h-auto border border-book-border bg-book-bg-card px-4 py-2 text-sm font-medium text-book-ink-primary hover:bg-book-bg-card"
              >
                {t.modelManagerCancel}
              </Button>
              <Button
                type="button"
                variant="accent"
                onClick={() => {
                  const model = pendingRemoval;
                  setPendingRemoval(null);
                  void removeModel(model);
                }}
                className="h-auto px-4 py-2 text-sm font-medium"
              >
                {pendingRemoval.managedByApp ? t.modelManagerRemove : t.modelManagerUnregister}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
