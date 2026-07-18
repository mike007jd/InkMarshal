// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConversationExtract, type UseConversationExtractArgs } from './useConversationExtract';

type Deferred = { promise: Promise<Response>; resolve: (body: unknown) => void };
function deferred(): Deferred {
  let resolve!: (body: unknown) => void;
  const promise = new Promise<Response>(res => {
    resolve = (body: unknown) => res({ ok: true, json: async () => body } as Response);
  });
  return { promise, resolve };
}

const extracted = {
  type: 'character' as const,
  title: 'Extracted Hero',
  summary: 's',
  data: { role: 'protagonist' },
  suggestedWikilinks: [],
  suggestedRelations: [],
};

const args = (
  conversationId: string,
  onError = vi.fn(),
  extra: Partial<UseConversationExtractArgs> = {},
): UseConversationExtractArgs => ({
  novelId: 'novel-1',
  conversationId,
  locale: 'en',
  onError,
  ...extra,
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useConversationExtract concurrency guard', () => {
  it('drops a stale extract whose conversation scope changed before it resolved', async () => {
    const d = deferred();
    fetchMock.mockReturnValue(d.promise);

    const { result, rerender } = renderHook((a: UseConversationExtractArgs) => useConversationExtract(a), {
      initialProps: args('conv-A'),
    });

    // Kick off an extract in scope A (fetch stays pending).
    let pending!: Promise<void>;
    act(() => { pending = result.current.openExtractDialog('msg-A'); });
    expect(result.current.extractingFor).toBe('msg-A');

    // Switch conversation scope while the extract is in flight.
    rerender(args('conv-B'));
    await flush();
    expect(result.current.extractingFor).toBeNull(); // scope effect cleared it

    // The stale extract resolves — the guard must NOT open a prefill in scope B.
    await act(async () => {
      d.resolve(extracted);
      await pending;
    });
    expect(result.current.prefill).toBeNull();
  });

  it('drops an extract superseded by a newer extract in the same scope (seq guard)', async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useConversationExtract(args('conv-A')));

    let firstCall!: Promise<void>;
    let secondCall!: Promise<void>;
    act(() => { firstCall = result.current.openExtractDialog('msg-1'); });
    act(() => { secondCall = result.current.openExtractDialog('msg-2'); });

    // The SECOND (latest) extract resolves first and applies.
    await act(async () => {
      second.resolve({ ...extracted, title: 'Second Wins' });
      await secondCall;
    });
    expect(result.current.prefill?.title).toBe('Second Wins');

    // The FIRST (superseded) extract resolves later — must be ignored.
    await act(async () => {
      first.resolve({ ...extracted, title: 'First Loser' });
      await firstCall;
    });
    expect(result.current.prefill?.title).toBe('Second Wins');
  });

  it('applies an extract that stays the latest in an unchanged scope', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => extracted } as Response);

    const { result } = renderHook(() => useConversationExtract(args('conv-A')));
    await act(async () => { await result.current.openExtractDialog('msg-1'); });

    expect(result.current.prefill?.title).toBe('Extracted Hero');
    expect(result.current.extractingFor).toBeNull();
  });

  it('reports a failed extract via onError', async () => {
    const onError = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) } as Response);

    const { result } = renderHook(() => useConversationExtract(args('conv-A', onError)));
    await act(async () => { await result.current.openExtractDialog('msg-1'); });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.prefill).toBeNull();
  });

  it('applies degraded prefill and reports the degraded state separately', async () => {
    const onDegraded = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...extracted, _degraded: true }) } as Response);

    const { result } = renderHook(() => useConversationExtract(args('conv-A', vi.fn(), { onDegraded })));
    await act(async () => { await result.current.openExtractDialog('msg-1'); });

    expect(result.current.prefill?.title).toBe('Extracted Hero');
    expect(onDegraded).toHaveBeenCalledTimes(1);
  });
});
