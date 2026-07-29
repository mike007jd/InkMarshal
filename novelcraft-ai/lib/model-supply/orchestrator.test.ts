import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityBinding, CapabilityRole } from '@/lib/model-supply/types';
import type { EngineBudget, EngineInfo } from '@/lib/desktop-runtime';

// ── mocks ────────────────────────────────────────────────────────────────────
//
// The orchestrator owns three side-effects:
//   1. invoking Rust commands (engine_estimate_footprint, engine_resource_budget,
//      engine_start, engine_stop, stop_others_for_path, engine_status)
//   2. upserting RuntimeConnection rows
//   3. saving / clearing CapabilityBinding rows
//
// Each is mocked at module boundary so we can assert exact call shapes and
// argument ordering without spinning a real engine or localStorage.

const desktopMocks = vi.hoisted(() => ({
  engineEstimateFootprint: vi.fn(),
  engineResourceBudget: vi.fn(),
  engineStatus: vi.fn(),
  engineStop: vi.fn(),
  stopOthersForPath: vi.fn(),
}));

const localEngineMocks = vi.hoisted(() => ({
  startAndRegisterLocalEngine: vi.fn(),
}));

const settingsMocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getStoredSetting: vi.fn((key: string) => (store.has(key) ? store.get(key)! : null)),
    setStoredSettingDurable: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return true;
    }),
    removeStoredSettingDurable: vi.fn(async (key: string) => {
      store.delete(key);
      return true;
    }),
    rollbackStoredSettingMirrorAfterFailedDurableAttempt: vi.fn(
      (key: string, attemptedValue: string | null, previousValue: string | null) => {
        const current = store.has(key) ? store.get(key)! : null;
        if (current !== attemptedValue) return;
        if (previousValue === null) store.delete(key);
        else store.set(key, previousValue);
      },
    ),
  };
});

const connectionMocks = vi.hoisted(() => {
  // In-memory profile + connection store so the orchestrator's reads
  // (getBindingForRole / getCapabilityProfile / getConnection) see the
  // writes its own saveCapabilityBindingsDurable made.
  const profile: Record<CapabilityRole, CapabilityBinding | null> = {
    draft: null,
    rewrite: null,
    planning: null,
    recall: null,
  };
  const connections = new Map<string, { id: string; label: string; baseUrl: string }>();
  return {
    profile,
    connections,
    saveCapabilityBindingsDurable: vi.fn(
      async (
        mutations: ReadonlyArray<
          | {
              role: CapabilityRole;
              connectionId: string;
              modelId: string;
              fallback?: { connectionId: string; modelId: string };
            }
          | { role: CapabilityRole; binding: null }
        >,
      ) => {
        for (const mutation of mutations) {
          if ('binding' in mutation && mutation.binding === null) {
            profile[mutation.role] = null;
            continue;
          }
          if (!('connectionId' in mutation)) continue;
          const binding: CapabilityBinding = {
            connectionId: mutation.connectionId,
            modelId: mutation.modelId,
          };
          if (mutation.fallback) binding.fallback = mutation.fallback;
          profile[mutation.role] = binding;
        }
        return { ...profile };
      },
    ),
    getBindingForRole: vi.fn((role: CapabilityRole) => profile[role] ?? null),
    getCapabilityProfile: vi.fn(() => ({ ...profile })),
    getConnection: vi.fn((id: string) => connections.get(id) ?? undefined),
    getConnections: vi.fn(() => Array.from(connections.values())),
    upsertConnectionWithSecretCleanup: vi.fn(
      async (input: { id?: string; label: string; baseUrl: string }) => {
        const id = input.id ?? `auto-${connections.size}`;
        const row = { id, label: input.label, baseUrl: input.baseUrl };
        connections.set(id, row);
        return row;
      },
    ),
    removeConnection: vi.fn(async (id: string) => {
      connections.delete(id);
    }),
    runCapabilityProfileExclusive: vi.fn(),
  };
});

vi.mock('@/lib/desktop-runtime', () => ({
  engineEstimateFootprint: desktopMocks.engineEstimateFootprint,
  engineResourceBudget: desktopMocks.engineResourceBudget,
  engineStatus: desktopMocks.engineStatus,
  engineStop: desktopMocks.engineStop,
  stopOthersForPath: desktopMocks.stopOthersForPath,
}));

vi.mock('@/lib/model-supply/local-engine', () => ({
  startAndRegisterLocalEngine: localEngineMocks.startAndRegisterLocalEngine,
  localEngineConnectionId: (engineId: string) => `local-engine:${engineId}`,
  isLocalEngineConnectionId: (id: string) => id.startsWith('local-engine:'),
}));

vi.mock('@/lib/model-supply/connections', () => ({
  saveCapabilityBindingsDurable: connectionMocks.saveCapabilityBindingsDurable,
  getBindingForRole: connectionMocks.getBindingForRole,
  getCapabilityProfile: connectionMocks.getCapabilityProfile,
  getConnection: connectionMocks.getConnection,
  getConnections: connectionMocks.getConnections,
  upsertConnectionWithSecretCleanup: connectionMocks.upsertConnectionWithSecretCleanup,
  removeConnection: connectionMocks.removeConnection,
  runCapabilityProfileExclusive: connectionMocks.runCapabilityProfileExclusive,
}));

vi.mock('@/lib/app-settings-client', () => ({
  getStoredSetting: settingsMocks.getStoredSetting,
  setStoredSettingDurable: settingsMocks.setStoredSettingDurable,
  removeStoredSettingDurable: settingsMocks.removeStoredSettingDurable,
  rollbackStoredSettingMirrorAfterFailedDurableAttempt:
    settingsMocks.rollbackStoredSettingMirrorAfterFailedDurableAttempt,
}));

import {
  clearDanglingBindings,
  clearLocalEngineBindings,
  findDanglingBindings,
  listRoleEngineBindings,
  QuotaConflict,
  startAndBindLocalEngine,
  startEngineForRoles,
  stopEngineAndUnbind,
} from '@/lib/model-supply/orchestrator';

function resetProfile() {
  for (const role of ['draft', 'rewrite', 'planning', 'recall'] as CapabilityRole[]) {
    connectionMocks.profile[role] = null;
  }
  connectionMocks.connections.clear();
  settingsMocks.store.clear();
}

function defaultBudget(overrides: Partial<EngineBudget> = {}): EngineBudget {
  return {
    totalRamBytes: 32 * 1024 ** 3,
    availableRamBytes: 24 * 1024 ** 3,
    reservedForOsBytes: 4 * 1024 ** 3,
    running: [],
    ...overrides,
  };
}

function fakeEngineStart(
  engineId: string,
  modelPath: string,
  port: number,
  footprintBytes = 6 * 1024 ** 3,
): {
  connection: { id: string; label: string; baseUrl: string };
  modelId: string;
  engineId: string;
  footprintBytes: number;
  info: EngineInfo;
} {
  const connectionId = `local-engine:${engineId}`;
  const conn = { id: connectionId, label: `Local engine · ${engineId}`, baseUrl: `http://127.0.0.1:${port}/v1` };
  connectionMocks.connections.set(connectionId, conn);
  return {
    connection: conn,
    modelId: engineId,
    engineId,
    footprintBytes,
    info: {
      engineId,
      format: 'gguf',
      modelPath,
      port,
      footprintBytes,
    },
  };
}

function boundRolesFromDurableCalls(): CapabilityRole[] {
  return connectionMocks.saveCapabilityBindingsDurable.mock.calls.flatMap(call => {
    const mutations = call[0] as ReadonlyArray<{ role: CapabilityRole }>;
    return mutations.map(m => m.role);
  });
}

describe('model-supply orchestrator — wave 4 multi-engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProfile();
    // Re-apply default durable implementations cleared by vi.clearAllMocks.
    settingsMocks.setStoredSettingDurable.mockImplementation(async (key: string, value: string) => {
      settingsMocks.store.set(key, value);
      return true;
    });
    settingsMocks.removeStoredSettingDurable.mockImplementation(async (key: string) => {
      settingsMocks.store.delete(key);
      return true;
    });
    settingsMocks.getStoredSetting.mockImplementation((key: string) =>
      settingsMocks.store.has(key) ? settingsMocks.store.get(key)! : null,
    );
    settingsMocks.rollbackStoredSettingMirrorAfterFailedDurableAttempt.mockImplementation(
      (key: string, attemptedValue: string | null, previousValue: string | null) => {
        const current = settingsMocks.store.has(key) ? settingsMocks.store.get(key)! : null;
        if (current !== attemptedValue) return;
        if (previousValue === null) settingsMocks.store.delete(key);
        else settingsMocks.store.set(key, previousValue);
      },
    );
    connectionMocks.saveCapabilityBindingsDurable.mockImplementation(
      async (
        mutations: ReadonlyArray<
          | {
              role: CapabilityRole;
              connectionId: string;
              modelId: string;
              fallback?: { connectionId: string; modelId: string };
            }
          | { role: CapabilityRole; binding: null }
        >,
      ) => {
        for (const mutation of mutations) {
          if ('binding' in mutation && mutation.binding === null) {
            connectionMocks.profile[mutation.role] = null;
            continue;
          }
          if (!('connectionId' in mutation)) continue;
          const binding: CapabilityBinding = {
            connectionId: mutation.connectionId,
            modelId: mutation.modelId,
          };
          if (mutation.fallback) binding.fallback = mutation.fallback;
          connectionMocks.profile[mutation.role] = binding;
        }
        return { ...connectionMocks.profile };
      },
    );
    connectionMocks.upsertConnectionWithSecretCleanup.mockImplementation(
      async (input: { id?: string; label: string; baseUrl: string }) => {
        const id = input.id ?? `auto-${connectionMocks.connections.size}`;
        const row = { id, label: input.label, baseUrl: input.baseUrl };
        connectionMocks.connections.set(id, row);
        return row;
      },
    );
    connectionMocks.removeConnection.mockImplementation(async (id: string) => {
      connectionMocks.connections.delete(id);
    });
    connectionMocks.runCapabilityProfileExclusive.mockImplementation(
      async (
        operation: (context: {
          read(): Record<CapabilityRole, CapabilityBinding | null>;
          save: typeof connectionMocks.saveCapabilityBindingsDurable;
        }) => Promise<unknown>,
      ) => operation({
        read: () => ({ ...connectionMocks.profile }),
        save: connectionMocks.saveCapabilityBindingsDurable,
      }),
    );
    desktopMocks.engineEstimateFootprint.mockResolvedValue({
      modelSizeBytes: 6 * 1024 ** 3,
      ramBytes: 6 * 1024 ** 3,
      vramHintBytes: 6 * 1024 ** 3,
    });
    desktopMocks.engineResourceBudget.mockResolvedValue(defaultBudget());
    desktopMocks.engineStatus.mockResolvedValue([]);
    desktopMocks.engineStop.mockResolvedValue(undefined);
    desktopMocks.stopOthersForPath.mockResolvedValue(0);
  });

  it('starts an engine and binds only the requested roles', async () => {
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('gguf:/m/llama.gguf', '/m/llama.gguf', 51000),
    );

    const result = await startEngineForRoles({
      modelPath: '/m/llama.gguf',
      format: 'gguf',
      modelLabel: 'Llama 8B',
      roles: ['draft', 'planning'],
    });

    expect(result.reused).toBe(false);
    expect(result.connection.id).toBe('local-engine:gguf:/m/llama.gguf');
    expect(result.boundRoles).toEqual(['draft', 'planning']);
    // Only the two requested roles touched — `rewrite` and `recall` remain unbound.
    expect(connectionMocks.saveCapabilityBindingsDurable).toHaveBeenCalledTimes(1);
    expect(boundRolesFromDurableCalls()).toEqual(['draft', 'planning']);
    expect(connectionMocks.profile.rewrite).toBeNull();
    expect(connectionMocks.profile.recall).toBeNull();
  });

  it('starts two engines side-by-side under independent connection rows', async () => {
    localEngineMocks.startAndRegisterLocalEngine
      .mockResolvedValueOnce(fakeEngineStart('gguf:/m/llama.gguf', '/m/llama.gguf', 51001))
      .mockResolvedValueOnce(fakeEngineStart('gguf:/m/qwen.gguf', '/m/qwen.gguf', 51002));

    await startEngineForRoles({
      modelPath: '/m/llama.gguf',
      format: 'gguf',
      modelLabel: 'Llama 8B',
      roles: ['draft'],
    });
    await startEngineForRoles({
      modelPath: '/m/qwen.gguf',
      format: 'gguf',
      modelLabel: 'Qwen 8B',
      roles: ['rewrite'],
    });

    // Two distinct connection rows + each role points at the correct one.
    // (upsertConnection is called inside the mocked startAndRegisterLocalEngine
    // — the fakeEngineStart helper writes the rows itself, so we assert on the
    // store state rather than on the mock's call count.)
    expect(connectionMocks.connections.has('local-engine:gguf:/m/llama.gguf')).toBe(true);
    expect(connectionMocks.connections.has('local-engine:gguf:/m/qwen.gguf')).toBe(true);
    expect(connectionMocks.profile.draft?.connectionId).toBe('local-engine:gguf:/m/llama.gguf');
    expect(connectionMocks.profile.rewrite?.connectionId).toBe('local-engine:gguf:/m/qwen.gguf');
    // Previous bind (draft → llama) is unaffected by the second start.
    expect(connectionMocks.profile.draft?.modelId).toBe('Llama 8B');
  });

  it('throws QuotaConflict when the budget cannot fit the new engine', async () => {
    desktopMocks.engineResourceBudget.mockResolvedValueOnce(
      defaultBudget({
        availableRamBytes: 1 * 1024 ** 3,
        running: [
          { engineId: 'gguf:/m/llama.gguf', modelPath: '/m/llama.gguf', footprintBytes: 8 * 1024 ** 3 },
        ],
      }),
    );

    await expect(
      startEngineForRoles({
        modelPath: '/m/qwen.gguf',
        format: 'gguf',
        modelLabel: 'Qwen 8B',
        roles: ['rewrite'],
      }),
    ).rejects.toBeInstanceOf(QuotaConflict);
    expect(localEngineMocks.startAndRegisterLocalEngine).not.toHaveBeenCalled();
  });

  it('maps the Rust atomic admit rejection (ENGINE_BUDGET_EXCEEDED) to QuotaConflict', async () => {
    // Budget + footprint pass the advisory TS admit, but the Rust admit lock
    // rejects (a concurrent launch won the race). The raw error must surface as
    // the same conflict dialog rather than leak a string to the UI.
    const payload = JSON.stringify({
      requiredBytes: 8 * 1024 ** 3,
      availableBytes: 1 * 1024 ** 3,
      reservedForOsBytes: 4 * 1024 ** 3,
      totalBytes: 16 * 1024 ** 3,
    });
    localEngineMocks.startAndRegisterLocalEngine.mockRejectedValueOnce(
      new Error(`ENGINE_BUDGET_EXCEEDED:${payload}`),
    );

    const err = await startEngineForRoles({
      modelPath: '/m/qwen.gguf',
      format: 'gguf',
      modelLabel: 'Qwen 8B',
      roles: ['rewrite'],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(QuotaConflict);
    expect((err as QuotaConflict).detail.requiredBytes).toBe(8 * 1024 ** 3);
    expect((err as QuotaConflict).detail.availableBytes).toBe(1 * 1024 ** 3);
    // It reached the spawn (TS checks passed) before the Rust admit rejected.
    expect(localEngineMocks.startAndRegisterLocalEngine).toHaveBeenCalledTimes(1);
  });

  it('replaces conflicting same-path engines when onConflict is replace', async () => {
    connectionMocks.connections.set('local-engine:gguf:/m/qwen.gguf#old', {
      id: 'local-engine:gguf:/m/qwen.gguf#old',
      label: 'Local engine · Qwen 8B old',
      baseUrl: 'http://127.0.0.1:51009/v1',
    });
    connectionMocks.profile.planning = {
      connectionId: 'local-engine:gguf:/m/qwen.gguf#old',
      modelId: 'Qwen 8B old',
    };
    desktopMocks.engineResourceBudget.mockResolvedValueOnce(
      defaultBudget({
        availableRamBytes: 1 * 1024 ** 3,
        running: [
          { engineId: 'gguf:/m/qwen.gguf#old', modelPath: '/m/qwen.gguf', footprintBytes: 8 * 1024 ** 3 },
        ],
      }),
    );
    desktopMocks.stopOthersForPath.mockResolvedValueOnce(1);
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('gguf:/m/qwen.gguf', '/m/qwen.gguf', 51003),
    );

    const result = await startEngineForRoles({
      modelPath: '/m/qwen.gguf',
      format: 'gguf',
      modelLabel: 'Qwen 8B',
      roles: ['rewrite'],
      onConflict: 'replace',
    });

    expect(desktopMocks.stopOthersForPath).toHaveBeenCalledWith('/m/qwen.gguf');
    expect(result.reused).toBe(false);
    expect(connectionMocks.profile.rewrite?.connectionId).toBe('local-engine:gguf:/m/qwen.gguf');
    expect(connectionMocks.profile.planning).toBeNull();
    expect(connectionMocks.connections.has('local-engine:gguf:/m/qwen.gguf#old')).toBe(false);
  });

  it('lets native canonical path matching decide replace conflicts', async () => {
    desktopMocks.engineResourceBudget.mockResolvedValueOnce(
      defaultBudget({
        availableRamBytes: 1 * 1024 ** 3,
        running: [
          {
            engineId: 'gguf:/m/nested/qwen.gguf#old',
            modelPath: '/m/nested/qwen.gguf',
            footprintBytes: 8 * 1024 ** 3,
          },
        ],
      }),
    );
    desktopMocks.stopOthersForPath.mockResolvedValueOnce(1);
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('gguf:/m/nested/qwen.gguf', '/m/nested/qwen.gguf', 51010),
    );

    const result = await startEngineForRoles({
      modelPath: '/m/nested/../nested/qwen.gguf',
      format: 'gguf',
      modelLabel: 'Qwen 8B',
      roles: ['draft'],
      onConflict: 'replace',
    });

    expect(desktopMocks.stopOthersForPath).toHaveBeenCalledWith('/m/nested/../nested/qwen.gguf');
    expect(result.reused).toBe(false);
    expect(localEngineMocks.startAndRegisterLocalEngine).toHaveBeenCalledWith(
      '/m/nested/../nested/qwen.gguf',
      'gguf',
      'Qwen 8B',
      { engineLabel: undefined },
    );
  });

  it('keeps replace over budget blocked when native stops no same-path engine', async () => {
    desktopMocks.engineResourceBudget.mockResolvedValueOnce(
      defaultBudget({
        availableRamBytes: 1 * 1024 ** 3,
        running: [
          { engineId: 'gguf:/m/other.gguf', modelPath: '/m/other.gguf', footprintBytes: 8 * 1024 ** 3 },
        ],
      }),
    );
    desktopMocks.stopOthersForPath.mockResolvedValueOnce(0);

    await expect(
      startEngineForRoles({
        modelPath: '/m/qwen.gguf',
        format: 'gguf',
        modelLabel: 'Qwen 8B',
        roles: ['draft'],
        onConflict: 'replace',
      }),
    ).rejects.toBeInstanceOf(QuotaConflict);
    expect(localEngineMocks.startAndRegisterLocalEngine).not.toHaveBeenCalled();
  });

  it('reuses an existing engine for the same modelPath without launching a new process', async () => {
    desktopMocks.engineStatus.mockResolvedValueOnce([
      {
        engineId: 'gguf:/m/qwen.gguf',
        format: 'gguf',
        modelPath: '/m/qwen.gguf',
        port: 51004,
        footprintBytes: 8 * 1024 ** 3,
      } satisfies EngineInfo,
    ]);
    // Pre-seed the connection row as if it had been registered on a previous start.
    connectionMocks.connections.set('local-engine:gguf:/m/qwen.gguf', {
      id: 'local-engine:gguf:/m/qwen.gguf',
      label: 'Local engine · Qwen 8B',
      baseUrl: 'http://127.0.0.1:51004/v1',
    });

    const result = await startEngineForRoles({
      modelPath: '/m/qwen.gguf',
      format: 'gguf',
      modelLabel: 'Qwen 8B',
      roles: ['planning'],
      onConflict: 'reuse',
    });

    expect(result.reused).toBe(true);
    expect(localEngineMocks.startAndRegisterLocalEngine).not.toHaveBeenCalled();
    expect(connectionMocks.profile.planning?.connectionId).toBe('local-engine:gguf:/m/qwen.gguf');
  });

  it('awaits durable registration when reusing a running engine with a missing row', async () => {
    desktopMocks.engineStatus.mockResolvedValueOnce([
      {
        engineId: 'gguf:/m/qwen.gguf',
        format: 'gguf',
        modelPath: '/m/qwen.gguf',
        port: 51004,
        footprintBytes: 8 * 1024 ** 3,
      } satisfies EngineInfo,
    ]);

    const result = await startEngineForRoles({
      modelPath: '/m/qwen.gguf',
      format: 'gguf',
      modelLabel: 'Qwen 8B',
      roles: ['planning'],
      onConflict: 'reuse',
    });

    expect(result.reused).toBe(true);
    expect(connectionMocks.upsertConnectionWithSecretCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'local-engine:gguf:/m/qwen.gguf',
        baseUrl: 'http://127.0.0.1:51004/v1',
      }),
    );
    expect(connectionMocks.profile.planning?.connectionId).toBe('local-engine:gguf:/m/qwen.gguf');
  });

  it('does not report success when launch-plan persistence fails after a new engine bind', async () => {
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('gguf:/m/llama.gguf', '/m/llama.gguf', 51000),
    );
    connectionMocks.profile.rewrite = {
      connectionId: 'provider-x',
      modelId: 'cloud',
    };
    // Need a window so durable launch-plan writes are attempted.
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      settingsMocks.setStoredSettingDurable.mockResolvedValueOnce(false);

      await expect(
        startEngineForRoles({
          modelPath: '/m/llama.gguf',
          format: 'gguf',
          modelLabel: 'Llama 8B',
          roles: ['draft'],
        }),
      ).rejects.toThrow('Failed to persist engine launch plan');

      // Requested role restored; unrelated provider binding preserved.
      expect(connectionMocks.profile.draft).toBeNull();
      expect(connectionMocks.profile.rewrite).toEqual({
        connectionId: 'provider-x',
        modelId: 'cloud',
      });
      expect(desktopMocks.engineStop).toHaveBeenCalledWith('gguf:/m/llama.gguf');
      expect(connectionMocks.removeConnection).toHaveBeenCalledWith(
        'local-engine:gguf:/m/llama.gguf',
      );
      expect(settingsMocks.rollbackStoredSettingMirrorAfterFailedDurableAttempt).toHaveBeenCalled();
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('does not overwrite a newer role assignment while compensating a failed launch plan', async () => {
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('gguf:/m/llama.gguf', '/m/llama.gguf', 51000),
    );
    let finishPlanWrite!: (ok: boolean) => void;
    settingsMocks.setStoredSettingDurable.mockImplementationOnce(async (key, value) => {
      settingsMocks.store.set(key, value);
      return new Promise<boolean>(resolve => {
        finishPlanWrite = resolve;
      });
    });
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const launch = startEngineForRoles({
        modelPath: '/m/llama.gguf',
        format: 'gguf',
        modelLabel: 'Llama 8B',
        roles: ['draft'],
      });
      await vi.waitFor(() => {
        expect(settingsMocks.setStoredSettingDurable).toHaveBeenCalled();
      });

      connectionMocks.profile.draft = {
        connectionId: 'provider-newer',
        modelId: 'newer-model',
      };
      finishPlanWrite(false);

      await expect(launch).rejects.toThrow('Failed to persist engine launch plan');
      expect(connectionMocks.profile.draft).toEqual({
        connectionId: 'provider-newer',
        modelId: 'newer-model',
      });
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('restores a provider binding made during a slow engine start when launch-plan persistence fails', async () => {
    let finishStart!: () => void;
    localEngineMocks.startAndRegisterLocalEngine.mockImplementationOnce(
      () => new Promise(resolve => {
        finishStart = () => resolve(
          fakeEngineStart('gguf:/m/slow.gguf', '/m/slow.gguf', 51007),
        );
      }),
    );
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      settingsMocks.setStoredSettingDurable.mockResolvedValueOnce(false);
      const launch = startEngineForRoles({
        modelPath: '/m/slow.gguf',
        format: 'gguf',
        modelLabel: 'Slow 8B',
        roles: ['draft'],
      });
      await vi.waitFor(() => {
        expect(localEngineMocks.startAndRegisterLocalEngine).toHaveBeenCalled();
      });

      // This user action happens after the launch began but before its atomic
      // bind. It is the direct predecessor that compensation must restore.
      connectionMocks.profile.draft = {
        connectionId: 'provider-during-start',
        modelId: 'provider-model',
      };
      finishStart();

      await expect(launch).rejects.toThrow('Failed to persist engine launch plan');
      expect(connectionMocks.profile.draft).toEqual({
        connectionId: 'provider-during-start',
        modelId: 'provider-model',
      });
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('keeps a failed-launch engine that a newer plan-external role adopted', async () => {
    const started = fakeEngineStart('gguf:/m/shared.gguf', '/m/shared.gguf', 51008);
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(started);
    let finishPlanWrite!: (ok: boolean) => void;
    settingsMocks.setStoredSettingDurable.mockImplementationOnce(async (key, value) => {
      settingsMocks.store.set(key, value);
      return new Promise<boolean>(resolve => {
        finishPlanWrite = resolve;
      });
    });
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const launch = startEngineForRoles({
        modelPath: '/m/shared.gguf',
        format: 'gguf',
        modelLabel: 'Shared 8B',
        roles: ['draft'],
      });
      await vi.waitFor(() => {
        expect(settingsMocks.setStoredSettingDurable).toHaveBeenCalled();
      });
      connectionMocks.profile.planning = {
        connectionId: started.connection.id,
        modelId: 'Shared 8B',
      };
      finishPlanWrite(false);

      await expect(launch).rejects.toThrow('Failed to persist engine launch plan');
      expect(connectionMocks.profile.draft).toBeNull();
      expect(connectionMocks.profile.planning).toEqual({
        connectionId: started.connection.id,
        modelId: 'Shared 8B',
      });
      expect(desktopMocks.engineStop).not.toHaveBeenCalledWith(started.engineId);
      expect(connectionMocks.removeConnection).not.toHaveBeenCalledWith(started.connection.id);
      expect(connectionMocks.connections.has(started.connection.id)).toBe(true);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('keeps a failed-launch engine adopted as a fallback by another role', async () => {
    const started = fakeEngineStart('gguf:/m/fallback.gguf', '/m/fallback.gguf', 51012);
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(started);
    let finishPlanWrite!: (ok: boolean) => void;
    settingsMocks.setStoredSettingDurable.mockImplementationOnce(async (key, value) => {
      settingsMocks.store.set(key, value);
      return new Promise<boolean>(resolve => {
        finishPlanWrite = resolve;
      });
    });
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const launch = startEngineForRoles({
        modelPath: '/m/fallback.gguf',
        format: 'gguf',
        modelLabel: 'Fallback 8B',
        roles: ['draft'],
      });
      await vi.waitFor(() => {
        expect(settingsMocks.setStoredSettingDurable).toHaveBeenCalled();
      });
      connectionMocks.profile.planning = {
        connectionId: 'provider-primary',
        modelId: 'provider-model',
        fallback: {
          connectionId: started.connection.id,
          modelId: 'Fallback 8B',
        },
      };
      finishPlanWrite(false);

      await expect(launch).rejects.toThrow('Failed to persist engine launch plan');
      expect(connectionMocks.profile.planning?.fallback).toEqual({
        connectionId: started.connection.id,
        modelId: 'Fallback 8B',
      });
      expect(desktopMocks.engineStop).not.toHaveBeenCalledWith(started.engineId);
      expect(connectionMocks.removeConnection).not.toHaveBeenCalledWith(started.connection.id);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('serializes a same-id restart behind stop cleanup', async () => {
    const engineId = 'gguf:/m/restart.gguf';
    const connectionId = `local-engine:${engineId}`;
    connectionMocks.connections.set(connectionId, {
      id: connectionId,
      label: 'Local engine · Restart',
      baseUrl: 'http://127.0.0.1:51010/v1',
    });
    connectionMocks.profile.draft = {
      connectionId,
      modelId: 'Restart 8B',
    };
    let finishStop!: () => void;
    desktopMocks.engineStop.mockImplementationOnce(
      () => new Promise<void>(resolve => {
        finishStop = resolve;
      }),
    );
    localEngineMocks.startAndRegisterLocalEngine.mockImplementationOnce(async () =>
      fakeEngineStart(engineId, '/m/restart.gguf', 51011),
    );

    const stopping = stopEngineAndUnbind(engineId);
    await vi.waitFor(() => expect(desktopMocks.engineStop).toHaveBeenCalledWith(engineId));
    const restarting = startEngineForRoles({
      modelPath: '/m/restart.gguf',
      format: 'gguf',
      modelLabel: 'Restart 8B',
      roles: ['draft'],
    });
    await Promise.resolve();
    expect(localEngineMocks.startAndRegisterLocalEngine).not.toHaveBeenCalled();

    finishStop();
    await stopping;
    await restarting;
    expect(connectionMocks.connections.has(connectionId)).toBe(true);
    expect(connectionMocks.profile.draft).toEqual({
      connectionId,
      modelId: 'Restart 8B',
    });
  });

  it('preserves the durable connection when failed-launch cleanup cannot stop the spawned engine', async () => {
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('gguf:/m/leaked.gguf', '/m/leaked.gguf', 51009),
    );
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      settingsMocks.setStoredSettingDurable.mockResolvedValueOnce(false);
      desktopMocks.engineStop.mockRejectedValueOnce(new Error('native stop failed'));

      await expect(
        startEngineForRoles({
          modelPath: '/m/leaked.gguf',
          format: 'gguf',
          modelLabel: 'Leaked 8B',
          roles: ['draft'],
        }),
      ).rejects.toThrow('Engine launch failed and the spawned engine could not be stopped');

      expect(connectionMocks.connections.has('local-engine:gguf:/m/leaked.gguf')).toBe(true);
      expect(connectionMocks.removeConnection).not.toHaveBeenCalledWith(
        'local-engine:gguf:/m/leaked.gguf',
      );
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('restores prior requested bindings when binding persistence fails after spawn', async () => {
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('gguf:/m/llama.gguf', '/m/llama.gguf', 51000),
    );
    connectionMocks.profile.draft = {
      connectionId: 'provider-prior',
      modelId: 'prior-model',
    };
    connectionMocks.profile.planning = {
      connectionId: 'provider-planning',
      modelId: 'keep-me',
    };
    connectionMocks.saveCapabilityBindingsDurable.mockRejectedValueOnce(
      new Error('Failed to persist capability profile'),
    );

    await expect(
      startEngineForRoles({
        modelPath: '/m/llama.gguf',
        format: 'gguf',
        modelLabel: 'Llama 8B',
        roles: ['draft'],
      }),
    ).rejects.toThrow('Failed to persist capability profile');

    // Compensation restores the prior draft binding; planning untouched.
    expect(connectionMocks.profile.draft).toEqual({
      connectionId: 'provider-prior',
      modelId: 'prior-model',
    });
    expect(connectionMocks.profile.planning).toEqual({
      connectionId: 'provider-planning',
      modelId: 'keep-me',
    });
    expect(desktopMocks.engineStop).toHaveBeenCalledWith('gguf:/m/llama.gguf');
    expect(connectionMocks.removeConnection).toHaveBeenCalledWith(
      'local-engine:gguf:/m/llama.gguf',
    );
    expect(settingsMocks.setStoredSettingDurable).not.toHaveBeenCalled();
  });

  it('stopEngineAndUnbind clears every binding that pointed at the killed engine', async () => {
    connectionMocks.profile.draft = {
      connectionId: 'local-engine:gguf:/m/llama.gguf',
      modelId: 'Llama 8B',
    };
    connectionMocks.profile.rewrite = {
      connectionId: 'local-engine:gguf:/m/qwen.gguf',
      modelId: 'Qwen 8B',
    };
    connectionMocks.connections.set('local-engine:gguf:/m/llama.gguf', {
      id: 'local-engine:gguf:/m/llama.gguf',
      label: 'Local engine · Llama 8B',
      baseUrl: 'http://127.0.0.1:51005/v1',
    });

    await stopEngineAndUnbind('gguf:/m/llama.gguf');

    expect(desktopMocks.engineStop).toHaveBeenCalledWith('gguf:/m/llama.gguf');
    // draft was on llama → cleared. rewrite was on qwen → untouched.
    expect(connectionMocks.profile.draft).toBeNull();
    expect(connectionMocks.profile.rewrite?.modelId).toBe('Qwen 8B');
    expect(connectionMocks.connections.has('local-engine:gguf:/m/llama.gguf')).toBe(false);
  });

  it('stopEngineAndUnbind removes a killed fallback while preserving its primary binding', async () => {
    const connectionId = 'local-engine:gguf:/m/fallback.gguf';
    connectionMocks.profile.planning = {
      connectionId: 'provider-primary',
      modelId: 'provider-model',
      fallback: {
        connectionId,
        modelId: 'Fallback 8B',
      },
    };
    connectionMocks.connections.set(connectionId, {
      id: connectionId,
      label: 'Local engine · Fallback 8B',
      baseUrl: 'http://127.0.0.1:51012/v1',
    });

    await stopEngineAndUnbind('gguf:/m/fallback.gguf');

    expect(connectionMocks.profile.planning).toEqual({
      connectionId: 'provider-primary',
      modelId: 'provider-model',
    });
    expect(connectionMocks.connections.has(connectionId)).toBe(false);
  });

  it('stopEngineAndUnbind promotes a surviving fallback when its primary engine is killed', async () => {
    const connectionId = 'local-engine:gguf:/m/primary.gguf';
    connectionMocks.profile.planning = {
      connectionId,
      modelId: 'Primary 8B',
      fallback: {
        connectionId: 'provider-fallback',
        modelId: 'provider-model',
      },
    };
    connectionMocks.connections.set(connectionId, {
      id: connectionId,
      label: 'Local engine · Primary 8B',
      baseUrl: 'http://127.0.0.1:51013/v1',
    });

    await stopEngineAndUnbind('gguf:/m/primary.gguf');

    expect(connectionMocks.profile.planning).toEqual({
      connectionId: 'provider-fallback',
      modelId: 'provider-model',
    });
    expect(connectionMocks.connections.has(connectionId)).toBe(false);
  });

  it('restores the relaunch plan and leaves bindings/row intact when native stop fails', async () => {
    const engineId = 'gguf:/m/llama.gguf';
    const connectionId = `local-engine:${engineId}`;
    connectionMocks.profile.draft = {
      connectionId,
      modelId: 'Llama 8B',
    };
    connectionMocks.connections.set(connectionId, {
      id: connectionId,
      label: 'Local engine · Llama 8B',
      baseUrl: 'http://127.0.0.1:51005/v1',
    });
    const launchPlansKey = 'inkmarshal_engine_launch_plans_v1';
    settingsMocks.store.set(launchPlansKey, JSON.stringify([{
      modelPath: '/m/llama.gguf',
      format: 'gguf',
      modelLabel: 'Llama 8B',
      roles: ['draft'],
      engineId,
    }]));
    desktopMocks.engineStop.mockRejectedValueOnce(new Error('native stop failed'));
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      await expect(stopEngineAndUnbind(engineId)).rejects.toThrow('native stop failed');
      expect(JSON.parse(settingsMocks.store.get(launchPlansKey)!)).toEqual([
        expect.objectContaining({ engineId }),
      ]);
      expect(connectionMocks.profile.draft).toEqual({
        connectionId,
        modelId: 'Llama 8B',
      });
      expect(connectionMocks.connections.has(connectionId)).toBe(true);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });

  it('listRoleEngineBindings only surfaces local-engine bindings', () => {
    connectionMocks.profile.draft = {
      connectionId: 'local-engine:gguf:/m/llama.gguf',
      modelId: 'Llama 8B',
    };
    connectionMocks.profile.rewrite = {
      connectionId: 'provider-openai',
      modelId: 'gpt-5.4-mini',
    };
    connectionMocks.profile.planning = {
      connectionId: 'local-engine:gguf:/m/qwen.gguf',
      modelId: 'Qwen 8B',
    };

    const map = listRoleEngineBindings();
    expect(map.size).toBe(2);
    expect(map.get('draft')?.engineId).toBe('gguf:/m/llama.gguf');
    expect(map.get('planning')?.engineId).toBe('gguf:/m/qwen.gguf');
    expect(map.has('rewrite')).toBe(false);
  });

  it('startAndBindLocalEngine binds all four roles by default', async () => {
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('gguf:/m/qwen.gguf', '/m/qwen.gguf', 51008),
    );

    await startAndBindLocalEngine('/m/qwen.gguf', 'gguf', 'Qwen 7B');

    expect(boundRolesFromDurableCalls()).toEqual([
      'draft',
      'rewrite',
      'planning',
      'recall',
    ]);
  });

  it('startAndBindLocalEngine binds only Draft by default for MLX', async () => {
    localEngineMocks.startAndRegisterLocalEngine.mockResolvedValueOnce(
      fakeEngineStart('mlx:/m/qwen-mlx', '/m/qwen-mlx', 51009),
    );

    await startAndBindLocalEngine('/m/qwen-mlx', 'mlx', 'Qwen MLX');

    expect(boundRolesFromDurableCalls()).toEqual(['draft']);
  });

  it('rejects MLX structured roles before estimating or starting an engine', async () => {
    await expect(startEngineForRoles({
      modelPath: '/m/qwen-mlx',
      format: 'mlx',
      modelLabel: 'Qwen MLX',
      roles: ['rewrite'],
    })).rejects.toThrow('MLX local models currently support Draft only');

    expect(desktopMocks.engineEstimateFootprint).not.toHaveBeenCalled();
    expect(localEngineMocks.startAndRegisterLocalEngine).not.toHaveBeenCalled();
  });

  it('clearLocalEngineBindings clears every role bound to any local-engine id', async () => {
    connectionMocks.profile.draft = {
      connectionId: 'local-engine:gguf:/m/a.gguf',
      modelId: 'A',
    };
    connectionMocks.profile.rewrite = { connectionId: 'provider-x', modelId: 'cloud' };
    connectionMocks.profile.planning = {
      connectionId: 'local-engine:gguf:/m/b.gguf',
      modelId: 'B',
    };

    await clearLocalEngineBindings();

    expect(connectionMocks.saveCapabilityBindingsDurable).toHaveBeenCalledTimes(1);
    const mutations = connectionMocks.saveCapabilityBindingsDurable.mock.calls[0][0] as Array<{
      role: CapabilityRole;
      binding: null;
    }>;
    expect(mutations.map(m => m.role).sort()).toEqual(['draft', 'planning']);
    expect(connectionMocks.profile.rewrite).toEqual({
      connectionId: 'provider-x',
      modelId: 'cloud',
    });
  });

  it('findDanglingBindings only flags roles whose connectionId is unknown', async () => {
    connectionMocks.profile.draft = { connectionId: 'missing', modelId: 'cloud' };
    connectionMocks.profile.rewrite = { connectionId: 'provider-x', modelId: 'cloud' };
    const known = new Set(['provider-x']);
    expect(findDanglingBindings(known, ['draft', 'rewrite', 'planning', 'recall'])).toEqual([
      'draft',
    ]);
    await expect(clearDanglingBindings(known, ['draft', 'rewrite', 'planning', 'recall'])).resolves.toEqual([
      'draft',
    ]);
    expect(connectionMocks.saveCapabilityBindingsDurable).toHaveBeenCalledWith([
      { role: 'draft', binding: null },
    ]);
  });

  it('rechecks dangling bindings after entering the profile queue', async () => {
    connectionMocks.profile.draft = { connectionId: 'missing', modelId: 'old' };
    let enterExclusive!: () => void;
    connectionMocks.runCapabilityProfileExclusive.mockImplementationOnce(
      async operation => {
        await new Promise<void>(resolve => {
          enterExclusive = resolve;
        });
        return operation({
          read: () => ({ ...connectionMocks.profile }),
          save: connectionMocks.saveCapabilityBindingsDurable,
        });
      },
    );

    const repair = clearDanglingBindings(new Set(['provider-valid']), ['draft']);
    await vi.waitFor(() => {
      expect(connectionMocks.runCapabilityProfileExclusive).toHaveBeenCalled();
    });
    connectionMocks.profile.draft = {
      connectionId: 'provider-valid',
      modelId: 'new-model',
    };
    enterExclusive();

    await expect(repair).resolves.toEqual([]);
    expect(connectionMocks.profile.draft).toEqual({
      connectionId: 'provider-valid',
      modelId: 'new-model',
    });
    expect(connectionMocks.saveCapabilityBindingsDurable).not.toHaveBeenCalled();
  });

  it('rechecks local-engine ownership after entering the profile queue', async () => {
    connectionMocks.profile.draft = {
      connectionId: 'local-engine:old',
      modelId: 'old-model',
    };
    let enterExclusive!: () => void;
    connectionMocks.runCapabilityProfileExclusive.mockImplementationOnce(
      async operation => {
        await new Promise<void>(resolve => {
          enterExclusive = resolve;
        });
        return operation({
          read: () => ({ ...connectionMocks.profile }),
          save: connectionMocks.saveCapabilityBindingsDurable,
        });
      },
    );

    const clear = clearLocalEngineBindings(['draft']);
    await vi.waitFor(() => {
      expect(connectionMocks.runCapabilityProfileExclusive).toHaveBeenCalled();
    });
    connectionMocks.profile.draft = {
      connectionId: 'provider-valid',
      modelId: 'new-model',
    };
    enterExclusive();

    await clear;
    expect(connectionMocks.profile.draft).toEqual({
      connectionId: 'provider-valid',
      modelId: 'new-model',
    });
    expect(connectionMocks.saveCapabilityBindingsDurable).not.toHaveBeenCalled();
  });

  it('prunes stale local-engine rows even when there are no launch plans to restore', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/model-supply/orchestrator.ts'),
      'utf8',
    );
    expect(source).toContain(
      "if (plans.length === 0) {\n      await enqueueEngineLifecycleMutation(pruneStaleLocalEngineRowsNow);\n      return;\n    }",
    );
  });

  // A18: restoreEnginesOnLaunch caches a one-shot promise; a failure used to
  // cache the resolved-no-op for the whole process lifetime, so engines were
  // never retried until a full app restart. The fix resets the cached promise
  // in the catch so a later call retries.
  it('resets the cached restore promise on failure so a later call retries', async () => {
    const source = await import('node:fs/promises').then(fs =>
      fs.readFile(join(process.cwd(), 'lib/model-supply/orchestrator.ts'), 'utf8'),
    );
    const catchIdx = source.indexOf('.catch(() => {', source.indexOf('restoreEnginesPromise ??='));
    expect(catchIdx).toBeGreaterThanOrEqual(0);
    const resetIdx = source.indexOf('restoreEnginesPromise = null', catchIdx);
    expect(resetIdx).toBeGreaterThan(catchIdx);
  });

  it('restores a launch plan whose modelPath is a lexical alias of the installed path', async () => {
    // Fresh module so the one-shot restoreEnginesPromise starts null.
    vi.resetModules();
    const { restoreEnginesOnLaunch } = await import('@/lib/model-supply/orchestrator');

    const lexicalPath = '/tmp/models/demo.gguf';
    const canonicalPath = '/private/tmp/models/demo.gguf';
    const engineId = 'gguf:/private/tmp/models/demo.gguf';
    const connectionId = `local-engine:${engineId}`;
    const launchPlansKey = 'inkmarshal_engine_launch_plans_v1';
    const modelLabel = 'Demo GGUF';

    settingsMocks.store.set(launchPlansKey, JSON.stringify([{
      modelPath: lexicalPath,
      format: 'gguf',
      modelLabel,
      roles: ['draft'],
      engineId,
    }]));
    connectionMocks.connections.set(connectionId, {
      id: connectionId,
      label: `Local engine · ${modelLabel}`,
      baseUrl: 'http://127.0.0.1:51005/v1',
    });
    connectionMocks.profile.draft = {
      connectionId,
      modelId: modelLabel,
    };

    let running: EngineInfo[] = [];
    desktopMocks.engineStatus.mockImplementation(async () => running);
    localEngineMocks.startAndRegisterLocalEngine.mockImplementation(
      async (modelPath: string, _format: string, label: string) => {
        const started = fakeEngineStart(engineId, canonicalPath, 51005);
        started.modelId = label;
        running = [started.info];
        return started;
      },
    );

    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      await restoreEnginesOnLaunch();

      expect(localEngineMocks.startAndRegisterLocalEngine).toHaveBeenCalledWith(
        lexicalPath,
        'gguf',
        modelLabel,
        { engineLabel: undefined },
      );
      expect(connectionMocks.profile.draft).toEqual({
        connectionId,
        modelId: modelLabel,
      });
      expect(connectionMocks.connections.has(connectionId)).toBe(true);
      expect(JSON.parse(settingsMocks.store.get(launchPlansKey)!)).toEqual([
        expect.objectContaining({
          modelPath: lexicalPath,
          engineId,
          modelLabel,
          roles: ['draft'],
        }),
      ]);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as Record<string, unknown>).window;
    }
  });
});
