import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  saveCapabilityBinding,
  upsertConnection,
} from '@/lib/model-supply/connections';
import { hasConfiguredWritingConnection, hasLiveWritingConnection } from '@/lib/model-supply/readiness';
import { localEngineConnectionId } from '@/lib/model-supply/local-engine';
import { connectionSecretRef } from '@/lib/model-supply/types';

function installStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { store.set(key, value); }),
    removeItem: vi.fn((key: string) => { store.delete(key); }),
    clear: vi.fn(() => { store.clear(); }),
  });
}

describe('model readiness from configured connections', () => {
  beforeEach(() => {
    installStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not mark hosted provider bindings ready until a secret is attached', () => {
    const connection = upsertConnection({
      label: 'Hosted Anthropic',
      kind: 'provider',
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    saveCapabilityBinding('draft', connection.id, 'claude-sonnet');

    expect(hasConfiguredWritingConnection()).toBe(false);
  });

  it('accepts provider bindings with a secret and keyless loopback runtimes', () => {
    const provider = upsertConnection({
      label: 'Hosted OpenAI',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      secretRef: connectionSecretRef('hosted-openai'),
      id: 'hosted-openai',
    });
    saveCapabilityBinding('draft', provider.id, 'gpt-5.4-mini');
    expect(hasConfiguredWritingConnection()).toBe(true);

    localStorage.clear();
    const local = upsertConnection({
      label: 'Local LM Studio',
      kind: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
    });
    saveCapabilityBinding('planning', local.id, 'local-model');

    expect(hasConfiguredWritingConnection()).toBe(true);
  });

  it('reports a bound bundled engine ready only when its engine is live', () => {
    const engineId = 'bundled-llama-1';
    const connId = localEngineConnectionId(engineId);
    const engine = upsertConnection({
      id: connId,
      label: 'Bundled engine',
      kind: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8081/v1',
    });
    saveCapabilityBinding('draft', engine.id, 'bundled-model');

    // Legacy callers (no live set) keep "configured = ready".
    expect(hasConfiguredWritingConnection()).toBe(true);
    // Engine stopped → not ready even though the binding persists.
    expect(hasConfiguredWritingConnection(undefined, new Set())).toBe(false);
    // Engine running → ready.
    expect(hasConfiguredWritingConnection(undefined, new Set([connId]))).toBe(true);
  });

  it('hasLiveWritingConnection: a bound running engine is ready; a bound-but-stopped one is not', () => {
    const engineId = 'bundled-llama-1';
    const connId = localEngineConnectionId(engineId);
    const engine = upsertConnection({
      id: connId,
      label: 'Bundled engine',
      kind: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8081/v1',
    });
    saveCapabilityBinding('draft', engine.id, 'bundled-model');

    expect(hasLiveWritingConnection([{ engineId }])).toBe(true);
    // No live engines → the bound-but-stopped engine's connection must not count.
    expect(hasLiveWritingConnection([])).toBe(false);
  });

  it('hasLiveWritingConnection: an unrelated running engine is not a writing capability', () => {
    const boundEngineId = 'draft-engine';
    const unrelatedEngineId = 'embedding-engine';
    const boundConnectionId = localEngineConnectionId(boundEngineId);
    const engine = upsertConnection({
      id: boundConnectionId,
      label: 'Draft engine',
      kind: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8081/v1',
    });
    saveCapabilityBinding('draft', engine.id, 'draft-model');

    expect(hasLiveWritingConnection([{ engineId: unrelatedEngineId }])).toBe(false);
  });

  it('hasLiveWritingConnection: a keyless BYOK/external connection is ready with no live engine', () => {
    const provider = upsertConnection({
      label: 'Hosted OpenAI',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      secretRef: connectionSecretRef('hosted-openai'),
      id: 'hosted-openai',
    });
    saveCapabilityBinding('draft', provider.id, 'gpt-5.4-mini');

    expect(hasLiveWritingConnection([])).toBe(true);
  });

  it('counts a usable fallback when the primary binding is not ready', () => {
    const primary = upsertConnection({
      label: 'Hosted Missing Key',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
    });
    const fallback = upsertConnection({
      label: 'Local Fallback',
      kind: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
    });
    saveCapabilityBinding('draft', primary.id, 'hosted-model', {
      connectionId: fallback.id,
      modelId: 'local-model',
    });

    expect(hasConfiguredWritingConnection()).toBe(true);
  });
});
