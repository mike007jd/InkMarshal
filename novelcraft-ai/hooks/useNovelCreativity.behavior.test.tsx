// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNovelCreativity } from './useNovelCreativity';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useNovelCreativity persistence', () => {
  it('surfaces PATCH failures without reverting the local selection', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    const { result } = renderHook(() => useNovelCreativity('novel-1', 'balanced'));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => result.current.setCreativity('wild'));
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/novels/novel-1/settings', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ creativity: 'wild' }),
    }));
    expect(result.current.creativity).toBe('wild');
    expect(result.current.syncFailed).toBe(true);
  });
});
