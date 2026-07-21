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

describe('start-writing model routing', () => {
  it('covers every writing role in the scoped model headers', () => {
    expect(WRITING_SESSION_OPERATIONS).toEqual(['outline', 'chapter', 'summarize', 'validate', 'polish']);
    expect(new Set(WRITING_SESSION_OPERATIONS.map(operation => OPERATION_ROLE[operation]))).toEqual(
      new Set(['planning', 'draft', 'recall', 'rewrite']),
    );
  });
});

function createHarness() {
  const calls: string[] = [];
  const batcher = {
    enqueue: vi.fn((chunk: string) => calls.push(`enqueue:${chunk}`)),
    flush: vi.fn(() => calls.push('flush')),
    cancel: vi.fn(() => calls.push('cancel')),
  };
  const handlers: WritingSessionHandlers = {
    setStatusLabel: vi.fn(label => calls.push(`status:${label}`)),
    patchNovel: vi.fn(patch => calls.push(`patch:${JSON.stringify(patch)}`)),
    replaceNovel: vi.fn(() => calls.push('replaceNovel')),
    appendLiveChapter: vi.fn(),
    setLiveChapter: vi.fn(chapter => calls.push(`live:${chapter?.chapterNumber ?? 'null'}`)),
    upsertChapter: vi.fn(chapter => calls.push(`chapter:${chapter.chapterNumber}`)),
    refreshChapters: vi.fn(async () => { calls.push('refreshChapters'); }),
    onDone: vi.fn(() => calls.push('done')),
    onError: vi.fn(message => calls.push(`error:${message}`)),
    updateRunState: vi.fn(),
  };
  return { calls, batcher, handlers };
}

describe('chapterFromWritingDoneEvent', () => {
  it('normalizes a chapter_done event into a local Chapter shape', () => {
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

  it('rejects malformed chapter_done payloads', () => {
    expect(chapterFromWritingDoneEvent({ chapterNumber: 1, title: 'Missing content' }, 'novel-1')).toBeNull();
  });
});

describe('applyWritingSessionEvent', () => {
  it('surfaces explicit planning phase and heartbeat activity', async () => {
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

    expect(h.handlers.setStatusLabel).toHaveBeenCalledWith('Planning chapter blueprint...');
    expect(h.handlers.updateRunState).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'planning',
      progress: 5,
      completedChapters: 0,
      totalChapters: 12,
    }));
    expect(h.handlers.updateRunState).toHaveBeenNthCalledWith(2, {
      lastActivityAt: '2026-07-21T00:00:00.000Z',
    });
  });

  it('flushes pending prose before progress and patches the novel stage', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'progress',
      progress: 42,
      message: 'Writing chapter 2',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls).toEqual([
      'flush',
      'status:Writing chapter 2',
      'patch:{"progress":42,"stage":"autonomous_writing"}',
    ]);
  });

  it('starts the live chapter and queues writing chunks without leaking parser details to the page', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'writing',
      chapterNumber: 3,
      title: 'The Door',
      chunk: 'First sentence.',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls).toEqual(['live:3', 'enqueue:First sentence.']);
  });

  it('turns chapter_done into a single upsert and clears the live chapter', async () => {
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
    ]);
  });

  it('awaits final chapter refresh before marking the writing session done', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'done',
      novel: { id: 'novel-1' },
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls).toEqual([
      'cancel',
      'live:null',
      'replaceNovel',
      'status:Reading Copy',
      'done',
      'refreshChapters',
    ]);
  });

  it('clears the unpersisted live chapter when the stream reports an error', async () => {
    const h = createHarness();

    await applyWritingSessionEvent({
      type: 'error',
      error: 'provider failed',
    }, { novelId: 'novel-1', copy, batcher: h.batcher, handlers: h.handlers });

    expect(h.calls).toEqual([
      'cancel',
      'live:null',
      'error:provider failed',
      'refreshChapters',
    ]);
  });
});

describe('startWritingSession partial chapter handling', () => {
  it('rejects a clean EOF without a terminal frame after preserving partial prose', async () => {
    const encoder = new TextEncoder();
    const partials: unknown[] = [];
    const h = createHarness();
    h.handlers.onPartialChapter = vi.fn(chapter => partials.push(chapter));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            '{"type":"writing","chapterNumber":3,"title":"Cut Short","chunk":"saved "}\n' +
            '{"type":"writing","chapterNumber":3,"title":"Cut Short","chunk":"draft"}\n',
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

    expect(partials).toEqual([
      {
        id: 'live-3',
        chapterNumber: 3,
        title: 'Cut Short',
        content: 'saved draft',
      },
    ]);
    expect(h.handlers.onDone).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('accepts a clean EOF after a batch_done terminal frame', async () => {
    const encoder = new TextEncoder();
    const h = createHarness();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            '{"type":"batch_done","nextChapter":2,"remaining":1,"completedChapters":1,"totalChapters":2}\n',
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

    expect(h.handlers.refreshChapters).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it('emits a partial live chapter when the server reports a stream error mid-chapter', async () => {
    const encoder = new TextEncoder();
    const partials: unknown[] = [];
    const h = createHarness();
    h.handlers.onPartialChapter = vi.fn(chapter => partials.push(chapter));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            '{"type":"writing","chapterNumber":4,"title":"Half","chunk":"first "}\n' +
            '{"type":"writing","chapterNumber":4,"title":"Half","chunk":"draft"}\n' +
            '{"type":"error","message":"provider failed"}\n',
          ));
          controller.close();
        },
      })),
    );

    await startWritingSession({
      novelId: 'novel-1',
      locale: 'en',
      signal: new AbortController().signal,
      copy,
      handlers: h.handlers,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(partials).toEqual([
      {
        id: 'live-4',
        chapterNumber: 4,
        title: 'Half',
        content: 'first draft',
      },
    ]);
    fetchMock.mockRestore();
  });

  it('emits a partial live chapter when the stream fails after receiving prose', async () => {
    const encoder = new TextEncoder();
    const partials: unknown[] = [];
    const h = createHarness();
    h.handlers.onPartialChapter = vi.fn(chapter => partials.push(chapter));
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

    expect(partials).toEqual([
      {
        id: 'live-5',
        chapterNumber: 5,
        title: 'Interrupted',
        content: 'opening',
      },
    ]);
    fetchMock.mockRestore();
  });
});
