// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import {
  mapDurableEditHistory,
  useAIEditChat,
} from './useAIEditChat';
import type { ChangeItem } from '@/lib/diff-utils';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';
import type { EditingScope } from '@/hooks/useChapterDraftController';
import { buildModelHeaders, consumeNdjsonStream } from '@/lib/streaming-client';

vi.mock('@/lib/streaming-client', () => ({
  buildModelHeaders: vi.fn(async () => ({ 'Content-Type': 'application/json' })),
  consumeNdjsonStream: vi.fn(async (_res: unknown, handlers: { onEvent: (d: Record<string, unknown>) => void | Promise<void> }) => {
    await handlers.onEvent({ type: 'change', id: 'c1', original: 'hello', replacement: 'hi there' });
    await handlers.onEvent({ type: 'done', summary: '1 change' });
    return { malformedLines: 0 };
  }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => <LocaleProvider>{children}</LocaleProvider>;
const chapter: ManuscriptChapter = { id: 'ch-1', chapterNumber: 1, title: 'One', content: 'hello', version: 1 };
const chapter2: ManuscriptChapter = { id: 'ch-2', chapterNumber: 2, title: 'Two', content: 'other', version: 1 };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [] }),
  } as Response);
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(buildModelHeaders).mockImplementation(async () => ({ 'Content-Type': 'application/json' }));
  vi.mocked(consumeNdjsonStream).mockImplementation(async (_res, handlers) => {
    await handlers.onEvent({ type: 'change', id: 'c1', original: 'hello', replacement: 'hi there' });
    await handlers.onEvent({ type: 'done', summary: '1 change' });
    return { malformedLines: 0 };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(opts: {
  isCurrentEditingScope: (scope: EditingScope) => boolean;
  chapter?: ManuscriptChapter | null;
  storageReady?: boolean;
}) {
  const setChanges = vi.fn();
  const handleClearSelection = vi.fn();
  const setIsLoading = vi.fn();
  const setEditStreaming = vi.fn();
  const changesRef: { current: ChangeItem[] } = { current: [] };
  const view = renderHook(
    (props: { chapter: ManuscriptChapter | null; storageReady: boolean }) => useAIEditChat({
      chapter: props.chapter,
      novelId: 'novel-1',
      storageReady: props.storageReady,
      creativity: 'balanced',
      styleId: null,
      selectedText: undefined,
      isCurrentEditingScope: opts.isCurrentEditingScope,
      changesRef,
      setChanges,
      handleClearSelection,
      setIsLoading,
      setEditStreaming,
      getCurrentEditorContent: () => 'hello',
    }),
    {
      wrapper,
      initialProps: {
        chapter: opts.chapter === undefined ? chapter : opts.chapter,
        storageReady: opts.storageReady ?? true,
      },
    },
  );
  return { ...view, setChanges, handleClearSelection, setIsLoading, setEditStreaming, changesRef };
}

function postBodies() {
  return fetchMock.mock.calls
    .filter(call => call[1]?.method === 'POST')
    .map(call => JSON.parse(call[1]?.body as string));
}

function patchBodies() {
  return fetchMock.mock.calls
    .filter(call => call[1]?.method === 'PATCH')
    .map(call => JSON.parse(call[1]?.body as string));
}

describe('mapDurableEditHistory', () => {
  it('maps successful assistant JSON to its human summary and leaves cancelled text unchanged', () => {
    expect(mapDurableEditHistory([
      {
        id: 'u1',
        role: 'user',
        content: 'tighten this',
        status: 'done',
        createdAt: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: JSON.stringify({
          summary: 'Tightened the opening',
          changes: [
            { original: 'a', replacement: 'b' },
            { original: 'same', replacement: 'same' },
            { original: ' \n\t', replacement: 'bad insert' },
          ],
        }),
        status: 'done',
        createdAt: 2,
      },
      {
        id: 'u2',
        role: 'user',
        content: 'warmer tone',
        status: 'cancelled',
        createdAt: 3,
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '[已停止]',
        status: 'cancelled',
        createdAt: 4,
      },
    ])).toEqual([
      {
        id: 'u1',
        role: 'user',
        content: 'tighten this',
        timestamp: 1,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Tightened the opening',
        timestamp: 2,
        changesCount: 1,
      },
      {
        id: 'u2',
        role: 'user',
        content: 'warmer tone',
        timestamp: 3,
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '[已停止]',
        timestamp: 4,
      },
    ]);
  });
});

describe('useAIEditChat freeform edit stream', () => {
  it('publishes streamed changes and clears selection when the scope is current', async () => {
    const { result, setChanges, handleClearSelection, setEditStreaming } = setup({ isCurrentEditingScope: () => true });

    await act(async () => { await result.current.handleSend('make it warmer'); });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/novels/novel-1/chapters/1/edit',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = postBodies()[0];
    expect(body).toEqual(expect.objectContaining({
      instruction: 'make it warmer',
      runId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ),
    }));
    expect(body).not.toHaveProperty('stoppedLabel');
    expect(setChanges).toHaveBeenCalledWith([expect.objectContaining({ original: 'hello', replacement: 'hi there' })]);
    expect(handleClearSelection).toHaveBeenCalled();
    expect(setEditStreaming).toHaveBeenCalledWith(false);
  });

  it('drops an exact no-op stream change before publishing the diff UI', async () => {
    vi.mocked(consumeNdjsonStream).mockImplementationOnce(async (_res, handlers) => {
      await handlers.onEvent({
        type: 'change',
        id: 'c1',
        original: 'hello',
        replacement: 'hello',
      });
      await handlers.onEvent({
        type: 'change',
        id: 'c2',
        original: ' \n\t',
        replacement: 'must not insert at the start',
      });
      await handlers.onEvent({ type: 'done', summary: 'No effective change' });
      return { malformedLines: 0 };
    });
    const { result, setChanges, changesRef } = setup({ isCurrentEditingScope: () => true });

    await act(async () => { await result.current.handleSend('keep it the same'); });

    expect(changesRef.current).toEqual([]);
    expect(setChanges).toHaveBeenCalledWith([]);
    await waitFor(() => {
      expect(result.current.chatMessages.at(-1)).toEqual(expect.objectContaining({
        role: 'assistant',
        content: 'No effective change',
        changesCount: 0,
      }));
    });
  });

  it('ignores stream events for a chapter the user already left', async () => {
    const { result, setChanges, handleClearSelection } = setup({ isCurrentEditingScope: () => false });

    await act(async () => { await result.current.handleSend('make it warmer'); });

    expect(setChanges).not.toHaveBeenCalled();
    expect(handleClearSelection).not.toHaveBeenCalled();
  });

  it('hydrates durable edit history when storage becomes ready', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: 'tighten this',
            status: 'cancelled',
            createdAt: 10,
          },
          {
            id: 'a1',
            role: 'assistant',
            content: '[Stopped]',
            status: 'cancelled',
            createdAt: 11,
          },
        ],
      }),
    });

    const { result } = setup({ isCurrentEditingScope: () => true, storageReady: true });

    await waitFor(() => {
      expect(result.current.chatMessages).toEqual([
        {
          id: 'u1',
          role: 'user',
          content: 'tighten this',
          timestamp: 10,
        },
        {
          id: 'a1',
          role: 'assistant',
          content: '[Stopped]',
          timestamp: 11,
        },
      ]);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/novels/novel-1/chapters/1/edit',
      expect.objectContaining({ signal: expect.any(AbortSignal), cache: 'no-store' }),
    );
  });

  it('suppresses stale hydrate responses after a chapter switch', async () => {
    let resolveChapter1: ((value: Response) => void) | undefined;
    const chapter1Pending = new Promise<Response>(resolve => {
      resolveChapter1 = resolve;
    });

    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/chapters/1/edit')) {
        return chapter1Pending;
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          messages: [
            {
              id: 'ch2-u',
              role: 'user',
              content: 'chapter two only',
              status: 'done',
              createdAt: 20,
            },
            {
              id: 'ch2-a',
              role: 'assistant',
              content: JSON.stringify({ summary: 'Edited chapter two', changes: [] }),
              status: 'done',
              createdAt: 21,
            },
          ],
        }),
      } as Response);
    });

    let currentChapterId = 'ch-1';
    const { result, rerender } = setup({
      isCurrentEditingScope: scope => scope.chapterId === currentChapterId,
      chapter,
    });

    await act(async () => {
      currentChapterId = 'ch-2';
      result.current.resetForChapterSwitch();
      rerender({ chapter: chapter2, storageReady: true });
    });

    await waitFor(() => {
      expect(result.current.chatMessages.map(m => m.content)).toEqual([
        'chapter two only',
        'Edited chapter two',
      ]);
    });

    await act(async () => {
      resolveChapter1?.({
        ok: true,
        json: async () => ({
          messages: [
            {
              id: 'stale-u',
              role: 'user',
              content: 'stale chapter one',
              status: 'cancelled',
              createdAt: 1,
            },
            {
              id: 'stale-a',
              role: 'assistant',
              content: '[Stopped]',
              status: 'cancelled',
              createdAt: 2,
            },
          ],
        }),
      } as Response);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.chatMessages.map(m => m.content)).toEqual([
      'chapter two only',
      'Edited chapter two',
    ]);
    expect(result.current.chatMessages.some(m => m.content.includes('stale'))).toBe(false);
  });

  it('hydrates after a slow chapter flush activates the incoming scope', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve({
        ok: true,
        json: async () => ({
          messages: url.endsWith('/chapters/2/edit')
            ? [{
                id: 'ch2-u',
                role: 'user',
                content: 'history after flush',
                status: 'cancelled',
                createdAt: 20,
              }]
            : [],
        }),
      } as Response);
    });

    let currentChapterId = 'ch-1';
    const { result, rerender } = setup({
      isCurrentEditingScope: scope => scope.chapterId === currentChapterId,
      chapter,
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/novels/novel-1/chapters/1/edit',
        expect.any(Object),
      );
    });
    fetchMock.mockClear();

    // Incoming props arrive while the outgoing save still owns the active
    // scope. The prop effect must not issue a doomed chapter-2 GET.
    rerender({ chapter: chapter2, storageReady: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // ManuscriptEditingView does this only after the outgoing flush resolves:
    // applyChapterSwitch repoints the scope, then reset starts hydration.
    currentChapterId = 'ch-2';
    act(() => {
      result.current.resetForChapterSwitch();
    });

    await waitFor(() => {
      expect(result.current.chatMessages.map(message => message.content)).toEqual([
        'history after flush',
      ]);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/novels/novel-1/chapters/2/edit',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('quick Stop before POST still persists via PATCH and shows Stopped only after durable ack', async () => {
    let resolveHeaders: ((value: Record<string, string>) => void) | undefined;
    let resolvePatch: ((value: Response) => void) | undefined;
    const patchPending = new Promise<Response>(resolve => {
      resolvePatch = resolve;
    });
    vi.mocked(buildModelHeaders).mockImplementation(() => new Promise(resolve => {
      resolveHeaders = resolve;
    }));

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return patchPending;
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ messages: [] }),
      } as Response);
    });

    const { result, setIsLoading } = setup({ isCurrentEditingScope: () => true });

    let sendPromise: Promise<void>;
    await act(async () => {
      sendPromise = result.current.handleSend('make it warmer');
    });

    expect(result.current.chatMessages.some(m => m.content === '[Stopped]')).toBe(false);

    await act(async () => {
      result.current.handleStopEdit();
    });

    await waitFor(() => {
      expect(patchBodies()).toHaveLength(1);
    });
    expect(patchBodies()[0]).toEqual(expect.objectContaining({
      instruction: 'make it warmer',
      stoppedLabel: '[Stopped]',
      runId: expect.any(String),
    }));
    expect(result.current.chatMessages.some(m => m.content === '[Stopped]')).toBe(false);

    await act(async () => {
      resolveHeaders?.({ 'Content-Type': 'application/json' });
      await sendPromise!;
    });

    expect(setIsLoading).not.toHaveBeenCalledWith(false);

    await act(async () => {
      await result.current.handleSend('must wait for stop acknowledgement');
    });
    expect(postBodies()).toHaveLength(0);
    expect(
      result.current.chatMessages.some(m => m.content === 'must wait for stop acknowledgement'),
    ).toBe(false);

    await act(async () => {
      resolvePatch?.({
        ok: true,
        json: async () => ({ status: 'cancelled', outcome: 'inserted' }),
      } as Response);
    });

    await waitFor(() => {
      expect(result.current.chatMessages.some(m => m.content === '[Stopped]')).toBe(true);
      expect(setIsLoading).toHaveBeenCalledWith(false);
    });

    expect(postBodies()).toHaveLength(0);
    expect(patchBodies()).toHaveLength(1);
  });

  it('double Stop is one PATCH mutation and one visible marker', async () => {
    let resolveStream: (() => void) | undefined;
    const streamGate = new Promise<void>(resolve => {
      resolveStream = resolve;
    });
    vi.mocked(consumeNdjsonStream).mockImplementation(async () => {
      await streamGate;
      return { malformedLines: 0 };
    });

    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'cancelled', outcome: 'inserted' }),
        } as Response);
      }
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          body: {},
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ messages: [] }),
      } as Response);
    });

    const { result } = setup({ isCurrentEditingScope: () => true });

    let sendPromise: Promise<void>;
    await act(async () => {
      sendPromise = result.current.handleSend('make it warmer');
    });

    await waitFor(() => {
      expect(postBodies()).toHaveLength(1);
    });

    await act(async () => {
      result.current.handleStopEdit();
      result.current.handleStopEdit();
    });

    await waitFor(() => {
      expect(patchBodies()).toHaveLength(1);
      expect(result.current.chatMessages.filter(m => m.content === '[Stopped]')).toHaveLength(1);
    });

    await act(async () => {
      resolveStream?.();
      await sendPromise!;
    });
  });

  it('a stopped run settling late cannot clear or publish over its replacement', async () => {
    let resolveFirstStream: (() => void) | undefined;
    let resolveSecondStream: (() => void) | undefined;
    const firstStream = new Promise<void>(resolve => {
      resolveFirstStream = resolve;
    });
    const secondStream = new Promise<void>(resolve => {
      resolveSecondStream = resolve;
    });
    let streamCall = 0;
    vi.mocked(consumeNdjsonStream).mockImplementation(async (_res, handlers) => {
      streamCall += 1;
      if (streamCall === 1) {
        await firstStream;
        await handlers.onEvent({
          type: 'change',
          id: 'late-a',
          original: 'hello',
          replacement: 'stale run A',
        });
        await handlers.onEvent({ type: 'done', summary: 'stale A' });
      } else {
        await secondStream;
        await handlers.onEvent({
          type: 'change',
          id: 'fresh-b',
          original: 'hello',
          replacement: 'fresh run B',
        });
        await handlers.onEvent({ type: 'done', summary: 'fresh B' });
      }
      return { malformedLines: 0 };
    });

    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'cancelled', outcome: 'inserted' }),
        } as Response);
      }
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, body: {} } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ messages: [] }),
      } as Response);
    });

    const {
      result,
      setChanges,
      handleClearSelection,
      setIsLoading,
      setEditStreaming,
    } = setup({ isCurrentEditingScope: () => true });

    let firstSend: Promise<void>;
    await act(async () => {
      firstSend = result.current.handleSend('run A');
    });
    await waitFor(() => expect(postBodies()).toHaveLength(1));

    await act(async () => {
      result.current.handleStopEdit();
    });
    await waitFor(() => {
      expect(result.current.chatMessages.some(message => message.content === '[Stopped]')).toBe(true);
    });

    setChanges.mockClear();
    handleClearSelection.mockClear();
    setIsLoading.mockClear();
    setEditStreaming.mockClear();

    let secondSend: Promise<void>;
    await act(async () => {
      secondSend = result.current.handleSend('run B');
    });
    await waitFor(() => expect(postBodies()).toHaveLength(2));

    await act(async () => {
      resolveFirstStream?.();
      await firstSend!;
    });

    expect(setIsLoading).not.toHaveBeenCalledWith(false);
    expect(setEditStreaming).not.toHaveBeenCalledWith(false);
    expect(handleClearSelection).not.toHaveBeenCalled();
    expect(setChanges).not.toHaveBeenCalledWith([
      expect.objectContaining({ replacement: 'stale run A' }),
    ]);
    expect(result.current.chatMessages.some(message => message.content === 'stale A')).toBe(false);

    await act(async () => {
      resolveSecondStream?.();
      await secondSend!;
    });
    expect(setChanges).toHaveBeenCalledWith([
      expect.objectContaining({ replacement: 'fresh run B' }),
    ]);
    expect(setIsLoading).toHaveBeenCalledWith(false);
    expect(setEditStreaming).toHaveBeenCalledWith(false);
  });

  it('does not show Stopped when terminal done won; rehydrates durable history', async () => {
    let resolveStream: (() => void) | undefined;
    const streamGate = new Promise<void>(resolve => {
      resolveStream = resolve;
    });
    vi.mocked(consumeNdjsonStream).mockImplementation(async () => {
      await streamGate;
      return { malformedLines: 0 };
    });

    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ status: 'done', outcome: 'existing' }),
        } as Response);
      }
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          body: {},
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          messages: [
            {
              id: 'u1',
              role: 'user',
              content: 'make it warmer',
              status: 'done',
              createdAt: 1,
            },
            {
              id: 'a1',
              role: 'assistant',
              content: JSON.stringify({ summary: 'Warm rewrite', changes: [] }),
              status: 'done',
              createdAt: 2,
            },
          ],
        }),
      } as Response);
    });

    const { result } = setup({ isCurrentEditingScope: () => true });

    let sendPromise: Promise<void>;
    await act(async () => {
      sendPromise = result.current.handleSend('make it warmer');
    });

    await waitFor(() => expect(postBodies()).toHaveLength(1));

    await act(async () => {
      result.current.handleStopEdit();
    });

    await waitFor(() => {
      expect(result.current.chatMessages.map(m => m.content)).toEqual([
        'make it warmer',
        'Warm rewrite',
      ]);
    });
    expect(result.current.chatMessages.some(m => m.content === '[Stopped]')).toBe(false);

    await act(async () => {
      resolveStream?.();
      await sendPromise!;
    });
  });

  it('chapter switch abort without explicit Stop creates no stopped history marker', async () => {
    let resolveStream: (() => void) | undefined;
    const streamGate = new Promise<void>(resolve => {
      resolveStream = resolve;
    });
    vi.mocked(consumeNdjsonStream).mockImplementation(async () => {
      await streamGate;
      return { malformedLines: 0 };
    });

    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, body: {} } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ messages: [] }),
      } as Response);
    });

    const { result, rerender } = setup({ isCurrentEditingScope: () => true });

    let sendPromise: Promise<void>;
    await act(async () => {
      sendPromise = result.current.handleSend('make it warmer');
    });
    await waitFor(() => expect(postBodies()).toHaveLength(1));

    await act(async () => {
      result.current.resetForChapterSwitch();
      rerender({ chapter: chapter2, storageReady: true });
    });

    expect(patchBodies()).toHaveLength(0);
    expect(result.current.chatMessages.some(m => m.content === '[Stopped]')).toBe(false);

    await act(async () => {
      resolveStream?.();
      await sendPromise!;
    });
  });

  it('keeps chat transcript storage/chapter scoped via keyed state', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/chapters/1/edit')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            messages: [
              {
                id: 'u1',
                role: 'user',
                content: 'chapter one history',
                status: 'done',
                createdAt: 1,
              },
            ],
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          messages: [
            {
              id: 'u2',
              role: 'user',
              content: 'chapter two history',
              status: 'done',
              createdAt: 2,
            },
          ],
        }),
      } as Response);
    });

    let currentChapterId = 'ch-1';
    const { result, rerender } = setup({
      isCurrentEditingScope: scope => scope.chapterId === currentChapterId,
      chapter,
    });

    await waitFor(() => {
      expect(result.current.chatMessages.map(m => m.content)).toEqual(['chapter one history']);
    });

    await act(async () => {
      currentChapterId = 'ch-2';
      result.current.resetForChapterSwitch();
      rerender({ chapter: chapter2, storageReady: true });
    });

    await waitFor(() => {
      expect(result.current.chatMessages.map(m => m.content)).toEqual(['chapter two history']);
    });
    expect(result.current.chatMessages.some(m => m.content.includes('chapter one'))).toBe(false);
  });
});
