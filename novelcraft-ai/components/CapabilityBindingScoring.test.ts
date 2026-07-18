import { describe, expect, it } from 'vitest';

import {
  connectionTier,
  scoreCandidate,
  type Candidate,
} from '@/components/CapabilityBindingPanel';
import type {
  CuratedModelEntry,
  RuntimeConnection,
} from '@/lib/model-supply/types';

// MS-01 — the locked product rule: bundled local engine is the DEFAULT,
// detected local (Ollama/LM Studio) is secondary, BYOK cloud is LAST resort.
// These tests prove the scorer encodes that tiering deterministically, so
// autoBind can never rank a cloud model above a viable local one.

function conn(overrides: Partial<RuntimeConnection>): RuntimeConnection {
  return {
    id: 'c',
    label: 'c',
    kind: 'provider',
    transport: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    secretRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// A catalog entry that fits the `draft` role (so roleFit = 1 → +10).
const draftEntry: CuratedModelEntry = {
  id: 'fit',
  name: 'Fit Model',
  lifecycle: 'recommended',
  role: 'draft',
  category: 'test',
  lastVerifiedAt: '2026-06-02',
  sourceUrls: ['https://example.com/model-card'],
};

const cloudCandidate: Candidate = {
  source: 'remote',
  catalogMatch: draftEntry,
  modelLabel: 'cloud-model',
  modelId: 'cloud-model',
  connectionId: 'cloud',
  connection: conn({ id: 'cloud', kind: 'provider', baseUrl: 'https://api.openai.com/v1' }),
};

const ollamaCandidate: Candidate = {
  source: 'remote',
  catalogMatch: draftEntry,
  modelLabel: 'local-ollama',
  modelId: 'local-ollama',
  connectionId: 'ollama',
  connection: conn({
    id: 'ollama',
    kind: 'local',
    transport: 'ollama-native',
    baseUrl: 'http://127.0.0.1:11434',
  }),
};

const engineCandidate: Candidate = {
  source: 'engine',
  catalogMatch: draftEntry,
  modelLabel: 'bundled',
  modelId: 'bundled',
  connectionId: 'local-engine:1',
  alreadyRunning: {
    engineId: '1',
    modelPath: '/m.gguf',
    port: 9000,
  } as Candidate['alreadyRunning'],
};

const installedCandidate: Candidate = {
  source: 'installed',
  catalogMatch: draftEntry,
  modelLabel: 'installed',
  modelId: 'installed',
  installed: {
    modelPath: '/m.gguf',
    label: 'installed',
    format: 'gguf',
  } as Candidate['installed'],
};

describe('connectionTier (MS-01)', () => {
  it('classifies running engines and installed locals as bundled', () => {
    expect(connectionTier(engineCandidate)).toBe('bundled');
    expect(connectionTier(installedCandidate)).toBe('bundled');
  });

  it('classifies loopback Ollama / LM Studio as detected-local', () => {
    expect(connectionTier(ollamaCandidate)).toBe('detected');
    expect(
      connectionTier({
        ...ollamaCandidate,
        connection: conn({ kind: 'local', transport: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }),
      }),
    ).toBe('detected');
  });

  // The common Ollama OpenAI-compat path: users wire a `kind: 'custom'`
  // connection at `http://127.0.0.1:11434/v1`. This was previously classified
  // as cloud because the connectionTier only inspected `kind: 'local'` —
  // leaving a viable local engine tied with BYOK cloud and frequently losing
  // on roleFit ties. The single invariant is now "loopback target = local".
  it('classifies a custom OpenAI-compat connection at loopback as detected-local', () => {
    for (const url of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:11434/v1',
      'http://[::1]:11434/v1',
    ]) {
      expect(
        connectionTier({
          ...ollamaCandidate,
          connection: conn({ kind: 'custom', transport: 'openai-compatible', baseUrl: url }),
        }),
      ).toBe('detected');
    }
  });

  it('classifies BYOK provider endpoints as cloud (last resort)', () => {
    expect(connectionTier(cloudCandidate)).toBe('cloud');
    // A `local`-kind connection at a NON-loopback host is not a trusted local
    // server — treat it as cloud.
    expect(
      connectionTier({
        ...ollamaCandidate,
        connection: conn({ kind: 'local', transport: 'openai-compatible', baseUrl: 'https://remote.example.com/v1' }),
      }),
    ).toBe('cloud');
  });

  it('treats a remote candidate with no backing connection as cloud', () => {
    expect(connectionTier({ ...cloudCandidate, connection: undefined })).toBe('cloud');
  });
});

describe('scoreCandidate tier ordering (MS-01)', () => {
  const score = (c: Candidate) => scoreCandidate(c, 'draft', null, new Map());

  it('ranks bundled engine above detected-local above cloud at equal fit', () => {
    expect(score(engineCandidate)).toBeGreaterThan(score(ollamaCandidate));
    expect(score(ollamaCandidate)).toBeGreaterThan(score(cloudCandidate));
  });

  it('ranks an installed local (bundled) above a cloud model of equal fit', () => {
    expect(score(installedCandidate)).toBeGreaterThan(score(cloudCandidate));
  });

  it('keeps a local candidate with unknown footprint ABOVE a cloud one (local-preference bonus)', () => {
    // No budget snapshot → installed footprint unknown. The +1 local bonus must
    // still beat a same-fit cloud candidate (tier 0).
    expect(score(installedCandidate)).toBeGreaterThan(score(cloudCandidate));
    // And a cloud candidate with even HIGHER raw fit must not leapfrog a viable
    // local one once the tier weight dominates.
    const cloudHighFit: Candidate = {
      ...cloudCandidate,
      catalogMatch: { ...draftEntry, role: ['draft', 'rewrite', 'planning', 'recall'] },
    };
    expect(score(installedCandidate)).toBeGreaterThan(score(cloudHighFit));
  });

  it('only lets cloud win when no local candidate is present', () => {
    const ranked = [cloudCandidate]
      .map(c => ({ c, s: score(c) }))
      .sort((a, b) => b.s - a.s);
    expect(ranked[0].c.source).toBe('remote');
    // …but adding any local candidate flips the winner to local.
    const withLocal = [cloudCandidate, ollamaCandidate, engineCandidate]
      .map(c => ({ c, s: score(c) }))
      .sort((a, b) => b.s - a.s);
    expect(withLocal[0].c.source).toBe('engine');
  });
});
