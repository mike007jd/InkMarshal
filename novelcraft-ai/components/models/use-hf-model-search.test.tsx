// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHfModelSearch } from '@/components/models/use-hf-model-search';
import { listHfGgufFiles, searchHfModels } from '@/lib/model-supply/hf-hub';
import type { Translations } from '@/lib/i18n';
import type { HfModelFile } from '@/lib/model-supply/types';

vi.mock('@/lib/model-supply/hf-hub', () => ({
  listHfGgufFiles: vi.fn(),
  searchHfModels: vi.fn(),
}));

const t = {
  modelManagerRecoveryGeneric: 'Generic recovery',
  modelManagerModelDirUnavailable: 'Model folder recovery',
  modelManagerRecoveryDisk: 'Disk recovery',
  modelManagerRecoveryNetwork: 'Network recovery',
  modelManagerRecoveryCorrupt: 'Corrupt recovery',
  modelManagerRecoveryEngine: 'Engine recovery',
  modelManagerRecoveryFit: 'Fit recovery',
} as unknown as Translations;

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

describe('useHfModelSearch', () => {
  it('searches with the active format and resets stale file selection', async () => {
    vi.mocked(searchHfModels).mockResolvedValue([
      { repo: 'acme/a', downloads: 10, format: 'gguf' },
    ]);
    const { result } = renderHook(() => useHfModelSearch({ activeFormat: 'gguf', t }));

    act(() => result.current.setQuery(' qwen '));
    await act(async () => {
      await result.current.runSearch();
    });

    expect(searchHfModels).toHaveBeenCalledWith('qwen', 20, 'gguf');
    expect(result.current.results).toEqual([{ repo: 'acme/a', downloads: 10, format: 'gguf' }]);
    expect(result.current.repo).toBeNull();
    expect(result.current.files).toEqual([]);
  });

  it('keeps the latest picked repo when file requests resolve out of order', async () => {
    const first = deferred<HfModelFile[]>();
    const second = deferred<HfModelFile[]>();
    vi.mocked(listHfGgufFiles)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useHfModelSearch({ activeFormat: 'gguf', t }));

    let firstPick!: Promise<void>;
    let secondPick!: Promise<void>;
    act(() => {
      firstPick = result.current.pickRepo('acme/slow');
    });
    act(() => {
      secondPick = result.current.pickRepo('acme/fast');
    });

    await act(async () => {
      second.resolve([file('acme/fast', 'fast.gguf')]);
      await secondPick;
    });
    expect(result.current.repo).toBe('acme/fast');
    expect(result.current.filename).toBe('fast.gguf');
    expect(result.current.selectedFile?.repo).toBe('acme/fast');

    await act(async () => {
      first.resolve([file('acme/slow', 'slow.gguf')]);
      await firstPick;
    });
    expect(result.current.repo).toBe('acme/fast');
    expect(result.current.filename).toBe('fast.gguf');
    expect(result.current.selectedFile?.repo).toBe('acme/fast');
  });

  it('maps file lookup failures to recovery copy', async () => {
    vi.mocked(listHfGgufFiles).mockRejectedValue(new Error('network timeout'));
    const { result } = renderHook(() => useHfModelSearch({ activeFormat: 'gguf', t }));

    await act(async () => {
      await result.current.pickRepo('acme/fail');
    });

    expect(result.current.files).toEqual([]);
    expect(result.current.filesError).toBe('Network recovery');
    expect(result.current.filesLoading).toBe(false);
  });
});
