// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOVEL_LIST_INVALIDATED_EVENT,
  NOVEL_UPDATED_EVENT,
  notifyNovelListInvalidated,
  notifyNovelUpdated,
  useNovel,
  useNovels,
  type NovelUpdatedEventDetail,
} from '@/lib/use-storage';
import type { Novel } from '@/lib/db-types';

const baseNovel = (overrides: Partial<Novel> = {}): Novel => ({
  id: 'novel-a',
  userId: 'local-user',
  title: 'Novel A',
  genre: 'Fantasy',
  targetWords: 80_000,
  stage: 'ready_for_greenlight',
  progress: 0,
  storySummary: '',
  characterSummary: '',
  arcSummary: '',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('novel update fan-out', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('publishes a typed novel-updated event only after a successful PATCH', async () => {
    const updated = baseNovel({ title: 'Renamed', updatedAt: 2 });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => updated,
    } as Response);

    const seen: Novel[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<NovelUpdatedEventDetail>).detail.novel);
    };
    window.addEventListener(NOVEL_UPDATED_EVENT, listener);

    const { result } = renderHook(() => useNovel('novel-a'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => updated,
    } as Response);

    let returned: Novel | null = null;
    await act(async () => {
      returned = await result.current.update({ title: 'Renamed' });
    });

    expect(returned).toEqual(updated);
    expect(seen).toEqual([updated]);
    expect(result.current.novel?.title).toBe('Renamed');

    window.removeEventListener(NOVEL_UPDATED_EVENT, listener);
  });

  it('does not publish when the novel PATCH fails', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => baseNovel(),
    } as Response);

    const listener = vi.fn();
    window.addEventListener(NOVEL_UPDATED_EVENT, listener);

    const { result } = renderHook(() => useNovel('novel-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    let returned: Novel | null = 'sentinel' as unknown as Novel;
    await act(async () => {
      returned = await result.current.update({ title: 'Nope' });
    });

    expect(returned).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(NOVEL_UPDATED_EVENT, listener);
  });

  it('does not publish a superseded PATCH response after the newer response', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => baseNovel(),
    } as Response);

    const seen: Novel[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<NovelUpdatedEventDetail>).detail.novel);
    };
    window.addEventListener(NOVEL_UPDATED_EVENT, listener);

    const { result } = renderHook(() => useNovel('novel-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        resolveFirst = resolve;
      }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        resolveSecond = resolve;
      }));

    let first!: Promise<Novel | null>;
    let second!: Promise<Novel | null>;
    act(() => {
      first = result.current.update({ title: 'Older intent' });
      second = result.current.update({ title: 'Newest intent' });
    });

    const newest = baseNovel({ title: 'Newest intent', updatedAt: 3 });
    resolveSecond({ ok: true, json: async () => newest } as Response);
    await act(async () => {
      await second;
    });

    const older = baseNovel({ title: 'Older intent', updatedAt: 2 });
    resolveFirst({ ok: true, json: async () => older } as Response);
    await act(async () => {
      await first;
    });

    expect(seen).toEqual([newest]);
    expect(result.current.novel).toEqual(newest);
    window.removeEventListener(NOVEL_UPDATED_EVENT, listener);
  });

  it('publishes independent canonical updates for different novel ids', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => baseNovel(),
    } as Response);
    const seen: Novel[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<NovelUpdatedEventDetail>).detail.novel);
    };
    window.addEventListener(NOVEL_UPDATED_EVENT, listener);

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useNovel(id),
      { initialProps: { id: 'novel-a' } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveA!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        resolveA = resolve;
      }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => baseNovel({ id: 'novel-b', title: 'Novel B' }),
      } as Response)
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        resolveB = resolve;
      }));

    let updateA!: Promise<Novel | null>;
    act(() => {
      updateA = result.current.update({ title: 'A canonical' });
    });
    rerender({ id: 'novel-b' });
    await waitFor(() => expect(result.current.novel?.id).toBe('novel-b'));

    let updateB!: Promise<Novel | null>;
    act(() => {
      updateB = result.current.update({ title: 'B canonical' });
    });
    const canonicalB = baseNovel({
      id: 'novel-b',
      title: 'B canonical',
      updatedAt: 3,
    });
    resolveB({ ok: true, json: async () => canonicalB } as Response);
    await act(async () => {
      await updateB;
    });

    const canonicalA = baseNovel({ title: 'A canonical', updatedAt: 2 });
    resolveA({ ok: true, json: async () => canonicalA } as Response);
    await act(async () => {
      await updateA;
    });

    expect(seen).toEqual([canonicalB, canonicalA]);
    expect(result.current.novel).toEqual(canonicalB);
    window.removeEventListener(NOVEL_UPDATED_EVENT, listener);
  });

  it('does not let a GET started before a successful PATCH restore the old title', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => baseNovel(),
    } as Response);

    const { result } = renderHook(() => useNovel('novel-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveRefresh!: (response: Response) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        resolveRefresh = resolve;
      }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => baseNovel({ title: 'Canonical Title', updatedAt: 2 }),
      } as Response);

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    await act(async () => {
      await result.current.update({ title: 'Canonical Title' });
    });
    expect(result.current.novel?.title).toBe('Canonical Title');

    resolveRefresh({
      ok: true,
      json: async () => baseNovel({ title: 'Old Focus Snapshot', updatedAt: 1 }),
    } as Response);
    await act(async () => {
      await refreshPromise;
    });

    expect(result.current.novel?.title).toBe('Canonical Title');
  });

  it('converges an already-loaded sidebar row without inserting unknown ids', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        baseNovel({ id: 'novel-b', title: 'Novel B', updatedAt: 5 }),
        baseNovel(),
      ],
    } as Response);

    const { result } = renderHook(() => useNovels());
    await waitFor(() => expect(result.current.novels).toHaveLength(2));

    act(() => {
      notifyNovelUpdated(baseNovel({
        title: 'Renamed A',
        updatedAt: 9,
      }));
    });
    expect(result.current.novels.map(n => n.title)).toEqual(['Renamed A', 'Novel B']);

    act(() => {
      notifyNovelUpdated(baseNovel({
        id: 'unknown-novel',
        title: 'Ghost',
      }));
    });
    expect(result.current.novels).toHaveLength(2);
    expect(result.current.novels.some(n => n.id === 'unknown-novel')).toBe(false);
  });

  it('refreshes library membership after a cross-layout restore', async () => {
    const restored = baseNovel({ title: 'Restored Novel', updatedAt: 8 });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [restored] } as Response);

    const listener = vi.fn();
    window.addEventListener(NOVEL_LIST_INVALIDATED_EVENT, listener);
    const { result } = renderHook(() => useNovels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.novels).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith('/api/novels');

    // Undo toast and TrashPanel restore both call this; mounted sidebars converge.
    act(() => notifyNovelListInvalidated());
    await waitFor(() => expect(result.current.novels).toEqual([restored]));
    expect(listener).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/novels');
    window.removeEventListener(NOVEL_LIST_INVALIDATED_EVENT, listener);
  });

  it('merges a title event that arrives before an older initial list GET resolves', async () => {
    const fetchMock = vi.mocked(fetch);
    let finishInitial!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>(resolve => {
        finishInitial = resolve;
      }),
    );

    const { result } = renderHook(() => useNovels());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    act(() => {
      notifyNovelUpdated(baseNovel({
        title: 'Renamed During Load',
        updatedAt: 9,
      }));
    });
    expect(result.current.novels).toEqual([]);

    finishInitial({
      ok: true,
      json: async () => [
        baseNovel({ id: 'novel-b', title: 'Novel B', updatedAt: 5 }),
        baseNovel({ title: 'Old List Snapshot' }),
      ],
    } as Response);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.novels).toHaveLength(2);
    expect(result.current.novels[0].title).toBe('Renamed During Load');
    expect(result.current.novels[1].title).toBe('Novel B');
  });

  it('trusts a GET started after an event for newer non-title fields', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [baseNovel()],
    } as Response);
    const { result } = renderHook(() => useNovels());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      notifyNovelUpdated(baseNovel({
        title: 'Renamed Before Refresh',
        progress: 10,
        updatedAt: 2,
      }));
    });
    expect(result.current.novels[0].progress).toBe(10);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [baseNovel({
        title: 'Renamed Before Refresh',
        progress: 65,
        updatedAt: 3,
      })],
    } as Response);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.novels[0].title).toBe('Renamed Before Refresh');
    expect(result.current.novels[0].progress).toBe(65);
    expect(result.current.novels[0].updatedAt).toBe(3);
  });
});
