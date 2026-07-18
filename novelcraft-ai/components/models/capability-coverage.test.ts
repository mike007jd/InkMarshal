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

  it('accepts provider and loopback custom bindings when their auth shape is usable', () => {
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

    expect(summary.readyRoles).toEqual(['draft', 'recall']);
  });

  it('uses a ready fallback when the primary provider has no key', () => {
    const primary = conn({
      id: 'provider-no-key',
      kind: 'provider',
      baseUrl: 'https://api.example.com/v1',
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
    });

    const draft = summary.roles.find(row => row.role === 'draft');
    expect(draft?.status).toBe('ready');
    expect(draft?.source).toBe('fallback');
    expect(draft?.modelId).toBe('local-model');
  });
});
