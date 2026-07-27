import { describe, expect, it, vi } from 'vitest';

import {
  applyWritingSessionEvent,
  chapterFromWritingDoneEvent,
  startWritingSession,
  WRITING_SESSION_OPERATIONS,
  type WritingSessionCopy,
  type WritingSessionHandlers,
} from '@/lib/writing-session';
import { OPERATION_ROLE } from '@/lib/model-supply/types';

vi.mock('@/lib/ai-action-gate', () => ({
  awaitAIActionReady: vi.fn(async () => undefined),
}));

const copy: WritingSessionCopy = {
  writingLabel: 'Writing Live',
  readingLabel: 'Reading Copy',
  errorLabel: 'Writing failed',
  timeoutLabel: 'Timed out',
};

function createHarness() {
  const calls: string[] = [];
  const batcher = {
    enqueue: vi.fn((chunk: string) => calls.push(`enqueue:${chunk}`)),
    flush: vi.fn(() => calls.push('flush')),
    cancel: vi.fn(() => calls.push('cancel')),
  };
  const handlers: WritingSessionHandlers = {
    patchNovel: vi.fn(patch => calls.push(`patch:${JSON.stringify(patch)}`)),
    replaceNovel: vi.fn(() => calls.push('replaceNovel')),
    appendLiveChapter: vi.fn(chunk => calls.push(`append:${chunk}`)),
    setLiveChapter: vi.fn(chapter => calls.push(`live:${chapter?.chapterNumber ?? 'null'}`)),
    upsertChapter: vi.fn(chapter => calls.push(`chapter:${chapter.chapterNumber}`)),
    refreshChapters: vi.fn(async () => { calls.push('refreshChapters'); }),
    onRunEvent: vi.fn(event => calls.push(`event:${event.type}`)),
  };
  return { calls, batcher, handlers };
}

describe('start-writing model routing', () => {
  it('covers every writing role in the scoped model headers', () => {
    expect(WRITING_SESSION_OPERATIONS).toEqual([
      'outline',
      'chapter',
      'summarize',
      'validate',
      'polish',
    ]);
    expect(new Set(WRITING_SESSION_OPERATIONS.map(
      operation => OPERATION_ROLE[operation],
    ))).toEqual(new Set(['planning', 'draft', 'recall', 'rewrite']));
  });
});

describe('chapterFromWritingDoneEvent', () => {
  it('normalizes a persisted chapter event into the local Chapter shape', () => {
    const chapter = chapterFromWritingDoneEvent({
      type: 'chapter_done',
      id: 'server-ch-1',
      chapterNumber: 1,
      title: 'Opening',
      content: 'Once upon a time',
      wordCount: 4,
      qualityIssues: [{ type: 'length', description: 'short', severity: 'minor' }],
    }, 'novel-1');

    expect(chapter).toMatchObject({
      id: 'server-ch-1',
      novelId: 'novel-1',
      chapterNumber: 1,
      title: 'Opening',
      content: 'Once upon a time',
      wordCount: 4,
      originalContent: null,
      summary: '',
      keyFacts: null,
      generationMeta: null,
    });
    expect(chapter?.qualityIssues).toHaveLength(1);
  });

  it('rejects malformed persisted chapter events', () => {
    expect(chapterFromWritingDoneEvent(
      { chapterNumber: 1, title: 'Missing content' },
      'novel-1',
    )).toBeNull();
  });
});

describe('applyWritingSessionEvent', () => {
  it('emits explicit planning and heartbeat facts', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'phase',
      phase: 'planning',
      progress: 5,
      completedChapters: 0,
      totalChapters: 12,
      message: 'Planning chapter blueprint...',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });
    await applyWritingSessionEvent({
      type: 'heartbeat',
      at: '2026-07-21T00:00:00.000Z',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.handlers.onRunEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'phase-received',
      phase: 'planning',
      progress: 5,
      completedChapters: 0,
      totalChapters: 12,
    }));
    expect(h.handlers.onRunEvent).toHaveBeenNthCalledWith(2, {
      type: 'activity-received',
      at: '2026-07-21T00:00:00.000Z',
    });
  });

  it('flushes prose before publishing durable progress', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'progress',
      progress: 42,
      message: 'Writing chapter 2',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls.slice(0, 2)).toEqual([
      'flush',
      'patch:{"progress":42,"stage":"autonomous_writing"}',
    ]);
    expect(h.handlers.onRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'progress-received',
      progress: 42,
    }));
  });

  it('starts a live chapter and queues its prose', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'writing',
      chapterNumber: 3,
      title: 'The Door',
      chunk: 'First sentence.',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls).toEqual([
      'live:3',
      'event:chapter-started',
      'enqueue:First sentence.',
    ]);
  });

  it('turns chapter_done into one upsert and one lifecycle event', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'chapter_done',
      chapterNumber: 2,
      title: 'Second',
      content: 'Finished prose',
      progress: 55,
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls).toEqual([
      'cancel',
      'patch:{"progress":55,"stage":"autonomous_writing"}',
      'live:null',
      'chapter:2',
      'event:chapter-completed',
    ]);
  });

  it('publishes terminal completion before awaiting the durable refresh', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'done',
      novel: { id: 'novel-1' },
      message: 'Complete',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls).toEqual([
      'cancel',
      'live:null',
      'replaceNovel',
      'event:completed',
      'refreshChapters',
    ]);
  });

  it('preserves partial prose when the stream reports an error', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'error',
      error: 'provider failed',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls).toEqual([
      'cancel',
      'event:failed',
      'refreshChapters',
    ]);
  });
});

describe('startWritingSession terminal protocol', () => {
  it('rejects EOF without a terminal frame after flushing received prose', async () => {
    const encoder = new TextEncoder();
    const h = createHarness();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            '{"type":"writing","chapterNumber":3,"title":"Cut Short","chunk":"saved "}\n'
            + '{"type":"writing","chapterNumber":3,"title":"Cut Short","chunk":"draft"}\n',
          ));
          controller.close();
        },
      })),
    );

    await expect(startWritingSession({
      novelId: 'novel-1',
      locale: 'en',
      signal: new AbortController().signal,
      copy,
      handlers: h.handlers,
    })).rejects.toThrow('before the server confirmed completion');

    expect(vi.mocked(h.handlers.appendLiveChapter).mock.calls.flat().join(''))
      .toBe('saved draft');
    expect(h.handlers.onRunEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'completed' }),
    );
    fetchMock.mockRestore();
  });

  it('accepts EOF after a batch terminal frame', async () => {
    const encoder = new TextEncoder();
    const h = createHarness();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            '{"type":"batch_done","nextChapter":2,"remaining":1,'
            + '"completedChapters":1,"totalChapters":2}\n',
          ));
          controller.close();
        },
      })),
    );

    await expect(startWritingSession({
      novelId: 'novel-1',
      locale: 'en',
      signal: new AbortController().signal,
      copy,
      handlers: h.handlers,
    })).resolves.toBeUndefined();

    expect(h.handlers.onRunEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'batch-completed',
      remaining: 1,
    }));
    expect(h.handlers.refreshChapters).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it('keeps received prose available to the transport owner when the stream fails', async () => {
    const encoder = new TextEncoder();
    const h = createHarness();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            '{"type":"writing","chapterNumber":5,"title":"Interrupted","chunk":"opening"}\n',
          ));
          setTimeout(() => controller.error(new Error('socket closed')), 0);
        },
      })),
    );

    await expect(startWritingSession({
      novelId: 'novel-1',
      locale: 'en',
      signal: new AbortController().signal,
      copy,
      handlers: h.handlers,
    })).rejects.toThrow('socket closed');

    expect(h.handlers.appendLiveChapter).toHaveBeenCalledWith('opening');
    fetchMock.mockRestore();
  });
});
