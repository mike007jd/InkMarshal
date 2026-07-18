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

const connectionMocks = vi.hoisted(() => {
  // In-memory profile + connection store so the orchestrator's reads
  // (getBindingForRole / getCapabilityProfile / getConnection) see the
  // writes its own saveCapabilityBinding made.
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
    saveCapabilityBinding: vi.fn(
      (role: CapabilityRole, connectionId: string, modelId: string, fallback?: {
        connectionId: string;
        modelId: string;
      }) => {
        const binding: CapabilityBinding = { connectionId, modelId };
        if (fallback) binding.fallback = fallback;
        profile[role] = binding;
        return profile;
      },
    ),
    clearCapabilityBinding: vi.fn((role: CapabilityRole) => {
      profile[role] = null;
      return profile;
    }),
    getBindingForRole: vi.fn((role: CapabilityRole) => profile[role] ?? null),
    getCapabilityProfile: vi.fn(() => ({ ...profile })),
    getConnection: vi.fn((id: string) => connections.get(id) ?? undefined),
    getConnections: vi.fn(() => Array.from(connections.values())),
    upsertConnection: vi.fn((input: { id?: string; label: string; baseUrl: string }) => {
      const id = input.id ?? `auto-${connections.size}`;
      const row = { id, label: input.label, baseUrl: input.baseUrl };
      connections.set(id, row);
      return row;
    }),
    removeConnection: vi.fn(async (id: string) => {
      connections.delete(id);
    }),
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
  saveCapabilityBinding: connectionMocks.saveCapabilityBinding,
  clearCapabilityBinding: connectionMocks.clearCapabilityBinding,
  getBindingForRole: connectionMocks.getBindingForRole,
  getCapabilityProfile: connectionMocks.getCapabilityProfile,
  getConnection: connectionMocks.getConnection,
  getConnections: connectionMocks.getConnections,
  upsertConnection: connectionMocks.upsertConnection,
  removeConnection: connectionMocks.removeConnection,
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

describe('model-supply orchestrator — wave 4 multi-engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProfile();
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
    expect(connectionMocks.saveCapabilityBinding).toHaveBeenCalledTimes(2);
    expect(
      connectionMocks.saveCapabilityBinding.mock.calls.map(c => c[0]),
    ).toEqual(['draft', 'planning']);
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

    expect(connectionMocks.saveCapabilityBinding.mock.calls.map(c => c[0])).toEqual([
      'draft',
      'rewrite',
      'planning',
      'recall',
    ]);
  });

  it('clearLocalEngineBindings clears every role bound to any local-engine id', () => {
    connectionMocks.profile.draft = {
      connectionId: 'local-engine:gguf:/m/a.gguf',
      modelId: 'A',
    };
    connectionMocks.profile.rewrite = { connectionId: 'provider-x', modelId: 'cloud' };
    connectionMocks.profile.planning = {
      connectionId: 'local-engine:gguf:/m/b.gguf',
      modelId: 'B',
    };

    clearLocalEngineBindings();

    expect(connectionMocks.clearCapabilityBinding).toHaveBeenCalledTimes(2);
    // draft + planning cleared; rewrite (provider) survives.
    const cleared = connectionMocks.clearCapabilityBinding.mock.calls.map(c => c[0]).sort();
    expect(cleared).toEqual(['draft', 'planning']);
  });

  it('findDanglingBindings only flags roles whose connectionId is unknown', () => {
    connectionMocks.profile.draft = { connectionId: 'missing', modelId: 'cloud' };
    connectionMocks.profile.rewrite = { connectionId: 'provider-x', modelId: 'cloud' };
    const known = new Set(['provider-x']);
    expect(findDanglingBindings(known, ['draft', 'rewrite', 'planning', 'recall'])).toEqual([
      'draft',
    ]);
    expect(clearDanglingBindings(known, ['draft', 'rewrite', 'planning', 'recall'])).toEqual([
      'draft',
    ]);
    expect(connectionMocks.clearCapabilityBinding).toHaveBeenCalledWith('draft');
  });

  it('prunes stale local-engine rows even when there are no launch plans to restore', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/model-supply/orchestrator.ts'),
      'utf8',
    );
    expect(source).toContain(
      "if (plans.length === 0) {\n      await pruneStaleLocalEngineRows();\n      return;\n    }",
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
});
