import { describe, it, expect } from 'vitest';
import { CAPABILITY_ROLES, type CuratedModelEntry } from './types';
import {
  MODEL_CATALOG,
  MODEL_CATALOG_LAST_VERIFIED_AT,
  catalogForRole,
  isCatalogEntryStale,
  recommendedForPlatform,
} from './catalog';

function rolesFor(entry: CuratedModelEntry): string[] {
  return Array.isArray(entry.role) ? entry.role : [entry.role];
}

function expectSafeRepoId(repo: string): void {
  expect(repo).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
  expect(repo).not.toContain('..');
  expect(repo).not.toContain('\\');
  expect(repo).not.toMatch(/^https?:\/\//i);
}

describe('recommendedForPlatform', () => {
  it('windows entries are all GGUF-capable', () => {
    const win = recommendedForPlatform('windows');
    expect(win.length).toBeGreaterThan(0);
    expect(win.every(e => Boolean(e.gguf))).toBe(true);
  });
  it('macos returns a non-empty list (gguf and/or mlx)', () => {
    const mac = recommendedForPlatform('macos');
    expect(mac.length).toBeGreaterThan(0);
  });

  it('only returns recommended lifecycle entries', () => {
    for (const entry of recommendedForPlatform('macos')) {
      expect(entry.lifecycle).toBe('recommended');
    }
    for (const entry of recommendedForPlatform('windows')) {
      expect(entry.lifecycle).toBe('recommended');
    }
  });
});

describe('MODEL_CATALOG invariants', () => {
  const retiredModelPatterns = [
    /qwen-2-5/i,
    /qwen2\.5/i,
    /qwen-3-(4b|8b|14b)\b/i,
    /qwen3:(4b|8b|14b)\b/i,
    /Qwen3 (4B|8B|14B)/,
    /mistral-nemo/i,
    /Mistral Nemo/i,
    /yi-1-5/i,
    /Yi-1\.5/i,
    /deepseek-r1/i,
    /DeepSeek R1/i,
    /llama-3/i,
    /Llama 3/i,
  ];

  it('uses unique stable ids and valid capability roles', () => {
    const ids = new Set<string>();
    for (const entry of MODEL_CATALOG) {
      expect(entry.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);

      for (const role of rolesFor(entry)) {
        expect(CAPABILITY_ROLES).toContain(role as (typeof CAPABILITY_ROLES)[number]);
      }
    }
  });

  it('keeps downloadable repo fields as safe Hugging Face repo ids, not URLs or paths', () => {
    for (const entry of MODEL_CATALOG) {
      if (entry.gguf?.repo) expectSafeRepoId(entry.gguf.repo);
      if (entry.mlx?.repo) expectSafeRepoId(entry.mlx.repo);
      if (entry.gguf?.recommendedQuant) {
        expect(entry.gguf.recommendedQuant).toMatch(/^[A-Za-z0-9._-]+$/);
      }
    }
  });

  it('has at least one curated entry per runtime capability role', () => {
    for (const role of CAPABILITY_ROLES) {
      expect(catalogForRole(role).length).toBeGreaterThan(0);
    }
  });

  it('requires freshness metadata and source URLs for every curated model', () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.lastVerifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.sourceUrls.length).toBeGreaterThan(0);
      for (const url of entry.sourceUrls) {
        expect(url).toMatch(/^https:\/\//);
      }
    }
  });

  it('keeps recommended entries freshly verified and current', () => {
    const baseline = new Date(`${MODEL_CATALOG_LAST_VERIFIED_AT}T12:00:00.000Z`);
    for (const entry of MODEL_CATALOG.filter(e => e.lifecycle === 'recommended')) {
      expect(isCatalogEntryStale(entry, baseline)).toBe(false);
      expect(entry.replacementId).toBeUndefined();
    }
  });

  it('uses the current 2026-07-03 GGUF-safe local starter generation', () => {
    expect(MODEL_CATALOG.filter(e => e.lifecycle === 'recommended').map(e => e.id)).toEqual([
      'qwen-3-5-4b',
      'qwen-3-5-9b',
      'qwen-3-6-27b',
    ]);
  });

  it('does not expose MLX starter repos until the bundled MLX engine supports the architecture', () => {
    for (const entry of MODEL_CATALOG.filter(e => e.lifecycle === 'recommended')) {
      expect(entry.mlx).toBeUndefined();
      expect(entry.sourceUrls.some(url => url.includes('mlx-community/'))).toBe(false);
    }
  });

  it('does not retain retired chat or reasoning models in the curated catalog', () => {
    const serialized = JSON.stringify(MODEL_CATALOG);
    for (const pattern of retiredModelPatterns) {
      expect(serialized).not.toMatch(pattern);
    }
  });

  // Freshness gate: detect known suspended/private/deprecated provider models
  // before they leak into the local starter catalog.
  it('does not catalogue known suspended, private, or deprecated provider models', () => {
    const suspendedModelPatterns = [
      /claude-mythos-5/i,
      /claude-mythos-preview/i,
    ];
    const serialized = JSON.stringify(MODEL_CATALOG);
    for (const pattern of suspendedModelPatterns) {
      expect(serialized).not.toMatch(pattern);
    }
  });
});
