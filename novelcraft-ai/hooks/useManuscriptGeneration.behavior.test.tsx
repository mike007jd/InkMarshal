// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { useManuscriptGeneration } from './useManuscriptGeneration';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';

// Drive the NDJSON consumer synthetically so the scope guards can be exercised
// without a real ReadableStream.
vi.mock('@/lib/streaming-client', () => ({
  buildModelHeaders: vi.fn(async () => ({})),
  consumeNdjsonStream: vi.fn(async (_res: unknown, handlers: { onEvent: (d: Record<string, unknown>) => void | Promise<void> }) => {
    await handlers.onEvent({ type: 'chunk', text: 'NEW PROSE' });
    await handlers.onEvent({ type: 'done' });
  }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => <LocaleProvider>{children}</LocaleProvider>;
const chapter: ManuscriptChapter = { id: 'ch-1', chapterNumber: 1, title: 'One', content: 'hello', version: 1 };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(opts: { isCurrentEditingScope: () => boolean }) {
  const push = vi.fn();
  const setIsLoading = vi.fn();
  const setToolbarPos = vi.fn();
  const view = renderHook(() => useManuscriptGeneration({
    chapter,
    novelId: 'novel-1',
    storageReady: true,
    creativity: 'balanced',
    styleId: null,
    selectedText: 'ctx',
    highlightRange: null,
    isLoading: false,
    setIsLoading,
    setToolbarPos,
    isCurrentEditingScope: opts.isCurrentEditingScope,
    pushGeneratedTextAsChange: push,
  }), { wrapper });
  return { ...view, push, setIsLoading, setToolbarPos };
}

describe('useManuscriptGeneration single-variant continue', () => {
  it('pushes the streamed text into the diff flow when the scope is still current', async () => {
    const { result, push } = setup({ isCurrentEditingScope: () => true });

    await act(async () => { await result.current.handleContinue(); });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/novels/novel-1/chapters/1/continue',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'continue',
      generated: 'NEW PROSE',
      originalSelection: 'ctx',
    }));
  });

  it('drops the streamed result when the user already switched chapters', async () => {
    const { result, push, setIsLoading } = setup({ isCurrentEditingScope: () => false });

    await act(async () => { await result.current.handleContinue(); });

    // Stream completed but the scope guard short-circuits before mutating diff
    // state — and the finally block leaves isLoading(false) to the now-active scope.
    expect(push).not.toHaveBeenCalled();
    expect(setIsLoading).not.toHaveBeenCalledWith(false);
  });

  // D12: an in-stream `error` frame (provider failed mid-stream after a 200)
  // used to throw out of onEvent, discarding any preceding text — unrecoverable
  // data loss for a long generation. Now the partial result is kept and flagged
  // incomplete so the writer can still review/accept it.
  it('keeps the partial result when an error frame arrives mid-stream', async () => {
    const { consumeNdjsonStream } = await import('@/lib/streaming-client');
    (consumeNdjsonStream as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_res: unknown, handlers: { onEvent: (d: Record<string, unknown>) => void | Promise<void> }) => {
        await handlers.onEvent({ type: 'chunk', text: 'PART ONE. ' });
        await handlers.onEvent({ type: 'chunk', text: 'PART TWO.' });
        await handlers.onEvent({ type: 'error', error: 'provider failed mid-stream' });
      },
    );
    const { result, push } = setup({ isCurrentEditingScope: () => true });

    await act(async () => { await result.current.handleContinue(); });

    // The accumulated partial text survives — it is NOT discarded by the error.
    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'continue',
      generated: 'PART ONE. PART TWO.',
    }));
  });
});
