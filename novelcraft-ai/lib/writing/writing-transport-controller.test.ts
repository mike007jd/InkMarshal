import { describe, expect, it, vi } from 'vitest';

import type { WritingSessionHandlers } from '@/lib/writing-session';
import { WritingTransportController } from '@/lib/writing/writing-transport-controller';
import type { WritingRunEvent } from '@/lib/writing/writing-run-reducer';

const START = {
  novelId: 'novel-1',
  locale: 'en',
  copy: {
    writingLabel: 'Writing',
    readingLabel: 'Reading',
    errorLabel: 'Failed',
    timeoutLabel: 'Timed out',
  },
  initialState: {
    statusLabel: 'Writing',
    progress: 5,
    completedChapters: 0,
    totalChapters: 2,
  },
};

function callbacks() {
  const events: WritingRunEvent[] = [];
  let prose = '';
  return {
    events,
    prose: () => prose,
    callbacks: {
      onRunEvent: (event: WritingRunEvent) => events.push(event),
      patchNovel: vi.fn(),
      replaceNovel: vi.fn(),
      appendLiveChapter: (chunk: string) => {
        prose += chunk;
      },
      setLiveChapter: vi.fn(),
      upsertChapter: vi.fn(),
      refreshDurableState: vi.fn(async () => {}),
    },
  };
}

describe('WritingTransportController', () => {
  it('keeps a paused run late flush as prose only', async () => {
    const runSession = vi.fn(async ({ signal, handlers }: {
      signal: AbortSignal;
      handlers: WritingSessionHandlers;
    }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          handlers.setLiveChapter({
            id: 'live-1',
            chapterNumber: 1,
            title: 'One',
            content: '',
          });
          handlers.appendLiveChapter('late prose');
          handlers.onRunEvent({
            type: 'phase-received',
            phase: 'drafting',
            statusLabel: 'Late drafting',
            at: '2026-07-27T00:00:00.000Z',
          });
          reject(new DOMException('Paused', 'AbortError'));
        }, { once: true });
      });
    });
    const transport = new WritingTransportController(runSession as never);
    const state = callbacks();

    const pending = transport.start(START, state.callbacks);
    expect(transport.pause('Paused')).toBe(true);
    const outcome = await pending;

    expect(outcome).toMatchObject({
      kind: 'paused',
      isLatestRun: true,
      partial: { content: 'late prose' },
    });
    expect(state.prose()).toBe('late prose');
    expect(state.events.map(event => event.type)).toEqual(['run-started', 'paused']);
  });

  it('ignores every old callback after a newer run starts', async () => {
    const sessions: Array<{
      handlers: WritingSessionHandlers;
      resolve: () => void;
    }> = [];
    const runSession = vi.fn(({ handlers }: { handlers: WritingSessionHandlers }) =>
      new Promise<void>(resolve => {
        sessions.push({ handlers, resolve });
      }));
    const transport = new WritingTransportController(runSession as never);
    const state = callbacks();

    const first = transport.start(START, state.callbacks);
    transport.pause('Paused');
    const second = transport.start(START, state.callbacks);
    sessions[0].handlers.setLiveChapter({
      id: 'old',
      chapterNumber: 1,
      title: 'Old',
      content: '',
    });
    sessions[0].handlers.appendLiveChapter('obsolete');
    sessions[0].handlers.onRunEvent({
      type: 'failed',
      statusLabel: 'Old failure',
      error: 'Old failure',
      at: '2026-07-27T00:00:00.000Z',
    });
    sessions[0].resolve();
    sessions[1].handlers.onRunEvent({
      type: 'completed',
      statusLabel: 'Complete',
      at: '2026-07-27T00:01:00.000Z',
    });
    sessions[1].resolve();

    await Promise.all([first, second]);
    expect(state.prose()).toBe('');
    expect(state.events.some(
      event => event.type === 'failed' && event.statusLabel === 'Old failure',
    )).toBe(false);
    expect(state.events.at(-1)).toMatchObject({ type: 'completed', runId: 2 });
  });

  it('returns partial prose with an active transport failure', async () => {
    const runSession = vi.fn(async ({ handlers }: { handlers: WritingSessionHandlers }) => {
      handlers.setLiveChapter({
        id: 'live-1',
        chapterNumber: 1,
        title: 'One',
        content: '',
      });
      handlers.appendLiveChapter('recoverable prose');
      throw new Error('Provider offline');
    });
    const transport = new WritingTransportController(runSession as never);
    const state = callbacks();

    const outcome = await transport.start(START, state.callbacks);

    expect(outcome).toMatchObject({
      kind: 'failed',
      error: new Error('Provider offline'),
      partial: { content: 'recoverable prose' },
    });
  });

  it('cancels scope-owned work without exposing a failed lifecycle', async () => {
    const runSession = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Cancelled', 'AbortError')),
          { once: true },
        );
      });
    });
    const transport = new WritingTransportController(runSession as never);
    const state = callbacks();

    const pending = transport.start(START, state.callbacks);
    transport.cancel();

    await expect(pending).resolves.toMatchObject({ kind: 'cancelled' });
    expect(state.events.map(event => event.type)).toEqual(['run-started']);
  });
});
