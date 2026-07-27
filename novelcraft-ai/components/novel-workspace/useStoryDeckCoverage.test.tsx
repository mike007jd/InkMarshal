// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useStoryDeckCoverage } from '@/components/novel-workspace/useStoryDeckCoverage';

function jsonResponse(entries: Array<{ type: string }>): Response {
  return new Response(JSON.stringify(entries), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useStoryDeckCoverage', () => {
  it('never projects a stale novel response after the active novel changes', async () => {
    const alpha = deferred<Response>();
    const beta = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      return url.includes('novel-alpha') ? alpha.promise : beta.promise;
    });

    const { result, rerender } = renderHook(
      ({ novelId }) => useStoryDeckCoverage(novelId),
      { initialProps: { novelId: 'novel-alpha' } },
    );
    rerender({ novelId: 'novel-beta' });

    beta.resolve(jsonResponse([
      { type: 'character' },
      { type: 'world' },
      { type: 'outline' },
    ]));
    await waitFor(() => expect(result.current.complete).toBe(true));

    alpha.resolve(jsonResponse([{ type: 'character' }]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.counts).toEqual({
      character: 1,
      world: 1,
      outline: 1,
    });
    expect(result.current.complete).toBe(true);
  });

  it('ignores a non-AbortError rejection from an already-aborted novel request', async () => {
    const alpha = deferred<Response>();
    const beta = deferred<Response>();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      String(input).includes('novel-alpha') ? alpha.promise : beta.promise);
    const { result, rerender } = renderHook(
      ({ novelId }) => useStoryDeckCoverage(novelId),
      { initialProps: { novelId: 'novel-alpha' } },
    );

    rerender({ novelId: 'novel-beta' });
    beta.resolve(jsonResponse([
      { type: 'character' },
      { type: 'world' },
      { type: 'outline' },
    ]));
    await waitFor(() => expect(result.current.complete).toBe(true));

    alpha.resolve(new Response(null, { status: 500 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.complete).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('refreshes coverage once without changing the panel list token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse([{ type: 'character' }]));
    const { result } = renderHook(() => useStoryDeckCoverage('novel-a'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialPanelToken = result.current.panelRefreshToken;
    act(() => result.current.refreshCoverage());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(result.current.panelRefreshToken).toBe(initialPanelToken);
  });

  it('refreshes panel and coverage together for external mutations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse([]));
    const { result } = renderHook(() => useStoryDeckCoverage('novel-a'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.refreshAll());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.panelRefreshToken).toBe(1);
  });
});
