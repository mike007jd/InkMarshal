import { describe, expect, it } from 'vitest';

import {
  findInstalledStarterModel,
  fitForStarterEntry,
  groupRolesByEngineId,
  groupRunningEnginesByModelPath,
  localModelHardwareLabel,
  repoForStarterFormat,
} from '@/components/models/local-model-derived';
import type { EngineInfo } from '@/lib/desktop-runtime';
import type { CuratedModelEntry, InstalledLocalModel } from '@/lib/model-supply/types';

function starter(overrides: Partial<CuratedModelEntry> = {}): CuratedModelEntry {
  return {
    id: 'starter-a',
    name: 'Starter A',
    lifecycle: 'recommended',
    role: 'draft',
    category: 'starter',
    gguf: { repo: 'acme/starter-a-gguf', recommendedQuant: 'Q4_K_M' },
    mlx: { repo: 'mlx-community/starter-a-mlx' },
    lastVerifiedAt: '2026-06-20',
    sourceUrls: ['https://example.com/model'],
    minRamGb: 12,
    ...overrides,
  };
}

function installed(overrides: Partial<InstalledLocalModel> = {}): InstalledLocalModel {
  return {
    label: 'Starter A',
    modelPath: '/models/starter-a.gguf',
    format: 'gguf',
    sizeBytes: 123,
    sourceRepo: 'acme/starter-a-gguf',
    managedByApp: true,
    ...overrides,
  };
}

describe('local model derived state', () => {
  it('groups running engines by normalized model path', () => {
    const engines: EngineInfo[] = [
      { engineId: 'e1', format: 'gguf', modelPath: '/models/a.gguf', port: 3101, footprintBytes: 1 },
      { engineId: 'e2', format: 'gguf', modelPath: '/models/a.gguf', port: 3102, footprintBytes: 2 },
      { engineId: 'e3', format: 'mlx', modelPath: '/models/b', port: 3103, footprintBytes: 3 },
    ];

    const grouped = groupRunningEnginesByModelPath(engines);

    expect(grouped.get('/models/a.gguf')?.map(engine => engine.engineId)).toEqual(['e1', 'e2']);
    expect(grouped.get('/models/b')?.map(engine => engine.engineId)).toEqual(['e3']);
  });

  it('groups bound capability roles by engine id', () => {
    const grouped = groupRolesByEngineId(new Map([
      ['draft', { engineId: 'engine-a', connectionId: 'c1', modelId: 'm1' }],
      ['rewrite', { engineId: 'engine-a', connectionId: 'c1', modelId: 'm1' }],
      ['recall', { engineId: 'engine-b', connectionId: 'c2', modelId: 'm2' }],
    ]));

    expect(grouped.get('engine-a')).toEqual(['draft', 'rewrite']);
    expect(grouped.get('engine-b')).toEqual(['recall']);
  });

  it('builds the hardware label from platform, arch, and memory', () => {
    expect(localModelHardwareLabel({
      isMac: true,
      status: { arch: 'aarch64', total_memory_bytes: 16 * 1024 ** 3 },
      copy: { mac: 'Mac', device: 'Device', unknown: 'Unknown' },
    })).toBe('Mac · aarch64 · 16.0 GB');
  });

  it('maps starter fit to localized copy', () => {
    const fit = fitForStarterEntry(
      starter({ minRamGb: 32 }),
      16 * 1024 ** 3,
      {
        bad: 'Bad',
        badDetail: 'Too large',
        tight: 'Tight',
        tightDetail: 'Close',
        good: 'Good',
        goodDetail: 'Comfortable',
        unknown: 'Unknown',
        unknownDetail: 'Need memory',
      },
    );

    expect(fit).toEqual({ state: 'bad', label: 'Bad', detail: 'Too large' });
  });

  it('matches installed starter models by source repo and active format', () => {
    const entry = starter();
    const models = [
      installed({ label: 'Other Model', sourceRepo: 'other/repo' }),
      installed({ sourceRepo: 'acme/starter-a-gguf', modelPath: '/models/right.gguf' }),
    ];

    expect(repoForStarterFormat(entry, 'gguf')).toBe('acme/starter-a-gguf');
    expect(findInstalledStarterModel({
      entry,
      activeFormat: 'gguf',
      installed: models,
    })?.modelPath).toBe('/models/right.gguf');
  });
});
