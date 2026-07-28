// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Chapter, Novel } from '@/lib/db-types';
import { useDurableWritingRun } from '@/lib/writing/use-durable-writing-run';

const novel = (title: string): Novel => ({
  id: 'novel-a',
  userId: 'local-user',
  title,
  genre: 'Fantasy',
  targetWords: 80_000,
  stage: 'ready_for_greenlight',
  progress: 0,
  storySummary: '',
  characterSummary: '',
  arcSummary: '',
  createdAt: 1,
  updatedAt: title === 'Canonical Title' ? 2 : 1,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useDurableWritingRun read ownership', () => {
  it('keeps a local canonical patch when an older novel GET settles later', async () => {
    let resolveRefresh!: (response: Response) => void;
    let novelRequestCount = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/chapters')) {
        return Promise.resolve({ ok: true, json: async () => [] } as Response);
      }
      novelRequestCount += 1;
      if (novelRequestCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => novel('Initial Title'),
        } as Response);
      }
      return new Promise<Response>(resolve => {
        resolveRefresh = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDurableWritingRun('novel-a'));
    await act(async () => {
      await result.current.fetchNovel();
    });
    await waitFor(() => expect(result.current.novel?.title).toBe('Initial Title'));

    let refreshPromise!: Promise<Novel>;
    act(() => {
      refreshPromise = result.current.fetchNovel();
    });

    act(() => {
      result.current.patchNovel(novel('Canonical Title'));
    });

    resolveRefresh({
      ok: true,
      json: async () => novel('Old Focus Snapshot'),
    } as Response);
    await act(async () => {
      await refreshPromise;
    });

    expect(result.current.novel?.title).toBe('Canonical Title');
  });

  it('keeps an in-flight chapter load valid when a newer novel patch lands', async () => {
    let resolveChapters!: (response: Response) => void;
    const chapter = {
      id: 'chapter-1',
      novelId: 'novel-a',
      chapterNumber: 1,
      title: 'Opening',
      content: 'Once upon a time.',
    } as Chapter;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/chapters')) {
        return new Promise<Response>(resolve => {
          resolveChapters = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => novel('Initial Title'),
      } as Response);
    }));

    const { result } = renderHook(() => useDurableWritingRun('novel-a'));
    await act(async () => {
      await Promise.resolve();
    });
    let novelPromise!: Promise<Novel>;
    let chaptersPromise!: Promise<Chapter[]>;
    act(() => {
      novelPromise = result.current.fetchNovel();
      chaptersPromise = result.current.fetchChapters();
    });
    await act(async () => {
      await novelPromise;
    });
    act(() => {
      result.current.patchNovel({ title: 'Canonical Title' });
    });
    resolveChapters({
      ok: true,
      json: async () => [chapter],
    } as Response);
    await act(async () => {
      await chaptersPromise;
    });

    expect(result.current.novel?.title).toBe('Canonical Title');
    expect(result.current.chapters).toEqual([chapter]);
  });

  it('keeps a canonical replacement when an older novel GET settles later', async () => {
    let resolveRefresh!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {
      resolveRefresh = resolve;
    })));

    const { result } = renderHook(() => useDurableWritingRun('novel-a'));
    await act(async () => {
      await Promise.resolve();
    });
    let refreshPromise!: Promise<Novel>;
    act(() => {
      refreshPromise = result.current.fetchNovel();
      result.current.replaceNovel(novel('Canonical Title'));
    });
    resolveRefresh({
      ok: true,
      json: async () => novel('Old Focus Snapshot'),
    } as Response);
    await act(async () => {
      await refreshPromise;
    });

    expect(result.current.novel?.title).toBe('Canonical Title');
  });
});
