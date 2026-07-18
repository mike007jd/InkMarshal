// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  starterCatalogFilesKey,
  useStarterCatalogFiles,
} from '@/components/models/use-starter-catalog-files';
import { listHfGgufFiles } from '@/lib/model-supply/hf-hub';
import type { CuratedModelEntry, HfModelFile } from '@/lib/model-supply/types';

vi.mock('@/lib/model-supply/hf-hub', () => ({
  listHfGgufFiles: vi.fn(),
}));

const entry: CuratedModelEntry = {
  id: 'starter-a',
  name: 'Starter A',
  lifecycle: 'recommended',
  role: 'draft',
  category: 'starter',
  gguf: { repo: 'acme/starter-a-gguf', recommendedQuant: 'Q4_K_M' },
  mlx: { repo: 'mlx-community/starter-a-mlx' },
  lastVerifiedAt: '2026-06-20',
  sourceUrls: ['https://example.com/model'],
};

function file(repo: string, filename: string): HfModelFile {
  return {
    repo,
    filename,
    sizeBytes: 1,
    format: 'gguf',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useStarterCatalogFiles', () => {
  it('deduplicates in-flight file list requests and exposes loading by catalog key', async () => {
    const pending = deferred<HfModelFile[]>();
    vi.mocked(listHfGgufFiles).mockReturnValue(pending.promise);
    const { result } = renderHook(() => useStarterCatalogFiles('gguf'));
    const key = starterCatalogFilesKey(entry, 'gguf');

    let first!: Promise<HfModelFile[]>;
    let second!: Promise<HfModelFile[]>;
    act(() => {
      first = result.current.ensureCatalogFiles(entry);
      second = result.current.ensureCatalogFiles(entry);
    });

    expect(listHfGgufFiles).toHaveBeenCalledTimes(1);
    expect(result.current.loadingByKey[key]).toBe(true);

    await act(async () => {
      pending.resolve([file('acme/starter-a-gguf', 'starter.gguf')]);
      await expect(first).resolves.toHaveLength(1);
      await expect(second).resolves.toHaveLength(1);
    });

    expect(result.current.loadingByKey[key]).toBe(false);

    await act(async () => {
      await expect(result.current.ensureCatalogFiles(entry)).resolves.toHaveLength(1);
    });
    expect(listHfGgufFiles).toHaveBeenCalledTimes(1);
  });

  it('caches an empty list after file lookup failure', async () => {
    vi.mocked(listHfGgufFiles).mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useStarterCatalogFiles('gguf'));

    await act(async () => {
      await expect(result.current.ensureCatalogFiles(entry)).resolves.toEqual([]);
    });
    await act(async () => {
      await expect(result.current.ensureCatalogFiles(entry)).resolves.toEqual([]);
    });

    expect(listHfGgufFiles).toHaveBeenCalledTimes(1);
  });
});
