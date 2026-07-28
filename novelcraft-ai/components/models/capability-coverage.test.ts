import { describe, expect, it } from 'vitest';

import { buildCapabilityCoverageSummary } from '@/components/models/capability-coverage';
import type {
  CapabilityProfile,
  CapabilityRole,
  RuntimeConnection,
} from '@/lib/model-supply/types';

function emptyProfile(): CapabilityProfile {
  return { draft: null, rewrite: null, planning: null, recall: null };
}

function conn(overrides: Partial<RuntimeConnection>): RuntimeConnection {
  return {
    id: 'c',
    label: 'Connection',
    kind: 'custom',
    transport: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    secretRef: null,
    createdAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    ...overrides,
  };
}

function bind(
  profile: CapabilityProfile,
  role: CapabilityRole,
  connectionId: string,
  modelId = `${role}-model`,
): CapabilityProfile {
  return {
    ...profile,
    [role]: { connectionId, modelId },
  };
}

describe('buildCapabilityCoverageSummary', () => {
  it('reports all roles unbound with no model routing', () => {
    const summary = buildCapabilityCoverageSummary({
      profile: emptyProfile(),
      connections: [],
      runningEngines: [],
    });

    expect(summary.readyCount).toBe(0);
    expect(summary.totalCount).toBe(4);
    expect(summary.unboundRoles).toEqual(['draft', 'rewrite', 'planning', 'recall']);
    expect(summary.complete).toBe(false);
  });

  it('counts a partially-bound running local engine and exposes missing roles', () => {
    const engineId = 'gguf:/models/qwen.gguf';
    const connectionId = `local-engine:${engineId}`;
    const profile = bind(
      bind(emptyProfile(), 'draft', connectionId, 'Qwen3.5-4B-Q4_K_M.gguf'),
      'rewrite',
      connectionId,
      'Qwen3.5-4B-Q4_K_M.gguf',
    );

    const summary = buildCapabilityCoverageSummary({
      profile,
      connections: [conn({ id: connectionId, kind: 'local' })],
      runningEngines: [{ engineId }],
    });

    expect(summary.readyRoles).toEqual(['draft', 'rewrite']);
    expect(summary.notReadyRoles).toEqual(['planning', 'recall']);
    expect(summary.roles.find(row => row.role === 'draft')?.status).toBe('ready');
  });

  it('marks a bound local engine as stopped when the process is not live', () => {
    const connectionId = 'local-engine:dead';
    const summary = buildCapabilityCoverageSummary({
      profile: bind(emptyProfile(), 'planning', connectionId),
      connections: [conn({ id: connectionId, kind: 'local' })],
      runningEngines: [],
    });

    expect(summary.stoppedRoles).toEqual(['planning']);
    expect(summary.readyCount).toBe(0);
  });

  it('does not count provider or loopback bindings ready from auth/loopback shape alone', () => {
    const provider = conn({
      id: 'provider',
      kind: 'provider',
      baseUrl: 'https://api.example.com/v1',
      secretRef: { account: 'connection:provider' },
    });
    const custom = conn({
      id: 'custom-local',
      kind: 'custom',
      baseUrl: 'http://localhost:1234/v1',
    });
    const profile = bind(
      bind(emptyProfile(), 'draft', provider.id, 'hosted-model'),
      'recall',
      custom.id,
      'local-recall',
    );

    const summary = buildCapabilityCoverageSummary({
      profile,
      connections: [provider, custom],
      runningEngines: [],
    });

    expect(summary.readyCount).toBe(0);
    expect(summary.stoppedRoles).toEqual(['draft', 'recall']);
    expect(summary.complete).toBe(false);
  });

  it('counts a health-confirmed provider ready and leaves unprobed peers stopped', () => {
    const provider = conn({
      id: 'provider',
      kind: 'provider',
      baseUrl: 'https://api.example.com/v1',
      secretRef: { account: 'connection:provider' },
    });
    const offlineLoopback = conn({
      id: 'offline-loopback',
      kind: 'custom',
      baseUrl: 'http://127.0.0.1:9999/v1',
    });
    const profile = bind(
      bind(emptyProfile(), 'draft', provider.id, 'hosted-model'),
      'recall',
      offlineLoopback.id,
      'local-recall',
    );

    const summary = buildCapabilityCoverageSummary({
      profile,
      connections: [provider, offlineLoopback],
      runningEngines: [],
      healthyConnectionModels: new Map([[provider.id, new Set(['hosted-model'])]]),
    });

    expect(summary.readyRoles).toEqual(['draft']);
    expect(summary.stoppedRoles).toEqual(['recall']);
    expect(summary.roles.find(row => row.role === 'draft')?.status).toBe('ready');
  });

  it('uses a health-confirmed fallback when the primary probe is down', () => {
    const primary = conn({
      id: 'provider-offline',
      kind: 'provider',
      baseUrl: 'https://api.example.com/v1',
      secretRef: { account: 'connection:provider-offline' },
    });
    const fallback = conn({
      id: 'loopback-fallback',
      kind: 'custom',
      baseUrl: 'http://127.0.0.1:8080/v1',
    });
    const profile: CapabilityProfile = {
      ...emptyProfile(),
      draft: {
        connectionId: primary.id,
        modelId: 'hosted-model',
        fallback: { connectionId: fallback.id, modelId: 'local-model' },
      },
    };

    const summary = buildCapabilityCoverageSummary({
      profile,
      connections: [primary, fallback],
      runningEngines: [],
      healthyConnectionModels: new Map([[fallback.id, new Set(['local-model'])]]),
    });

    const draft = summary.roles.find(row => row.role === 'draft');
    expect(draft?.status).toBe('ready');
    expect(draft?.source).toBe('fallback');
    expect(draft?.modelId).toBe('local-model');
  });

  it('cannot report 4/4 ready when every non-local probe is down', () => {
    const provider = conn({
      id: 'provider',
      kind: 'provider',
      baseUrl: 'https://api.example.com/v1',
      secretRef: { account: 'connection:provider' },
    });
    let profile = emptyProfile();
    for (const role of ['draft', 'rewrite', 'planning', 'recall'] as const) {
      profile = bind(profile, role, provider.id, `${role}-model`);
    }

    const summary = buildCapabilityCoverageSummary({
      profile,
      connections: [provider],
      runningEngines: [],
      healthyConnectionModels: new Map(),
    });

    expect(summary.readyCount).toBe(0);
    expect(summary.complete).toBe(false);
    expect(summary.stoppedRoles).toEqual(['draft', 'rewrite', 'planning', 'recall']);
  });

  it('keeps a healthy connection stopped when its bound model is not advertised', () => {
    const provider = conn({
      id: 'provider',
      kind: 'provider',
      baseUrl: 'https://api.example.com/v1',
      secretRef: { account: 'connection:provider' },
    });
    const summary = buildCapabilityCoverageSummary({
      profile: bind(emptyProfile(), 'draft', provider.id, 'deleted-model'),
      connections: [provider],
      runningEngines: [],
      healthyConnectionModels: new Map([
        [provider.id, new Set(['different-model'])],
      ]),
    });

    expect(summary.readyCount).toBe(0);
    expect(summary.stoppedRoles).toEqual(['draft']);
  });
});
