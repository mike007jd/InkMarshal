'use client';

import {
  bootstrapNovelVaultRootAction,
  getNovelVaultStatus,
  reconcileVaultChangedFiles,
} from '@/app/actions/vault';
import { drainKnowledgeVaultOutboxAction } from '@/app/actions/vault-outbox';
import { isTauriRuntime } from '@/lib/desktop-runtime';
import {
  chunkLiveVaultMarkdownPaths,
  collectLiveVaultChangedFiles,
} from '@/lib/vault/live-reconcile';
import {
  vaultReadFile,
  vaultReachable,
  vaultWatchStart,
  vaultWatchStop,
} from '@/lib/vault/ipc';
import {
  publishVaultEntriesChanged,
  subscribeVaultPathChanged,
} from '@/lib/vault/runtime-events';
import { reconcileVaultSnapshot } from '@/lib/vault/snapshot-reconcile';
import type { VaultChangedEvent, VaultChangedKind } from '@/lib/vault/types';

const VAULT_CHANGED_EVENT = 'vault://changed';

const OFFLINE_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** Deterministic reconcile batch order; also the allowlist for event kinds. */
const VAULT_CHANGED_KIND_ORDER = [
  'create',
  'modify',
  'rename',
  'remove',
  'other',
] as const satisfies readonly VaultChangedKind[];
const VAULT_CHANGED_KINDS = new Set<VaultChangedKind>(VAULT_CHANGED_KIND_ORDER);

function coarsenVaultChangedKind(
  existing: VaultChangedKind | undefined,
  incoming: VaultChangedKind,
): VaultChangedKind {
  if (!existing) return incoming;
  const rank = (kind: VaultChangedKind): number => (
    kind === 'remove' ? 5
      : kind === 'rename' ? 4
        : kind === 'create' ? 3
          : kind === 'other' ? 2
            : 1
  );
  return rank(incoming) >= rank(existing) ? incoming : existing;
}

type VaultEventListen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

export interface VaultRuntimeCoordinatorOptions {
  getActiveNovelId: () => string | null;
  listen?: VaultEventListen;
  onError?: (error: unknown) => void;
  /** Test seam — override timers. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

interface WatchedVault {
  novelId: string;
  vaultPath: string;
  watchId: string;
  watchGeneration: number;
  /** False while `vault_version <= 0` — live remove/rename must not delete DB. */
  deleteEligible: boolean;
}

let lastWatchGeneration = 0;

function newWatchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `watch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newWatchGeneration(): number {
  lastWatchGeneration = Math.max(lastWatchGeneration + 1, Date.now());
  return lastWatchGeneration;
}

/** Novel id only from `/novel/[id]` routes — never treat a series route id as a novel. */
export function novelIdFromStudioRoute(
  pathname: string | null | undefined,
  params: { id?: string | string[] } | null | undefined,
): string | null {
  if (!pathname || !pathname.startsWith('/novel/')) return null;
  const id = params?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function parseVaultChangedEvent(payload: unknown): VaultChangedEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const novelId = raw.novelId;
  const kind = raw.kind;
  const paths = raw.paths;
  if (typeof novelId !== 'string' || !novelId) return null;
  if (typeof kind !== 'string' || !VAULT_CHANGED_KINDS.has(kind as VaultChangedKind)) return null;
  if (!Array.isArray(paths) || !paths.every(p => typeof p === 'string')) return null;
  const watchId = raw.watchId;
  if (typeof watchId !== 'string' || watchId.length === 0) return null;
  return {
    novelId,
    kind: kind as VaultChangedKind,
    paths: paths as string[],
    watchId,
  };
}

async function defaultListen(
  event: string,
  handler: (event: { payload: unknown }) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen(event, handler);
  return () => {
    void unlisten();
  };
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/**
 * Headless desktop runtime: one watcher per active novel vault, live reconcile
 * on exact `vault://changed` payloads, and bounded durable outbox drain on
 * startup / reachability / event activity.
 */
export function createVaultRuntimeCoordinator(options: VaultRuntimeCoordinatorOptions) {
  const listen = options.listen ?? defaultListen;
  const onError = options.onError ?? ((error: unknown) => {
    console.warn('[vault/runtime]', error);
  });
  const schedule = options.schedule ?? defaultSchedule;

  let disposed = false;
  let unlisten: (() => void) | null = null;
  let unsubPathChanged: (() => void) | null = null;
  let unsubFocus: (() => void) | null = null;
  let unsubOnline: (() => void) | null = null;
  let watched: WatchedVault | null = null;
  /** Every watcher this coordinator successfully started (for dispose cleanup). */
  const startedWatchers: WatchedVault[] = [];
  let syncGeneration = 0;
  let drainInFlight: Promise<void> | null = null;
  /** Serialized snapshot + live reconcile for the active generation. */
  let reconcileQueue: Promise<void> = Promise.resolve();
  /** Latest kind per path across queued live events. */
  const pendingPathKinds = new Map<string, VaultChangedKind>();
  let pendingNovelId: string | null = null;
  let offlineBackoffIndex = 0;
  let cancelOfflineProbe: (() => void) | null = null;
  let offlineProbeInFlight: Promise<void> | null = null;
  let syncQueue: Promise<void> = Promise.resolve();
  let runtimeStarted = false;

  function clearOfflineProbe(): void {
    cancelOfflineProbe?.();
    cancelOfflineProbe = null;
  }

  function enqueueReconcile(task: () => Promise<void>): Promise<void> {
    const run = reconcileQueue.then(task, task);
    reconcileQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function drainOutbox(novelId?: string): Promise<void> {
    if (disposed || !isTauriRuntime()) return;
    const run = async () => {
      try {
        await drainKnowledgeVaultOutboxAction(novelId);
        if (novelId) publishVaultEntriesChanged(novelId);
      } catch (error) {
        onError(error);
      }
    };
    if (drainInFlight) {
      await drainInFlight;
      if (disposed) return;
    }
    const pending = run();
    drainInFlight = pending;
    try {
      await pending;
    } finally {
      if (drainInFlight === pending) drainInFlight = null;
    }
  }

  async function stopExactWatcher(target: WatchedVault): Promise<void> {
    try {
      await vaultWatchStop(
        target.novelId,
        target.vaultPath,
        target.watchId,
        target.watchGeneration,
      );
    } catch (error) {
      onError(error);
    }
  }

  async function stopWatcher(): Promise<void> {
    const current = watched;
    watched = null;
    pendingPathKinds.clear();
    pendingNovelId = null;
    if (!current) return;
    await stopExactWatcher(current);
  }

  async function stopAllStartedWatchers(): Promise<void> {
    const targets = startedWatchers.splice(0, startedWatchers.length);
    watched = null;
    for (const target of targets) {
      await stopExactWatcher(target);
    }
  }

  function scheduleOfflineProbe(novelId: string, vaultPath: string, generation: number): void {
    if (disposed) return;
    clearOfflineProbe();
    const delay = OFFLINE_BACKOFF_MS[Math.min(offlineBackoffIndex, OFFLINE_BACKOFF_MS.length - 1)]!;
    offlineBackoffIndex = Math.min(offlineBackoffIndex + 1, OFFLINE_BACKOFF_MS.length - 1);
    cancelOfflineProbe = schedule(() => {
      void runOfflineProbe(novelId, vaultPath, generation);
    }, delay);
  }

  async function runOfflineProbe(
    novelId: string,
    vaultPath: string,
    generation: number,
  ): Promise<void> {
    if (disposed || generation !== syncGeneration) return;
    if (offlineProbeInFlight) {
      await offlineProbeInFlight;
      return;
    }
    const probe = (async () => {
      try {
        const reach = await vaultReachable(vaultPath);
        if (disposed || generation !== syncGeneration) return;
        if (reach.reachable) {
          offlineBackoffIndex = 0;
          clearOfflineProbe();
          await syncActiveNovel();
        } else {
          scheduleOfflineProbe(novelId, vaultPath, generation);
        }
      } catch (error) {
        onError(error);
        if (!disposed && generation === syncGeneration) {
          scheduleOfflineProbe(novelId, vaultPath, generation);
        }
      }
    })();
    offlineProbeInFlight = probe;
    try {
      await probe;
    } finally {
      if (offlineProbeInFlight === probe) offlineProbeInFlight = null;
    }
  }

  async function startWatcherFor(novelId: string, generation: number): Promise<void> {
    const status = await getNovelVaultStatus(novelId);
    if (disposed || generation !== syncGeneration) return;
    if (!status.vaultPath) return;

    const reach = await vaultReachable(status.vaultPath).catch(() => ({
      reachable: false,
      writable: false,
    }));
    if (disposed || generation !== syncGeneration) return;
    if (!reach.reachable) {
      scheduleOfflineProbe(novelId, status.vaultPath, generation);
      return;
    }

    offlineBackoffIndex = 0;
    clearOfflineProbe();

    const watchId = newWatchId();
    const watchGeneration = newWatchGeneration();
    const pendingRoot = (status.vaultVersion ?? 1) <= 0;
    const next: WatchedVault = {
      novelId,
      vaultPath: status.vaultPath,
      watchId,
      watchGeneration,
      deleteEligible: !pendingRoot,
    };

    try {
      await vaultWatchStart(novelId, status.vaultPath, watchId, watchGeneration);
    } catch (error) {
      if (disposed || generation !== syncGeneration) {
        try {
          await vaultWatchStop(novelId, status.vaultPath, watchId, watchGeneration);
        } catch { /* best-effort */ }
        return;
      }
      throw error;
    }

    if (disposed || generation !== syncGeneration) {
      // Stale start finished — stop this exact watchId and never assign shared state.
      await stopExactWatcher(next);
      return;
    }

    watched = next;
    startedWatchers.push(next);

    try {
      await enqueueReconcile(() => runRootReconcileLocked(novelId, watchId, generation));
    } catch (error) {
      // Keep the watcher delete-ineligible so focus/online / next events can
      // retry without dropping queued remove/rename paths.
      if (watched?.watchId === watchId) {
        watched.deleteEligible = false;
      }
      throw error;
    }
  }

  async function runRootReconcileLocked(
    novelId: string,
    watchId: string,
    generation: number,
  ): Promise<void> {
    if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
    const current = watched;
    if (!current || current.novelId !== novelId) return;

    const status = await getNovelVaultStatus(novelId);
    if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
    if (!status.vaultPath || status.vaultPath !== current.vaultPath) return;

    const pendingRoot = (status.vaultVersion ?? 1) <= 0;
    if (pendingRoot) {
      // Pending transition: non-destructive snapshot first (never delete),
      // then fenced bootstrap (missing-only project + CAS promote).
      await reconcileVaultSnapshot(
        novelId,
        status.vaultPath,
        {
          failOnReconcileError: true,
          allowMissingFileDeletes: false,
          rootFence: {
            expectedRoot: status.vaultPath,
            expectedToken: status.vaultVersion,
          },
        },
      );
      if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
      const prep = await bootstrapNovelVaultRootAction(novelId, {
        expectedRoot: status.vaultPath,
        expectedToken: status.vaultVersion,
      });
      if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
      if (!prep.vaultPath || prep.vaultPath !== status.vaultPath) return;
      if (watched?.watchId === watchId) {
        watched.deleteEligible = prep.allowMissingFileDeletes;
      }
      publishVaultEntriesChanged(novelId);
      if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
      await flushPendingLocked(novelId, watchId);
      if (!prep.allowMissingFileDeletes) return;
      if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
      await drainOutbox(novelId);
      return;
    }

    await reconcileVaultSnapshot(
      novelId,
      status.vaultPath,
      {
        failOnReconcileError: true,
        allowMissingFileDeletes: true,
      },
    );
    if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
    if (watched?.watchId === watchId) watched.deleteEligible = true;
    publishVaultEntriesChanged(novelId);
    if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
    await flushPendingLocked(novelId, watchId);
    if (disposed || generation !== syncGeneration || watched?.watchId !== watchId) return;
    await drainOutbox(novelId);
  }

  async function flushPendingLocked(
    novelId: string,
    watchId: string,
  ): Promise<void> {
    if (disposed) return;
    if (!watched || watched.novelId !== novelId || watched.watchId !== watchId) return;
    if (pendingNovelId !== novelId || pendingPathKinds.size === 0) return;

    const batch = new Map(pendingPathKinds);
    pendingPathKinds.clear();
    const vaultPath = watched.vaultPath;

    // Group by kind for deterministic reconcile batches (paths stay independent).
    const byKind = new Map<VaultChangedKind, string[]>();
    for (const [path, kind] of batch) {
      const list = byKind.get(kind) ?? [];
      list.push(path);
      byKind.set(kind, list);
    }

    const deleteEligible = watched.deleteEligible;
    try {
      for (const kind of VAULT_CHANGED_KIND_ORDER) {
        const paths = byKind.get(kind);
        if (!paths?.length) continue;
        for (const chunk of chunkLiveVaultMarkdownPaths(paths)) {
          if (disposed || watched?.watchId !== watchId) return;
          const { files, deferredDeletePaths } = await collectLiveVaultChangedFiles(
            kind,
            chunk,
            async relPath => (await vaultReadFile(vaultPath, relPath)).content,
            { allowMissingFileDeletes: deleteEligible },
          );
          if (disposed || watched?.watchId !== watchId) return;
          if (deferredDeletePaths.length > 0) {
            pendingNovelId = novelId;
            for (const relPath of deferredDeletePaths) {
              pendingPathKinds.set(
                relPath,
                coarsenVaultChangedKind(pendingPathKinds.get(relPath), kind),
              );
            }
          }
          if (files.length === 0) continue;
          await reconcileVaultChangedFiles(novelId, files);
        }
      }
    } catch (error) {
      // Permission/EIO/server failures are not deletions. Keep the batch
      // pending so focus/online (or the next event) retries it idempotently.
      if (!disposed && watched?.watchId === watchId) {
        pendingNovelId = novelId;
        for (const [path, kind] of batch) {
          pendingPathKinds.set(
            path,
            coarsenVaultChangedKind(pendingPathKinds.get(path), kind),
          );
        }
      }
      throw error;
    }

    if (disposed || watched?.watchId !== watchId) return;
    publishVaultEntriesChanged(novelId);
    await drainOutbox(novelId);
  }

  function handleChanged(rawPayload: unknown): void {
    if (disposed) return;
    const payload = parseVaultChangedEvent(rawPayload);
    if (!payload) {
      onError(new Error('invalid vault://changed payload'));
      return;
    }
    if (!watched || payload.novelId !== watched.novelId) return;
    if (payload.watchId !== watched.watchId) return;

    pendingNovelId = payload.novelId;
    for (const path of payload.paths) {
      pendingPathKinds.set(
        path,
        coarsenVaultChangedKind(pendingPathKinds.get(path), payload.kind),
      );
    }

    const novelId = watched.novelId;
    const watchId = watched.watchId;
    const generation = syncGeneration;
    void enqueueReconcile(
      () => watched?.watchId === watchId && !watched.deleteEligible
        ? runRootReconcileLocked(novelId, watchId, generation)
        : flushPendingLocked(novelId, watchId),
    ).catch(onError);
  }

  async function syncActiveNovelForGeneration(generation: number): Promise<void> {
    if (disposed || generation !== syncGeneration) return;
    const novelId = options.getActiveNovelId();

    if (watched && watched.novelId === novelId) {
      const status = await getNovelVaultStatus(novelId);
      if (generation !== syncGeneration || disposed) return;
      // Path provision/change with the same novel id must restart the watcher
      // generation against the new root (never keep watcher-old / DB-new).
      if (!status.vaultPath || status.vaultPath !== watched.vaultPath) {
        await stopWatcher();
        if (generation !== syncGeneration || disposed) return;
        if (!status.vaultPath) return;
        await startWatcherFor(novelId, generation);
        return;
      }
      const reach = await vaultReachable(watched.vaultPath);
      if (generation !== syncGeneration || disposed) return;
      if (reach.reachable) {
        offlineBackoffIndex = 0;
        const current = watched;
        if (!current.deleteEligible) {
          // Retry pending root transition; queued removes stay until promotion.
          await enqueueReconcile(
            () => runRootReconcileLocked(current.novelId, current.watchId, generation),
          );
        } else {
          await enqueueReconcile(
            () => flushPendingLocked(current.novelId, current.watchId),
          );
          if (generation !== syncGeneration || disposed) return;
          await drainOutbox(current.novelId);
        }
      } else {
        const path = watched.vaultPath;
        const id = watched.novelId;
        await stopWatcher();
        if (generation !== syncGeneration || disposed) return;
        scheduleOfflineProbe(id, path, generation);
      }
      return;
    }

    await stopWatcher();
    if (generation !== syncGeneration || disposed) return;
    if (!novelId) return;
    await startWatcherFor(novelId, generation);
  }

  function syncActiveNovel(): Promise<void> {
    if (disposed || !runtimeStarted || !isTauriRuntime()) return Promise.resolve();
    // Invalidate work already in flight immediately, but serialize the actual
    // Rust stop/start calls. Otherwise an older start that returns late can
    // overwrite the newer registry entry and then exact-stop the only watcher.
    const generation = ++syncGeneration;
    clearOfflineProbe();
    const run = () => syncActiveNovelForGeneration(generation);
    const pending = syncQueue.then(run, run);
    syncQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function start(): Promise<() => void> {
    if (!isTauriRuntime()) return () => undefined;

    try {
      unlisten = await listen(VAULT_CHANGED_EVENT, event => {
        handleChanged(event.payload);
      });
    } catch (error) {
      onError(error);
      throw error;
    }

    if (disposed) {
      unlisten?.();
      unlisten = null;
      return () => undefined;
    }
    runtimeStarted = true;

    unsubPathChanged = subscribeVaultPathChanged(() => {
      if (disposed) return;
      return syncActiveNovel().catch(error => {
        onError(error);
        throw error;
      });
    });

    const onFocusOrOnline = () => {
      if (disposed) return;
      void syncActiveNovel().catch(onError);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocusOrOnline);
      window.addEventListener('online', onFocusOrOnline);
      unsubFocus = () => window.removeEventListener('focus', onFocusOrOnline);
      unsubOnline = () => window.removeEventListener('online', onFocusOrOnline);
    }

    void drainOutbox()
      .then(() => (disposed ? undefined : syncActiveNovel()))
      .catch(onError);

    return () => {
      disposed = true;
      runtimeStarted = false;
      syncGeneration += 1;
      clearOfflineProbe();
      pendingPathKinds.clear();
      pendingNovelId = null;
      const stopListen = unlisten;
      unlisten = null;
      stopListen?.();
      unsubPathChanged?.();
      unsubPathChanged = null;
      unsubFocus?.();
      unsubFocus = null;
      unsubOnline?.();
      unsubOnline = null;
      void stopAllStartedWatchers();
    };
  }

  return {
    start,
    syncActiveNovel,
  };
}
