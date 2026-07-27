// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '@/components/LanguageProvider';
import {
  liveChapterAfterWritingFailure,
  resolveStartWritingCreativity,
  useManuscriptSession,
} from '@/lib/use-manuscript-session';
import type {
  LiveWritingChapter,
  WritingSessionHandlers,
} from '@/lib/writing-session';

const writingSessionMock = vi.hoisted(() => ({
  startWritingSession: vi.fn(async ({ handlers }: {
    signal?: AbortSignal;
    handlers: WritingSessionHandlers;
  }) => {
    handlers.onRunEvent({
      type: 'completed',
      statusLabel: 'Complete',
      at: '2026-07-27T00:00:00.000Z',
    });
  }),
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

function midWritingNovel() {
  return {
    id: 'novel-1',
    title: 'Draft',
    genre: 'Fantasy',
    stage: 'autonomous_writing',
    progress: 42,
    blueprint: { chapters: [{ number: 1 }, { number: 2 }] },
    writingLockExpiresAt: Date.now() - 1_000,
    settings: null,
  };
}

function stubManuscriptFetch(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/chapters')) {
      return response([{ id: 'chapter-1', chapterNumber: 1 }]);
    }
    return response(midWritingNovel());
  });
}

async function flushSessionEffects() {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  writingSessionMock.startWritingSession.mockReset();
  writingSessionMock.startWritingSession.mockImplementation(async ({ handlers }: {
    handlers: WritingSessionHandlers;
  }) => {
    handlers.onRunEvent({
      type: 'completed',
      statusLabel: 'Complete',
      at: '2026-07-27T00:00:00.000Z',
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('manuscript session resume behavior', () => {
  it('auto-resumes an explicit mid-writing entry after the countdown', async () => {
    stubManuscriptFetch(fetchMock);
    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: true }),
      { wrapper },
    );

    await flushSessionEffects();
    expect(result.current.resumePromptVisible).toBe(true);
    expect(result.current.resumeCountdown).toBe(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(writingSessionMock.startWritingSession).toHaveBeenCalledTimes(1);
  });

  it('shows a manual resume action without spending tokens automatically', async () => {
    stubManuscriptFetch(fetchMock);
    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );

    await flushSessionEffects();
    expect(result.current.resumePromptVisible).toBe(true);
    expect(result.current.resumeCountdown).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(writingSessionMock.startWritingSession).not.toHaveBeenCalled();
  });

  it('consumes an explicit autostart once instead of silently retrying a failed run', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/chapters')) return response([]);
      return response({
        ...midWritingNovel(),
        stage: 'ready_for_greenlight',
        blueprint: null,
      });
    });
    writingSessionMock.startWritingSession.mockRejectedValue(
      new Error('Provider unavailable'),
    );
    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: true }),
      { wrapper },
    );

    await flushSessionEffects();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(writingSessionMock.startWritingSession).toHaveBeenCalledTimes(1);
    expect(result.current.writingRunState.phase).toBe('failed');
  });
});

describe('manuscript session transport integration', () => {
  it('keeps late prose after Pause without reviving the lifecycle', async () => {
    stubManuscriptFetch(fetchMock);
    writingSessionMock.startWritingSession.mockImplementationOnce(async (args) => {
      const { signal, handlers } = args as {
        signal?: AbortSignal;
        handlers: WritingSessionHandlers;
      };
      handlers.setLiveChapter({
        id: 'live-1',
        chapterNumber: 1,
        title: 'One',
        content: '',
      });
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          handlers.appendLiveChapter('late prose');
          handlers.onRunEvent({
            type: 'phase-received',
            phase: 'drafting',
            statusLabel: 'Late drafting',
            at: '2026-07-27T00:00:01.000Z',
          });
          reject(new DOMException('Paused', 'AbortError'));
        }, { once: true });
      });
    });
    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let startPromise: Promise<void>;
    act(() => {
      startPromise = result.current.startWriting();
    });
    await act(async () => {
      await Promise.resolve();
      result.current.pauseWriting();
      await startPromise!;
    });

    expect(result.current.liveChapter?.content).toBe('late prose');
    expect(result.current.writingRunState.phase).toBe('paused');
  });

  it('refreshes durable state when opening the writing stream fails', async () => {
    stubManuscriptFetch(fetchMock);
    writingSessionMock.startWritingSession.mockRejectedValueOnce(
      new Error('No model available for draft'),
    );
    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();
    const baselineFetches = fetchMock.mock.calls.length;

    await act(async () => {
      await result.current.startWriting();
    });

    expect(fetchMock.mock.calls.length).toBe(baselineFetches + 2);
    expect(result.current.writingRunState).toMatchObject({
      phase: 'failed',
      error: 'No model available for draft',
    });
  });

  it('keeps a terminal stream result when one post-terminal refresh fails', async () => {
    stubManuscriptFetch(fetchMock);
    writingSessionMock.startWritingSession.mockImplementationOnce(async ({ handlers }) => {
      fetchMock.mockRejectedValueOnce(new Error('chapter refresh failed'));
      await handlers.refreshChapters();
      handlers.onRunEvent({
        type: 'completed',
        statusLabel: 'Complete',
        at: '2026-07-27T00:00:01.000Z',
      });
    });
    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    await act(async () => {
      await result.current.startWriting();
    });

    expect(result.current.writingRunState.phase).toBe('complete');
  });
});

describe('manuscript session pure boundaries', () => {
  it('keeps provider-error prose but clears user-aborted prose', () => {
    const partial: LiveWritingChapter = {
      id: 'live-1',
      chapterNumber: 1,
      title: 'One',
      content: 'partial draft',
    };

    expect(liveChapterAfterWritingFailure(new Error('provider failed'), partial))
      .toEqual(partial);
    expect(liveChapterAfterWritingFailure(
      new DOMException('Paused', 'AbortError'),
      partial,
    )).toBeNull();
  });

  it('prefers the latest cached creativity selection over stale durable settings', () => {
    localStorage.setItem('creativity:novel-1', 'wild');

    expect(resolveStartWritingCreativity('novel-1', { creativity: 'conservative' }))
      .toBe('wild');
  });
});
