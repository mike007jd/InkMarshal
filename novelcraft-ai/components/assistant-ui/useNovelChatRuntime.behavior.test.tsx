// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import {
  fetchChatResponse,
  useNovelChatRuntime,
  type NovelChatRuntimeArgs,
} from '@/components/assistant-ui/useNovelChatRuntime';
import type { Message } from '@/lib/db-types';
import { classifyAIError, parseAIErrorMessage } from '@/lib/ai-error';

type Deferred = { promise: Promise<Response>; resolve: (messages: Message[]) => void };

function deferredResponse(): Deferred {
  let resolve!: (messages: Message[]) => void;
  const promise = new Promise<Response>(res => {
    resolve = (messages: Message[]) =>
      res({ ok: true, json: async () => messages } as Response);
  });
  return { promise, resolve };
}

const baseArgs = (conversationId: string): NovelChatRuntimeArgs => ({
  novelId: 'novel-1',
  conversationId,
  locale: 'en',
  streamFailedLabel: 'failed',
  loadFailedLabel: 'history failed',
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

describe('useNovelChatRuntime scope guard', () => {
  it('unwraps route JSON errors for the AI SDK transport error state', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'No model available' }),
      { status: 503, statusText: 'Service Unavailable' },
    ));

    await expect(fetchChatResponse('/api/chat')).rejects.toThrow('No model available');
  });

  it('preserves a structured route error for localized renderer presentation', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        error: 'English server fallback',
        aiError: classifyAIError({ statusCode: 401 }),
      }),
      { status: 401, statusText: 'Unauthorized' },
    ));

    const error: unknown = await fetchChatResponse('/api/chat').then(
      () => null,
      cause => cause,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected fetchChatResponse to reject');
    expect(parseAIErrorMessage(error.message)).toMatchObject({
      category: 'invalid_credentials',
      i18nKey: 'aiErrorInvalidCredentials',
      status: 401,
    });
    expect(error.message).not.toContain('English server fallback');
  });

  it('preserves plain text route errors for the AI SDK transport error state', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Gateway failed', { status: 502 }));

    await expect(fetchChatResponse('/api/chat')).rejects.toThrow('Gateway failed');
  });

  it('discards an in-flight history fetch when the chat scope changes before it resolves', async () => {
    // Scope A's mount fetch stays pending; scope B's resolves empty.
    const convA = deferredResponse();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/conversations/conv-A/')) return convA.promise;
      return Promise.resolve({ ok: true, json: async () => [] } as Response);
    });

    const { result, rerender } = renderHook((args: NovelChatRuntimeArgs) => useNovelChatRuntime(args), {
      initialProps: baseArgs('conv-A'),
    });
    await flush();

    // Switch to scope B while scope A's fetch is still pending. The scope effect
    // resets state and refetches B (which resolves []).
    rerender(baseArgs('conv-B'));
    await flush();

    // Now scope A's stale fetch resolves with a message. The guard must drop it.
    await act(async () => {
      convA.resolve([
        { id: 'stale-A', novelId: 'novel-1', role: 'user', content: 'from old scope', conversationId: 'conv-A', createdAt: 1 },
      ]);
      await convA.promise;
      await Promise.resolve();
    });

    expect(result.current.messages).toEqual([]);
    expect(result.current.messages.find(m => m.id === 'stale-A')).toBeUndefined();
  });

  it('applies a history fetch that resolves while its scope is still active', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes('/conversations/conv-A/')
          ? [{ id: 'live-A', novelId: 'novel-1', role: 'user', content: 'hi', conversationId: 'conv-A', createdAt: 1 }]
          : [],
    } as Response));

    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.messages.map(m => m.id)).toEqual(['live-A']);
  });

  it('keeps a history-load error visible and retries the history request', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{
          id: 'retried-message',
          novelId: 'novel-1',
          role: 'assistant',
          content: 'Recovered',
          conversationId: 'conv-A',
          createdAt: 1,
        }],
      } as Response);

    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errorMessage).toBe('history failed');

    await act(async () => {
      await result.current.retry();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.messages.map(message => message.id)).toEqual(['retried-message']);
  });
});
