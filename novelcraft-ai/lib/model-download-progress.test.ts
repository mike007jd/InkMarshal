import { describe, expect, it } from 'vitest';

import {
  installedGgufDownloadTaskId,
  normalizeModelDownloadProgress,
  pruneStaleDownloadFailures,
  type ModelProgress,
} from '@/lib/model-download-progress';

const copy = {
  interruptedLabel: 'Failed',
  interruptedError: 'Interrupted',
};

describe('normalizeModelDownloadProgress', () => {
  it('does not trust persisted ready model paths as installed models', () => {
    expect(
      normalizeModelDownloadProgress({
        'catalog:model:gguf': {
          state: 'ready',
          percent: 100,
          label: 'Ready',
          modelPath: '/tmp/not-managed.gguf',
          cancelTaskId: 'repo/file.gguf',
        },
      }, copy),
    ).toEqual({});
  });

  it('converts interrupted downloads to failed diagnostics without task ids or paths', () => {
    expect(
      normalizeModelDownloadProgress({
        'repo/file.gguf': {
          state: 'downloading',
          percent: 67,
          label: 'Downloading',
          modelPath: '/models/file.gguf',
          cancelTaskId: 'repo/file.gguf',
        },
      }, copy),
    ).toEqual({
      'repo/file.gguf': {
        state: 'failed',
        percent: null,
        label: 'Failed',
        error: 'Interrupted',
      },
    });
  });

  it('caps restored diagnostic text and ignores invalid states', () => {
    const restored = normalizeModelDownloadProgress({
      valid: {
        state: 'failed',
        percent: 250,
        label: 'x'.repeat(200),
        error: 'e'.repeat(800),
      },
      invalid: {
        state: 'running',
        label: 'bad',
      },
    }, copy);

    expect(restored.valid?.percent).toBe(100);
    expect(restored.valid?.label).toHaveLength(120);
    expect(restored.valid?.error).toHaveLength(500);
    expect(restored.invalid).toBeUndefined();
  });
});

describe('pruneStaleDownloadFailures', () => {
  const failed: ModelProgress = { state: 'failed', percent: null, label: 'Failed', error: 'Interrupted' };
  const downloading: ModelProgress = { state: 'downloading', percent: 40, label: 'Downloading' };

  it('drops failed/cancelled entries whose target is actually installed', () => {
    const pruned = pruneStaleDownloadFailures(
      {
        'catalog:qwen:gguf': failed,
        'catalog:other:gguf': { ...failed, state: 'cancelled' },
        'catalog:missing:gguf': failed,
      },
      new Set(['catalog:qwen:gguf', 'catalog:other:gguf']),
    );
    expect(Object.keys(pruned)).toEqual(['catalog:missing:gguf']);
  });

  it('never touches live downloads, even when the key matches', () => {
    const progress = { 'catalog:qwen:gguf': downloading };
    expect(pruneStaleDownloadFailures(progress, new Set(['catalog:qwen:gguf']))).toBe(progress);
  });

  it('returns the same reference when nothing changes', () => {
    const progress = { 'catalog:qwen:gguf': failed };
    expect(pruneStaleDownloadFailures(progress, new Set(['unrelated']))).toBe(progress);
  });
});

describe('installedGgufDownloadTaskId', () => {
  it('uses the original Hugging Face filename for nested GGUF downloads', () => {
    expect(installedGgufDownloadTaskId({
      format: 'gguf',
      modelPath: '/models/nested/model.Q4_K_M.gguf',
      sourceRepo: 'org/repo',
      sourceFilename: 'nested/model.Q4_K_M.gguf',
    })).toBe('hf:gguf:v2:org%2Frepo/nested%2Fmodel.Q4_K_M.gguf');
  });

  it('falls back to the model basename for installed metadata written before sourceFilename existed', () => {
    expect(installedGgufDownloadTaskId({
      format: 'gguf',
      modelPath: '/models/model.Q4_K_M.gguf',
      sourceRepo: 'org/repo',
    })).toBe('hf:gguf:v2:org%2Frepo/model.Q4_K_M.gguf');
  });

  it('ignores MLX snapshots and local-only GGUF imports', () => {
    expect(installedGgufDownloadTaskId({
      format: 'mlx',
      modelPath: '/models/org_repo',
      sourceRepo: 'org/repo',
    })).toBeNull();
    expect(installedGgufDownloadTaskId({
      format: 'gguf',
      modelPath: '/models/local.gguf',
    })).toBeNull();
  });
});
