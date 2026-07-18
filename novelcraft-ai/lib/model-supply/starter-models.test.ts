import { describe, it, expect } from 'vitest';
import {
  STARTER_MODEL_IDS,
  WIZARD_STARTER_COUNT,
  getStarterModelById,
  getStarterModelDetails,
  repoForStarterEntry,
  resolveStarterFormat,
} from './starter-models';
import { MODEL_CATALOG } from './catalog';

describe('starter-models', () => {
  it('pins the first-run shelf to current 2026-07-03 Qwen3.5/Qwen3.6 GGUF-safe ids', () => {
    expect(STARTER_MODEL_IDS).toEqual([
      'qwen-3-5-4b',
      'qwen-3-5-9b',
      'qwen-3-6-27b',
    ]);
  });

  it('every STARTER_MODEL_IDS entry exists in the curated catalog', () => {
    const catalogIds = new Set(MODEL_CATALOG.map(e => e.id));
    for (const id of STARTER_MODEL_IDS) {
      expect(catalogIds.has(id)).toBe(true);
    }
  });

  it('starter ids only point at recommended current catalog entries', () => {
    for (const id of STARTER_MODEL_IDS) {
      const entry = MODEL_CATALOG.find(e => e.id === id);
      expect(entry?.lifecycle).toBe('recommended');
    }
  });

  it('wizard slice length matches WIZARD_STARTER_COUNT and stays bounded', () => {
    expect(WIZARD_STARTER_COUNT).toBeGreaterThan(0);
    expect(STARTER_MODEL_IDS.length).toBeGreaterThanOrEqual(WIZARD_STARTER_COUNT);
  });

  it('getStarterModelById returns the matching catalog entry', () => {
    const entry = getStarterModelById(STARTER_MODEL_IDS[0]);
    expect(entry.id).toBe(STARTER_MODEL_IDS[0]);
  });

  it('getStarterModelById throws for unknown ids', () => {
    expect(() => getStarterModelById('does-not-exist')).toThrow();
  });

  it('getStarterModelDetails preserves STARTER_MODEL_IDS order for gguf on macos', () => {
    const got = getStarterModelDetails('macos', 'gguf');
    const ids = got.map(e => e.id);
    const expectedOrder = STARTER_MODEL_IDS.filter(id =>
      Boolean(MODEL_CATALOG.find(e => e.id === id)?.gguf),
    );
    expect(ids).toEqual(expectedOrder);
  });

  it('getStarterModelDetails on windows only returns gguf-capable entries', () => {
    const got = getStarterModelDetails('windows', 'gguf');
    expect(got.length).toBeGreaterThan(0);
    expect(got.every(e => Boolean(e.gguf))).toBe(true);
  });

  it('getStarterModelDetails on mlx preserves starter order through GGUF fallback when MLX is not verified', () => {
    const got = getStarterModelDetails('macos', 'mlx');
    expect(got.map(e => e.id).slice(0, WIZARD_STARTER_COUNT)).toEqual(
      STARTER_MODEL_IDS.slice(0, WIZARD_STARTER_COUNT),
    );
    expect(resolveStarterFormat(got[0], 'mlx')).toBe('gguf');
  });

  it('repoForStarterEntry uses the GGUF repo for the current starter shelf', () => {
    const entry = MODEL_CATALOG.find(e => e.lifecycle === 'recommended' && e.gguf);
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(resolveStarterFormat(entry, 'mlx')).toBe('gguf');
    expect(repoForStarterEntry(entry, 'mlx')).toBe(entry.gguf!.repo);
    expect(repoForStarterEntry(entry, 'gguf')).toBe(entry.gguf!.repo);
  });

  it('repoForStarterEntry falls back to gguf when format=mlx but no mlx repo', () => {
    const ggufOnly = MODEL_CATALOG.find(e => !e.mlx && e.gguf);
    if (!ggufOnly) return; // Tolerated — every entry might gain mlx later.
    expect(repoForStarterEntry(ggufOnly, 'mlx')).toBe(ggufOnly.gguf!.repo);
  });
});
