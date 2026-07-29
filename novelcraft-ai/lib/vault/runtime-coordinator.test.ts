import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
  getNovelVaultStatus: vi.fn(),
  bootstrapNovelVaultRootAction: vi.fn(),
  reconcileVaultChangedFiles: vi.fn(),
  reconcileVaultSnapshot: vi.fn(),
  drainKnowledgeVaultOutboxAction: vi.fn(),
  vaultWatchStart: vi.fn(),
  vaultWatchStop: vi.fn(),
  vaultReachable: vi.fn(),
  vaultReadFile: vi.fn(),
  publishVaultEntriesChanged: vi.fn(),
  subscribeVaultPathChanged: vi.fn(() => () => undefined),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => mocks.isTauriRuntime(),
}));

vi.mock('@/app/actions/vault', () => ({
  getNovelVaultStatus: mocks.getNovelVaultStatus,
  bootstrapNovelVaultRootAction: mocks.bootstrapNovelVaultRootAction,
  reconcileVaultChangedFiles: mocks.reconcileVaultChangedFiles,
}));

vi.mock('@/app/actions/vault-outbox', () => ({
  drainKnowledgeVaultOutboxAction: mocks.drainKnowledgeVaultOutboxAction,
}));

vi.mock('@/lib/vault/ipc', () => ({
  vaultWatchStart: mocks.vaultWatchStart,
  vaultWatchStop: mocks.vaultWatchStop,
  vaultReachable: mocks.vaultReachable,
  vaultReadFile: mocks.vaultReadFile,
}));

vi.mock('@/lib/vault/runtime-events', () => ({
  publishVaultEntriesChanged: mocks.publishVaultEntriesChanged,
  subscribeVaultPathChanged: mocks.subscribeVaultPathChanged,
}));

vi.mock('@/lib/vault/snapshot-reconcile', () => ({
  reconcileVaultSnapshot: mocks.reconcileVaultSnapshot,
}));

import {
  createVaultRuntimeCoordinator,
  novelIdFromStudioRoute,
  parseVaultChangedEvent,
} from '@/lib/vault/runtime-coordinator';

describe('parseVaultChangedEvent / novelIdFromStudioRoute', () => {
  it('validates runtime payloads and derives novel ids only from novel routes', () => {
    expect(parseVaultChangedEvent({
      novelId: 'n1',
      paths: ['a.md'],
      kind: 'modify',
      watchId: 'w1',
    })).toEqual({
      novelId: 'n1',
      paths: ['a.md'],
      kind: 'modify',
      watchId: 'w1',
    });
    expect(parseVaultChangedEvent({ novelId: 'n1', paths: ['a.md'], kind: 'nope' })).toBeNull();
    expect(parseVaultChangedEvent({
      novelId: 'n1',
      paths: ['a.md'],
      kind: 'modify',
    })).toBeNull();
    expect(novelIdFromStudioRoute('/novel/n1', { id: 'n1' })).toBe('n1');
    expect(novelIdFromStudioRoute('/desktop-studio/series/s1', { id: 's1' })).toBeNull();
    expect(novelIdFromStudioRoute('/series/s1', { id: 's1' })).toBeNull();
  });
});

describe('createVaultRuntimeCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.getNovelVaultStatus.mockResolvedValue({ vaultPath: '/vaults/n1', vaultVersion: 1 });
    mocks.vaultReachable.mockResolvedValue({ reachable: true, writable: true });
    mocks.vaultWatchStart.mockResolvedValue(undefined);
    mocks.vaultWatchStop.mockResolvedValue(undefined);
    mocks.drainKnowledgeVaultOutboxAction.mockResolvedValue({
      attempted: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    });
    mocks.reconcileVaultChangedFiles.mockResolvedValue({ updated: 1, deleted: 0, skipped: 0 });
    mocks.reconcileVaultSnapshot.mockResolvedValue({ updated: 0, deleted: 0, skipped: 0 });
    mocks.bootstrapNovelVaultRootAction.mockImplementation(async (novelId: string) => {
      const status = await mocks.getNovelVaultStatus(novelId);
      const pending = (status.vaultVersion ?? 1) <= 0;
      return {
        vaultPath: status.vaultPath,
        allowMissingFileDeletes: !pending,
        transitionToken: pending ? status.vaultVersion : 1,
      };
    });
    mocks.vaultReadFile.mockImplementation(async (_vault: string, relPath: string) => {
      if (relPath.includes('b.md')) {
        throw new Error(
          "VAULT_ENTRY_NOT_FOUND: Cannot stat '/vaults/n1/characters/b.md': No such file or directory",
        );
      }
      return { content: `# ${relPath}`, contentHash: 'h', mtimeMs: 1 };
    });
    mocks.subscribeVaultPathChanged.mockReturnValue(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drains on startup, starts a watcher with watchId, and stops on unmount', async () => {
    let activeNovelId: string | null = 'novel-1';
    let handler: ((event: { payload: unknown }) => void) | null = null;
    const unlisten = vi.fn();
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => activeNovelId,
      listen: async (_event, next) => {
        handler = next;
        return unlisten;
      },
    });

    const stop = await coordinator.start();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalled());
    expect(mocks.vaultWatchStart.mock.calls[0]?.[0]).toBe('novel-1');
    expect(mocks.vaultWatchStart.mock.calls[0]?.[1]).toBe('/vaults/n1');
    expect(typeof mocks.vaultWatchStart.mock.calls[0]?.[2]).toBe('string');
    expect(typeof mocks.vaultWatchStart.mock.calls[0]?.[3]).toBe('number');
    expect(mocks.drainKnowledgeVaultOutboxAction).toHaveBeenCalled();
    expect(handler).toBeTruthy();

    stop();
    await vi.waitFor(() => expect(mocks.vaultWatchStop).toHaveBeenCalled());
    expect(unlisten).toHaveBeenCalledOnce();
    activeNovelId = null;
  });

  it('preserves A.md modify when B.md remove arrives in one debounce window', async () => {
    let handler: ((event: { payload: unknown }) => void) | null = null;
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      listen: async (_event, next) => {
        handler = next;
        return () => undefined;
      },
    });
    await coordinator.start();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalled());
    const watchId = mocks.vaultWatchStart.mock.calls[0]?.[2] as string;

    handler!({
      payload: {
        novelId: 'novel-1',
        paths: ['characters/a.md'],
        kind: 'modify',
        watchId,
      },
    });
    handler!({
      payload: {
        novelId: 'novel-1',
        paths: ['characters/b.md'],
        kind: 'remove',
        watchId,
      },
    });

    await vi.waitFor(() => expect(mocks.reconcileVaultChangedFiles).toHaveBeenCalled());
    const files = mocks.reconcileVaultChangedFiles.mock.calls.flatMap(call => call[1] as Array<{ path: string; content: string | null }>);
    expect(files).toEqual(expect.arrayContaining([
      { path: 'characters/a.md', content: '# characters/a.md' },
      { path: 'characters/b.md', content: null },
    ]));
    expect(files.find(f => f.path === 'characters/a.md')?.content).not.toBeNull();
  });

  it('rejects stale or missing watchId events and rejects startup when listen fails', async () => {
    const onError = vi.fn();
    let handler: ((event: { payload: unknown }) => void) | null = null;
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      onError,
      listen: async (_event, next) => {
        handler = next;
        return () => undefined;
      },
    });
    await coordinator.start();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalled());

    handler!({
      payload: {
        novelId: 'novel-1',
        paths: ['characters/a.md'],
        kind: 'modify',
        watchId: 'stale-watch',
      },
    });
    handler!({
      payload: {
        novelId: 'novel-1',
        paths: ['characters/a.md'],
        kind: 'modify',
      },
    });
    await new Promise(r => setTimeout(r, 20));
    expect(mocks.reconcileVaultChangedFiles).not.toHaveBeenCalled();

    const failing = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      onError,
      listen: async () => {
        throw new Error('listen failed');
      },
    });
    const startsBeforeFailure = mocks.vaultWatchStart.mock.calls.length;
    await expect(failing.start()).rejects.toThrow('listen failed');
    expect(onError).toHaveBeenCalled();
    await failing.syncActiveNovel();
    expect(mocks.vaultWatchStart).toHaveBeenCalledTimes(startsBeforeFailure);
  });

  it('schedules bounded offline backoff and recovers on focus/online', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    mocks.vaultReachable
      .mockResolvedValueOnce({ reachable: false, writable: false })
      .mockResolvedValue({ reachable: true, writable: true });

    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return () => undefined;
      },
      listen: async () => () => undefined,
    });
    await coordinator.start();
    await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0));
    expect(mocks.vaultWatchStart).not.toHaveBeenCalled();
    expect(timers[0]?.ms).toBe(1_000);

    timers[0]!.fn();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalled());
  });

  it('stops a stale in-progress start and never assigns shared watched state', async () => {
    let resolveWatchStart!: () => void;
    mocks.getNovelVaultStatus.mockImplementation(async (novelId: string) => ({
      vaultPath: novelId === 'novel-b' ? '/vaults/b' : '/vaults/a',
      vaultVersion: 1,
    }));
    mocks.vaultWatchStart.mockImplementation((_n: string, vaultPath: string) => {
      if (vaultPath === '/vaults/a') {
        return new Promise<void>(resolve => {
          resolveWatchStart = () => resolve();
        });
      }
      return Promise.resolve();
    });

    let activeNovelId: string | null = 'novel-a';
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => activeNovelId,
      listen: async () => () => undefined,
    });
    const stop = await coordinator.start();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalledWith(
      'novel-a',
      '/vaults/a',
      expect.any(String),
      expect.any(Number),
    ));
    const staleWatchId = mocks.vaultWatchStart.mock.calls[0]?.[2] as string;
    const staleWatchGeneration = mocks.vaultWatchStart.mock.calls[0]?.[3] as number;

    // Switch novel while A's watchStart is still in-flight (A→B).
    activeNovelId = 'novel-b';
    const syncB = coordinator.syncActiveNovel();
    await Promise.resolve();
    expect(mocks.vaultWatchStart).not.toHaveBeenCalledWith(
      'novel-b',
      '/vaults/b',
      expect.any(String),
      expect.any(Number),
    );
    resolveWatchStart!();
    await syncB;

    await vi.waitFor(() => {
      expect(mocks.vaultWatchStart).toHaveBeenCalledWith(
        'novel-b',
        '/vaults/b',
        expect.any(String),
        expect.any(Number),
      );
    });
    // Stale A start must stop its own exact watchId and not keep shared state on A.
    expect(mocks.vaultWatchStop).toHaveBeenCalledWith(
      'novel-a',
      '/vaults/a',
      staleWatchId,
      staleWatchGeneration,
    );
    stop();
  });

  it('restarts the watcher generation when the vault path changes for the same novel', async () => {
    mocks.getNovelVaultStatus
      .mockResolvedValueOnce({ vaultPath: '/vaults/old', vaultVersion: 1 })
      .mockResolvedValue({ vaultPath: '/vaults/new', vaultVersion: 1 });
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      listen: async () => () => undefined,
    });
    await coordinator.start();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalledWith(
      'novel-1',
      '/vaults/old',
      expect.any(String),
      expect.any(Number),
    ));
    const oldWatchId = mocks.vaultWatchStart.mock.calls[0]?.[2] as string;
    const oldWatchGeneration = mocks.vaultWatchStart.mock.calls[0]?.[3] as number;

    await coordinator.syncActiveNovel();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalledWith(
      'novel-1',
      '/vaults/new',
      expect.any(String),
      expect.any(Number),
    ));
    expect(mocks.vaultWatchStop).toHaveBeenCalledWith(
      'novel-1',
      '/vaults/old',
      oldWatchId,
      oldWatchGeneration,
    );
  });

  it('keeps the watcher when initial snapshot fails so focus/online can retry without dropping events', async () => {
    mocks.reconcileVaultSnapshot
      .mockRejectedValueOnce(new Error('snapshot failed'))
      .mockResolvedValue({ updated: 0, deleted: 0, skipped: 0 });
    const onError = vi.fn();
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      onError,
      listen: async () => () => undefined,
    });
    await coordinator.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'snapshot failed' }),
    ));
    expect(mocks.vaultWatchStart).toHaveBeenCalledTimes(1);
    expect(mocks.vaultWatchStop).not.toHaveBeenCalled();

    await coordinator.syncActiveNovel();
    expect(mocks.vaultWatchStart).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileVaultSnapshot).toHaveBeenCalledTimes(2);
  });

  it('defers pending-root remove events until bootstrap promotes delete eligibility', async () => {
    mocks.getNovelVaultStatus.mockResolvedValue({ vaultPath: '/vaults/n1', vaultVersion: -1 });
    mocks.bootstrapNovelVaultRootAction
      .mockResolvedValueOnce({
        vaultPath: '/vaults/n1',
        allowMissingFileDeletes: false,
        transitionToken: -1,
      })
      .mockResolvedValue({
        vaultPath: '/vaults/n1',
        allowMissingFileDeletes: true,
        transitionToken: 1,
      });
    mocks.vaultReadFile.mockImplementation(async (_vault: string, relPath: string) => {
      throw new Error(
        `VAULT_ENTRY_NOT_FOUND: Cannot stat '/vaults/n1/${relPath}': No such file or directory`,
      );
    });

    let handler: ((event: { payload: unknown }) => void) | null = null;
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      listen: async (_event, next) => {
        handler = next;
        return () => undefined;
      },
    });
    await coordinator.start();
    await vi.waitFor(() => expect(mocks.bootstrapNovelVaultRootAction).toHaveBeenCalled());
    const watchId = mocks.vaultWatchStart.mock.calls[0]?.[2] as string;

    handler!({
      payload: {
        novelId: 'novel-1',
        paths: ['characters/a.md'],
        kind: 'remove',
        watchId,
      },
    });
    await new Promise(r => setTimeout(r, 20));
    expect(mocks.bootstrapNovelVaultRootAction).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(mocks.reconcileVaultChangedFiles).toHaveBeenCalledWith(
      'novel-1',
      [{ path: 'characters/a.md', content: null }],
    ));
  });

  it('queues live events while snapshot runs then replays against filesystem reads', async () => {
    let releaseSnapshot!: () => void;
    mocks.reconcileVaultSnapshot.mockImplementation(() => new Promise<void>(resolve => {
      releaseSnapshot = () => resolve();
    }));
    let handler: ((event: { payload: unknown }) => void) | null = null;
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      listen: async (_event, next) => {
        handler = next;
        return () => undefined;
      },
    });
    await coordinator.start();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalled());
    const watchId = mocks.vaultWatchStart.mock.calls[0]?.[2] as string;

    handler!({
      payload: {
        novelId: 'novel-1',
        paths: ['characters/a.md'],
        kind: 'modify',
        watchId,
      },
    });
    expect(mocks.reconcileVaultChangedFiles).not.toHaveBeenCalled();
    releaseSnapshot!();
    await vi.waitFor(() => expect(mocks.reconcileVaultChangedFiles).toHaveBeenCalled());
  });

  it('reports non-missing read failures and retries the retained batch on the next sync', async () => {
    const onError = vi.fn();
    let handler: ((event: { payload: unknown }) => void) | null = null;
    mocks.vaultReadFile.mockRejectedValueOnce(new Error('Cannot stat file: permission denied'));
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => 'novel-1',
      onError,
      listen: async (_event, next) => {
        handler = next;
        return () => undefined;
      },
    });
    await coordinator.start();
    await vi.waitFor(() => expect(mocks.vaultWatchStart).toHaveBeenCalled());
    const watchId = mocks.vaultWatchStart.mock.calls[0]?.[2] as string;

    handler!({
      payload: {
        novelId: 'novel-1',
        paths: ['characters/a.md'],
        kind: 'modify',
        watchId,
      },
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('permission denied') }),
    ));
    expect(mocks.reconcileVaultChangedFiles).not.toHaveBeenCalled();

    mocks.vaultReadFile.mockResolvedValue({
      content: '# recovered',
      contentHash: 'h',
      mtimeMs: 1,
    });
    await coordinator.syncActiveNovel();
    expect(mocks.reconcileVaultChangedFiles).toHaveBeenCalledWith('novel-1', [
      { path: 'characters/a.md', content: '# recovered' },
    ]);
  });
});
