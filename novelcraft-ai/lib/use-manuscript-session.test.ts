// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '@/components/LanguageProvider';
import {
  claimWritingStart,
  liveChapterAfterWritingFailure,
  releaseWritingStart,
  resolveStartWritingCreativity,
  useManuscriptSession,
} from '@/lib/use-manuscript-session';
import type { LiveWritingChapter } from '@/lib/writing-session';

const writingSessionMock = vi.hoisted(() => ({
  startWritingSession: vi.fn(async ({ handlers }: {
    signal?: AbortSignal;
    handlers?: {
      onDone?: () => void;
      setLiveChapter?: (chapter: LiveWritingChapter | null) => void;
      onPartialChapter?: (chapter: LiveWritingChapter) => void;
    };
  }) => {
    handlers?.onDone?.();
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

async function flushSessionEffects() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function midWritingNovel() {
  return {
    id: 'novel-1',
    title: 'Draft',
    genre: 'Fantasy',
    stage: 'autonomous_writing',
    progress: 42,
    blueprint: { chapters: [{ number: 1 }, { number: 2 }] },
    writingLockExpiresAt: Date.now() - 1000,
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  writingSessionMock.startWritingSession.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('manuscript session mid-writing resume', () => {
  it('auto-resumes a mid-writing autostart entry after the countdown', async () => {
    stubManuscriptFetch(fetchMock);

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: true }),
      { wrapper },
    );

    await flushSessionEffects();
    expect(result.current.resumePromptVisible).toBe(true);
    expect(result.current.didRequestAutostart).toBe(false);
    expect(result.current.resumeCountdown).toBe(5);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(writingSessionMock.startWritingSession).toHaveBeenCalledTimes(1);
  });

  it('shows a manual resume prompt without auto-starting when autostart is absent', async () => {
    stubManuscriptFetch(fetchMock);

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );

    await flushSessionEffects();
    expect(result.current.resumePromptVisible).toBe(true);
    expect(result.current.resumeCountdown).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(writingSessionMock.startWritingSession).not.toHaveBeenCalled();
  });
});

describe('manuscript session write-start guard', () => {
  it('claims exactly one start-writing request until released', () => {
    const flag = { current: false };

    expect(claimWritingStart(flag)).toBe(true);
    expect(flag.current).toBe(true);
    expect(claimWritingStart(flag)).toBe(false);

    releaseWritingStart(flag);
    expect(flag.current).toBe(false);
    expect(claimWritingStart(flag)).toBe(true);
  });

  it('keeps provider-error partial chapters but clears user-aborted partials', () => {
    const partial: LiveWritingChapter = {
      id: 'live-1',
      chapterNumber: 1,
      title: 'One',
      content: 'partial draft',
    };

    expect(liveChapterAfterWritingFailure(new Error('provider failed'), partial)).toBe(partial);
    expect(liveChapterAfterWritingFailure(new DOMException('aborted', 'AbortError'), partial)).toBeNull();
    expect(liveChapterAfterWritingFailure(new Error('provider failed'), null)).toBeNull();
  });

  it('starts writing with the latest locally selected creativity before DB refresh catches up', () => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
      },
    });
    window.localStorage.setItem('creativity:novel-1', 'wild');

    expect(resolveStartWritingCreativity('novel-1', { creativity: 'conservative' })).toBe('wild');
    expect(resolveStartWritingCreativity('novel-2', { creativity: 'balanced' })).toBe('balanced');
    expect(resolveStartWritingCreativity('novel-3', null)).toBeNull();
  });

  it('refreshes the novel and chapters after start-writing fails before a stream opens', async () => {
    stubManuscriptFetch(fetchMock);
    writingSessionMock.startWritingSession.mockRejectedValueOnce(new Error('No model available for draft'));

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );

    await flushSessionEffects();
    const fetchCallsBeforeStart = fetchMock.mock.calls.length;

    await act(async () => {
      await result.current.startWriting();
    });

    const refreshedUrls = fetchMock.mock.calls
      .slice(fetchCallsBeforeStart)
      .map(call => String(call[0]));

    expect(refreshedUrls).toContain('/api/novels/novel-1');
    expect(refreshedUrls).toContain('/api/novels/novel-1/chapters');
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.didRequestAutostart).toBe(false);
  });

  it('keeps the streamed partial chapter visible when the writer pauses', async () => {
    stubManuscriptFetch(fetchMock);
    const partial: LiveWritingChapter = {
      id: 'live-paused',
      chapterNumber: 2,
      title: 'Two',
      content: 'A partial chapter worth keeping.',
    };
    writingSessionMock.startWritingSession.mockImplementationOnce(({ handlers, signal }) =>
      new Promise<void>((_resolve, reject) => {
        handlers?.setLiveChapter?.({ ...partial, content: '' });
        signal?.addEventListener('abort', () => {
          handlers?.onPartialChapter?.(partial);
          reject(new DOMException('paused', 'AbortError'));
        }, { once: true });
      }),
    );

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let start!: Promise<void>;
    act(() => { start = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.pauseWriting());
    await act(async () => { await start; });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.liveChapter).toEqual(partial);
  });

  it('does not let an old paused run release the guard owned by a restarted run', async () => {
    stubManuscriptFetch(fetchMock);
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstRun = new Promise<void>(resolve => { resolveFirst = resolve; });
    const secondRun = new Promise<void>(resolve => { resolveSecond = resolve; });
    writingSessionMock.startWritingSession
      .mockImplementationOnce(() => firstRun)
      .mockImplementationOnce(() => secondRun);

    const { result } = renderHook(
      () => useManuscriptSession({ novelId: 'novel-1', autostart: false }),
      { wrapper },
    );
    await flushSessionEffects();

    let firstStart!: Promise<void>;
    act(() => { firstStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.pauseWriting());

    let secondStart!: Promise<void>;
    act(() => { secondStart = result.current.startWriting(); });
    await act(async () => { await Promise.resolve(); });
    expect(writingSessionMock.startWritingSession).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirst();
      await firstStart;
    });
    await act(async () => {
      await result.current.startWriting();
    });
    expect(writingSessionMock.startWritingSession).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond();
      await secondStart;
    });
  });
});
