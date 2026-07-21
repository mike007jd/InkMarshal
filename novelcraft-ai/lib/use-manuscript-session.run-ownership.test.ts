// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '@/components/LanguageProvider';
import { useManuscriptSession } from '@/lib/use-manuscript-session';
import type { WritingSessionHandlers } from '@/lib/writing-session';
import type { WritingJob } from '@/lib/db/queries-writing-jobs';

type SessionArgs = {
  signal?: AbortSignal;
  handlers: WritingSessionHandlers;
};

const writingSessionMock = vi.hoisted(() => ({
  startWritingSession: vi.fn(async (_args: SessionArgs) => {}),
}));

vi.mock('@/lib/writing-session', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/writing-session')>();
  return {
    ...actual,
    startWritingSession: writingSessionMock.startWritingSession,
  };
});

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(LanguageProvider, null, children);

const response = (body: unknown) => ({
  ok: true,
  json: async () => body,
}) as Response;

async function flushSessionEffects() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function midWritingNovel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'novel-1',
    title: 'Draft',
    genre: 'Fantasy',
    stage: 'autonomous_writing',
    progress: 42,
    blueprint: { chapters: [{ number: 1 }, { number: 2 }] },
    writingLockExpiresAt: Date.now() - 1000,
    settings: null,
    ...overrides,
  };
}

function failedJob(overrides: Partial<WritingJob> = {}): WritingJob {
  return {
    id: 'job-failed',
    novelId: 'novel-1',
    status: 'failed',
    endReason: 'error',
    currentChapter: null,
    completedInRun: 0,
    seq: 0,
    errorMessage: 'blueprint boom',
    startedAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:01:00.000Z',
    ...overrides,
  };
}

function stubManuscriptFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  novel: ReturnType<typeof midWritingNovel> = midWritingNovel(),
  chapters: unknown[] = [{ id: 'chapter-1', chapterNumber: 1 }],
) {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/chapters')) return response(chapters);
    return response(novel);
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  writingSessionMock.startWritingSession.mockReset();
  writingSessionMock.startWritingSession.mockImplementation(async () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useManuscriptSession run ownership', () => {
  it('failed → retry → done wins over late callbacks from the old failed run', async () => {
    stubManuscriptFetch(fetchMock);
    const first = deferred();
    const second = deferred();
    let firstHandlers!: WritingSessionHandlers;
    let secondHandlers!: WritingSessionHandlers;
    writingSessionMock.startWritingSession
      .mockImplementationOnce(async ({ handlers }: SessionArgs) => {
        firstHandlers = handlers;
        await first.promise;
      })
      .mockImplementationOnce(async ({ handlers }: SessionArgs) => {
        secondHandlers = handlers;
        await second.promise;
      });

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let firstStart!: Promise<void>;
    act(() => { firstStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      firstHandlers.onError('old failure');
      first.resolve();
      await firstStart;
    });
    expect(result.current.writingRunState.phase).toBe('failed');

    let secondStart!: Promise<void>;
    act(() => { secondStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      secondHandlers.onDone();
      second.resolve();
      await secondStart;
    });
    expect(result.current.writingRunState.phase).toBe('complete');

    // Late callbacks from the old run must not demote the new complete state.
    await act(async () => {
      firstHandlers.onError('stale old failure');
      firstHandlers.updateRunState?.({ phase: 'failed', error: 'stale' });
      firstHandlers.onDone();
    });
    expect(result.current.writingRunState.phase).toBe('complete');
    expect(result.current.writingRunState.error).toBeUndefined();
    expect(result.current.isStreaming).toBe(false);
  });

  it('pause then late chunk / partial flush preserves prose but keeps phase paused', async () => {
    stubManuscriptFetch(fetchMock);
    let handlers!: WritingSessionHandlers;
    writingSessionMock.startWritingSession.mockImplementationOnce(async ({ handlers: h, signal }: SessionArgs) => {
      handlers = h;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          // Mirrors startWritingSession finally: batcher flush + partial emit
          // run before the AbortError reaches the hook catch.
          handlers.appendLiveChapter(' +late');
          handlers.onPartialChapter?.({
            id: 'live-2',
            chapterNumber: 2,
            title: 'Two',
            content: 'kept +late',
          });
          handlers.updateRunState?.({ phase: 'drafting', liveWordCount: 99 });
          reject(new DOMException('paused', 'AbortError'));
        }, { once: true });
      });
    });

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let start!: Promise<void>;
    act(() => { start = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      handlers.setLiveChapter({
        id: 'live-2',
        chapterNumber: 2,
        title: 'Two',
        content: '',
      });
      handlers.appendLiveChapter('kept');
    });
    expect(result.current.writingRunState.phase).toBe('drafting');

    act(() => result.current.pauseWriting());
    await act(async () => { await start; });

    expect(result.current.writingRunState.phase).toBe('paused');
    expect(result.current.liveChapter?.content).toBe('kept +late');
    expect(result.current.isStreaming).toBe(false);
  });

  it('pause invalidates an in-flight run refresh so it cannot rewrite novel or chapters', async () => {
    const novelLoads = deferred<ReturnType<typeof midWritingNovel>>();
    const chapterLoads = deferred<unknown[]>();
    let novelServe = 0;
    let chapterServe = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/chapters')) {
        chapterServe += 1;
        if (chapterServe === 1) return response([{ id: 'chapter-1', chapterNumber: 1 }]);
        return response(await chapterLoads.promise);
      }
      novelServe += 1;
      if (novelServe === 1) return response(midWritingNovel());
      return response(await novelLoads.promise);
    });

    const session = deferred();
    let handlers!: WritingSessionHandlers;
    writingSessionMock.startWritingSession.mockImplementationOnce(async ({ handlers: h }: SessionArgs) => {
      handlers = h;
      await session.promise;
    });

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let start!: Promise<void>;
    act(() => { start = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });

    let refresh!: Promise<void>;
    act(() => {
      refresh = handlers.refreshChapters();
      result.current.pauseWriting();
    });
    await act(async () => {
      novelLoads.resolve(midWritingNovel({ title: 'STALE-PAUSED-NOVEL' }));
      chapterLoads.resolve([{ id: 'stale-ch', chapterNumber: 99, title: 'Stale' }]);
      session.resolve();
      await Promise.all([refresh, start]);
    });
    await flushSessionEffects();

    expect(result.current.writingRunState.phase).toBe('paused');
    expect(result.current.novel?.title).not.toBe('STALE-PAUSED-NOVEL');
    expect(result.current.chapters.some(c => c.chapterNumber === 99)).toBe(false);
  });

  it('pause → retry → old flush/callback is completely ignored', async () => {
    stubManuscriptFetch(fetchMock);
    let firstHandlers!: WritingSessionHandlers;
    let secondHandlers!: WritingSessionHandlers;
    const second = deferred();
    writingSessionMock.startWritingSession
      .mockImplementationOnce(async ({ handlers, signal }: SessionArgs) => {
        firstHandlers = handlers;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            handlers.appendLiveChapter(' must-not-apply-yet');
            reject(new DOMException('paused', 'AbortError'));
          }, { once: true });
        });
      })
      .mockImplementationOnce(async ({ handlers }: SessionArgs) => {
        secondHandlers = handlers;
        await second.promise;
      });

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let firstStart!: Promise<void>;
    act(() => { firstStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      firstHandlers.setLiveChapter({
        id: 'live-1',
        chapterNumber: 1,
        title: 'One',
        content: '',
      });
      firstHandlers.appendLiveChapter('old-prose');
    });

    act(() => result.current.pauseWriting());
    await act(async () => { await firstStart; });
    expect(result.current.writingRunState.phase).toBe('paused');

    let secondStart!: Promise<void>;
    act(() => { secondStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.writingRunState.phase).toBe('preparing');
    expect(result.current.liveChapter).toBeNull();

    await act(async () => {
      firstHandlers.appendLiveChapter(' must-not-apply');
      firstHandlers.updateRunState?.({ phase: 'drafting' });
      firstHandlers.onError('old error after retry');
      firstHandlers.onDone();
      firstHandlers.onBatchDone?.({
        nextChapter: 2,
        remaining: 1,
        completedChapters: 1,
        totalChapters: 2,
      });
    });

    expect(result.current.writingRunState.phase).toBe('preparing');
    expect(result.current.liveChapter).toBeNull();
    expect(result.current.batchDone).toBeNull();
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      secondHandlers.onDone();
      second.resolve();
      await secondStart;
    });
    expect(result.current.writingRunState.phase).toBe('complete');
  });

  it('batch_done → retry/new terminal wins over an old batch callback', async () => {
    stubManuscriptFetch(fetchMock);
    const first = deferred();
    const second = deferred();
    let firstHandlers!: WritingSessionHandlers;
    let secondHandlers!: WritingSessionHandlers;
    writingSessionMock.startWritingSession
      .mockImplementationOnce(async ({ handlers }: SessionArgs) => {
        firstHandlers = handlers;
        await first.promise;
      })
      .mockImplementationOnce(async ({ handlers }: SessionArgs) => {
        secondHandlers = handlers;
        await second.promise;
      });

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let firstStart!: Promise<void>;
    act(() => { firstStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      firstHandlers.onBatchDone?.({
        nextChapter: 2,
        remaining: 1,
        completedChapters: 1,
        totalChapters: 2,
      });
      first.resolve();
      await firstStart;
    });
    expect(result.current.writingRunState.phase).toBe('paused');
    expect(result.current.batchDone?.remaining).toBe(1);

    let secondStart!: Promise<void>;
    act(() => { secondStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      secondHandlers.onDone();
      second.resolve();
      await secondStart;
    });
    expect(result.current.writingRunState.phase).toBe('complete');

    await act(async () => {
      firstHandlers.onBatchDone?.({
        nextChapter: 3,
        remaining: 9,
        completedChapters: 2,
        totalChapters: 10,
      });
      firstHandlers.updateRunState?.({ phase: 'paused', completedChapters: 99 });
    });
    expect(result.current.writingRunState.phase).toBe('complete');
    expect(result.current.writingRunState.completedChapters).not.toBe(99);
  });

  it('done then a deferred old refresh fetch is ignored after a newer run begins', async () => {
    const novelLoads = deferred<ReturnType<typeof midWritingNovel>>();
    const chapterLoads = deferred<unknown[]>();
    let novelServe = 0;
    let chapterServe = 0;

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/chapters')) {
        chapterServe += 1;
        if (chapterServe === 1) return response([{ id: 'chapter-1', chapterNumber: 1 }]);
        const data = await chapterLoads.promise;
        return response(data);
      }
      novelServe += 1;
      if (novelServe === 1) return response(midWritingNovel());
      const data = await novelLoads.promise;
      return response(data);
    });

    let firstHandlers!: WritingSessionHandlers;
    let secondHandlers!: WritingSessionHandlers;
    const first = deferred();
    const second = deferred();
    writingSessionMock.startWritingSession
      .mockImplementationOnce(async ({ handlers }: SessionArgs) => {
        firstHandlers = handlers;
        await first.promise;
      })
      .mockImplementationOnce(async ({ handlers }: SessionArgs) => {
        secondHandlers = handlers;
        await second.promise;
      });

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let firstStart!: Promise<void>;
    act(() => { firstStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });

    let refreshPromise!: Promise<void>;
    await act(async () => {
      firstHandlers.onDone();
      refreshPromise = firstHandlers.refreshChapters();
      first.resolve();
      await firstStart;
    });
    expect(result.current.writingRunState.phase).toBe('complete');

    let secondStart!: Promise<void>;
    act(() => { secondStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.writingRunState.phase).toBe('preparing');

    await act(async () => {
      secondHandlers.onDone();
      second.resolve();
      await secondStart;
    });
    expect(result.current.writingRunState.phase).toBe('complete');

    await act(async () => {
      novelLoads.resolve(midWritingNovel({
        stage: 'autonomous_writing',
        progress: 5,
        title: 'STALE-SHOULD-NOT-COMMIT',
        writingJob: failedJob({ id: 'stale-failed' }),
      }));
      chapterLoads.resolve([{ id: 'stale-ch', chapterNumber: 99, title: 'Stale' }]);
      await refreshPromise;
      await Promise.resolve();
    });
    await flushSessionEffects();

    expect(result.current.novel?.title).not.toBe('STALE-SHOULD-NOT-COMMIT');
    expect(result.current.chapters.some(c => c.chapterNumber === 99)).toBe(false);
    expect(result.current.writingRunState.phase).toBe('complete');
  });

  it('active non-pause AbortError ends in failed terminal and exposes Retry', async () => {
    stubManuscriptFetch(fetchMock);
    writingSessionMock.startWritingSession.mockImplementationOnce(async () => {
      throw new DOMException('The writing session was aborted.', 'AbortError');
    });

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    await act(async () => {
      await result.current.startWriting();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.didRequestAutostart).toBe(false);
    expect(result.current.writingRunState.phase).toBe('failed');
    expect(result.current.writingRunState.error).toBeTruthy();
    expect(['preparing', 'drafting', 'planning']).not.toContain(result.current.writingRunState.phase);
  });

  it('reload reconstructs failed + Retry from autonomous_writing + current failed job', async () => {
    stubManuscriptFetch(
      fetchMock,
      midWritingNovel({
        stage: 'autonomous_writing',
        progress: 5,
        writingJob: failedJob(),
        writingLockExpiresAt: Date.now() + 60_000,
      }),
      [],
    );

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    expect(result.current.writingRunState.phase).toBe('failed');
    expect(result.current.writingRunState.error).toBe('blueprint boom');
    expect(result.current.isStreaming).toBe(false);
  });

  it('does not let a stale failed job overwrite a completed novel after reload', async () => {
    stubManuscriptFetch(
      fetchMock,
      midWritingNovel({
        stage: 'completed',
        progress: 100,
        writingJob: failedJob({ id: 'old-failed', updatedAt: '2026-07-20T00:00:00.000Z' }),
      }),
      [{ id: 'chapter-1', chapterNumber: 1 }, { id: 'chapter-2', chapterNumber: 2 }],
    );

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    expect(result.current.writingRunState.phase).toBe('complete');
    expect(result.current.writingRunState.error).toBeUndefined();
  });

  it('uses novel/job time ordering so an older failed job cannot overwrite newer autonomous progress', async () => {
    stubManuscriptFetch(
      fetchMock,
      midWritingNovel({
        stage: 'autonomous_writing',
        progress: 67,
        updatedAt: Date.parse('2026-07-21T00:05:00.000Z'),
        writingJob: failedJob({ id: 'old-failed', updatedAt: '2026-07-21T00:01:00.000Z' }),
      }),
      [{ id: 'chapter-1', chapterNumber: 1 }, { id: 'chapter-2', chapterNumber: 2 }],
    );

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    expect(result.current.writingRunState.phase).toBe('paused');
    expect(result.current.writingRunState.progress).toBe(67);
    expect(result.current.writingRunState.error).toBeUndefined();
  });
});
