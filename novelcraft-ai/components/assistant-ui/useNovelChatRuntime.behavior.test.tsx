// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import {
  fetchChatResponse,
  isPersistedStoppedAssistant,
  isPersistedStoryDeckRepairPrompt,
  stoppedContinuationPrompt,
  stoppedPersistenceLabel,
  useNovelChatRuntime,
  type NovelChatRuntimeArgs,
} from '@/components/assistant-ui/useNovelChatRuntime';
import type { Message } from '@/lib/db-types';
import { classifyAIError, parseAIErrorMessage } from '@/lib/ai-error';

vi.mock('@/lib/streaming-client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/streaming-client')>();
  return {
    ...actual,
    buildAIRequestHeaders: vi.fn(async () => ({})),
  };
});

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
  it('recognizes only the durable stopped assistant suffix', () => {
    const persistedStop = stoppedPersistenceLabel('en');
    const message: Message = {
      id: 'assistant-stopped',
      novelId: 'novel-1',
      conversationId: 'conv-A',
      role: 'assistant',
      content: `partial reply\n\n${persistedStop}`,
      createdAt: 1,
    };
    expect(isPersistedStoppedAssistant(message)).toBe(true);
    expect(isPersistedStoppedAssistant({ ...message, content: 'The train stopped.' })).toBe(false);
    // Detection is locale-independent; only the stable hidden marker matters.
    expect(isPersistedStoppedAssistant({
      ...message,
      content: `partial reply\n\n${stoppedPersistenceLabel('zh-CN')}`,
    })).toBe(true);
    expect(isPersistedStoppedAssistant({
      ...message,
      content: 'Legacy partial\n\n[Stopped]',
    }, { allowLegacySuffix: true })).toBe(true);
    expect(isPersistedStoppedAssistant({
      ...message,
      content: 'A legacy conversation partial with no suffix',
    }, { turnStatus: 'cancelled' })).toBe(true);
    expect(isPersistedStoppedAssistant({
      ...message,
      content: 'A complete response',
    }, { turnStatus: 'succeeded' })).toBe(false);
  });

  it('recognizes persisted localized Story Deck repair prompts exactly', () => {
    expect(isPersistedStoryDeckRepairPrompt(
      'Complete the Story Deck now from the already approved plan. Create at least one character card, one world card, and one outline card, then finalize the brainstorm. Do not write story prose.',
    )).toBe(true);
    expect(isPersistedStoryDeckRepairPrompt(
      '请根据已经批准的方案立即补齐故事卡组：至少创建一张角色卡、一张世界卡和一张大纲卡，然后完成构思。不要开始写故事正文。',
    )).toBe(true);
    expect(isPersistedStoryDeckRepairPrompt('Repair the deck')).toBe(false);
  });

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

  it('does not restart recovery polling when a running-history fetch resolves after unmount', async () => {
    vi.useFakeTimers();
    let resolveHistory!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>(resolve => {
      resolveHistory = resolve;
    }));

    try {
      const { unmount } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
      await flush();
      expect(fetchMock).toHaveBeenCalledOnce();
      unmount();

      await act(async () => {
        resolveHistory(new Response(JSON.stringify([{
          id: 'late-running-user',
          novelId: 'novel-1',
          conversationId: 'conv-A',
          role: 'user',
          content: 'Still running',
          createdAt: 1,
        }]), {
          headers: {
            'Content-Type': 'application/json',
            'X-InkMarshal-Chat-Turn-Status': 'running',
          },
        }));
        await Promise.resolve();
        await Promise.resolve();
        vi.advanceTimersByTime(1_500);
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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

describe('useNovelChatRuntime repair-aware retry', () => {
  let chatPosts: Array<{ body: Record<string, unknown> }>;

  function mockChatTurnFailure(kind: 'network-preflight' | 'server') {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat')) {
        chatPosts.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        if (kind === 'network-preflight') {
          return Promise.reject(new TypeError('fetch failed'));
        }
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'server exploded' }),
          { status: 500, statusText: 'Internal Server Error' },
        ));
      }
      return Promise.resolve({ ok: true, json: async () => [] } as Response);
    });
  }

  beforeEach(() => {
    chatPosts = [];
  });

  it('retries with repairStoryDeck true after a persisted server-side turn failure', async () => {
    mockChatTurnFailure('server');
    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sendMessage('Repair the deck', { repairStoryDeck: true });
    });
    expect(result.current.errorMessage).toBeTruthy();
    expect(result.current.retryKind).toBe('repair');
    expect(chatPosts).toHaveLength(1);
    expect(chatPosts[0].body.repairStoryDeck).toBe(true);

    await act(async () => {
      await result.current.retry();
    });
    expect(chatPosts).toHaveLength(2);
    expect(chatPosts[1].body.trigger).toBe('regenerate-message');
    expect(chatPosts[1].body.repairStoryDeck).toBe(true);
  });

  it('retries with repairStoryDeck true after a network-preflight failure', async () => {
    mockChatTurnFailure('network-preflight');
    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sendMessage('Repair the deck', { repairStoryDeck: true });
    });
    expect(result.current.errorMessage).toBeTruthy();
    expect(result.current.retryKind).toBe('repair');
    expect(chatPosts).toHaveLength(1);

    await act(async () => {
      await result.current.retry();
    });
    expect(chatPosts).toHaveLength(2);
    expect(chatPosts[1].body.repairStoryDeck).toBe(true);
  });

  it('converges a disconnected repair to durable success before settling its lifecycle', async () => {
    let durableState: 'empty' | 'claimed' | 'succeeded' = 'empty';
    let submittedId = '';
    const onTurnComplete = vi.fn();
    const onTurnFinish = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat')) {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ id: string; role: string; parts: Array<{ text?: string }> }>;
        };
        submittedId = body.messages.at(-1)?.id ?? '';
        durableState = 'claimed';
        return Promise.reject(new TypeError('network disconnected'));
      }
      if (durableState === 'empty') {
        return Promise.resolve(new Response(JSON.stringify([]), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      const user: Message = {
        id: submittedId,
        novelId: 'novel-1',
        conversationId: 'conv-A',
        role: 'user',
        content: 'Repair the deck',
        createdAt: 1,
      };
      const history = durableState === 'succeeded'
        ? [user, {
            id: 'durable-assistant',
            novelId: 'novel-1',
            conversationId: 'conv-A',
            role: 'assistant' as const,
            content: 'Durable repair complete',
            createdAt: 2,
          }]
        : [];
      return Promise.resolve(new Response(JSON.stringify(history), {
        headers: {
          'Content-Type': 'application/json',
          'X-InkMarshal-Chat-Turn-Status': durableState === 'claimed' ? 'running' : durableState,
        },
      }));
    });

    const { result } = renderHook(() => useNovelChatRuntime({
      ...baseArgs('conv-A'),
      onTurnComplete,
      onTurnFinish,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sendMessage('Repair the deck', { repairStoryDeck: true });
    });
    await waitFor(() => expect(result.current.recovering).toBe(true));
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('pendingTurnId=');
    expect(onTurnFinish).not.toHaveBeenCalled();

    durableState = 'succeeded';
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.recovering).toBe(false);
    expect(result.current.errorMessage).toBeNull();
    expect(onTurnFinish).toHaveBeenCalledOnce();
    expect(onTurnFinish).toHaveBeenCalledWith('succeeded');
    expect(onTurnComplete).toHaveBeenCalledOnce();
  });

  it('keeps an exact pending recovery alive across locale and copy changes', async () => {
    let submittedId = '';
    let succeeded = false;
    const onTurnFinish = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat')) {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ id: string }>;
        };
        submittedId = body.messages.at(-1)?.id ?? '';
        return Promise.reject(new TypeError('network disconnected'));
      }
      const history: Message[] = succeeded ? [{
        id: submittedId,
        novelId: 'novel-1',
        conversationId: 'conv-A',
        role: 'user',
        content: 'Repair the deck',
        createdAt: 1,
      }, {
        id: 'locale-success-assistant',
        novelId: 'novel-1',
        conversationId: 'conv-A',
        role: 'assistant',
        content: 'Repair complete',
        createdAt: 2,
      }] : [];
      return Promise.resolve(new Response(JSON.stringify(history), {
        headers: {
          'Content-Type': 'application/json',
          'X-InkMarshal-Chat-Turn-Status': succeeded ? 'succeeded' : 'running',
        },
      }));
    });

    const initial = { ...baseArgs('conv-A'), onTurnFinish };
    const { result, rerender } = renderHook(
      (props: NovelChatRuntimeArgs) => useNovelChatRuntime(props),
      { initialProps: initial },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.sendMessage('Repair the deck', { repairStoryDeck: true });
    });
    await waitFor(() => expect(result.current.recovering).toBe(true));

    rerender({
      ...initial,
      locale: 'zh-CN',
      streamFailedLabel: '发送失败',
      loadFailedLabel: '加载失败',
    });
    await flush();
    expect(result.current.recovering).toBe(true);
    expect(onTurnFinish).not.toHaveBeenCalled();

    succeeded = true;
    await act(async () => {
      await result.current.refresh();
    });
    expect(onTurnFinish).toHaveBeenCalledWith('succeeded');
  });

  it('preserves a preflight repair across a transient recovery-history failure', async () => {
    let historyReads = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat')) {
        chatPosts.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Promise.reject(new TypeError('network preflight disconnected'));
      }
      historyReads += 1;
      if (historyReads === 2) return Promise.reject(new TypeError('history temporarily offline'));
      return Promise.resolve(new Response(JSON.stringify([]), {
        headers: {
          'Content-Type': 'application/json',
          ...(historyReads > 1 ? { 'X-InkMarshal-Chat-Turn-Status': 'missing' } : {}),
        },
      }));
    });

    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.sendMessage('Repair the deck', { repairStoryDeck: true });
    });
    await waitFor(() => expect(result.current.retryKind).toBe('history'));
    expect(result.current.recovering).toBe(true);
    expect(result.current.status).toBe('submitted');
    await expect(result.current.sendMessage('Must remain blocked')).rejects.toThrow(
      'still recovering',
    );

    await act(async () => {
      await result.current.retry();
    });
    expect(result.current.retryKind).toBe('repair');

    await act(async () => {
      await result.current.retry();
    });
    expect(chatPosts).toHaveLength(2);
    expect(chatPosts[1].body.repairStoryDeck).toBe(true);
    const postedMessages = chatPosts[1].body.messages as Array<{
      role: string;
      parts: Array<{ text?: string }>;
    }>;
    expect(postedMessages.at(-1)?.parts[0]?.text).toBe('Repair the deck');
  });

  it('keeps an ordinary chat Retry free of the repair body', async () => {
    mockChatTurnFailure('server');
    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sendMessage('Just chatting');
    });
    expect(result.current.errorMessage).toBeTruthy();
    expect(result.current.retryKind).toBe('ordinary');

    await act(async () => {
      await result.current.retry();
    });
    expect(chatPosts).toHaveLength(2);
    expect(chatPosts[1].body.trigger).toBe('regenerate-message');
    expect(chatPosts[1].body.repairStoryDeck).toBeUndefined();
  });

  it('does not leak the repair body into the retry of a later ordinary turn', async () => {
    mockChatTurnFailure('server');
    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.sendMessage('Repair the deck', { repairStoryDeck: true });
    });
    await act(async () => {
      await result.current.sendMessage('An ordinary follow-up');
    });
    expect(chatPosts).toHaveLength(2);

    await act(async () => {
      await result.current.retry();
    });
    expect(chatPosts).toHaveLength(3);
    expect(chatPosts[2].body.repairStoryDeck).toBeUndefined();
  });

  it('rehydrates the repair mode for a persisted localized repair user turn', async () => {
    const repairPrompt = 'Complete the Story Deck now from the already approved plan. Create at least one character card, one world card, and one outline card, then finalize the brainstorm. Do not write story prose.';
    const history: Message[] = [{
      id: 'persisted-repair-user',
      novelId: 'novel-1',
      conversationId: 'conv-A',
      role: 'user',
      content: repairPrompt,
      createdAt: 1,
    }];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat')) {
        chatPosts.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'provider still unavailable' }),
          { status: 503, statusText: 'Service Unavailable' },
        ));
      }
      return Promise.resolve(new Response(JSON.stringify(history), {
        headers: { 'Content-Type': 'application/json', 'X-InkMarshal-Chat-Turn-Status': 'failed' },
      }));
    });

    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.retryKind).toBe('repair');
    expect(result.current.errorMessage).toBe('failed');

    await act(async () => {
      await result.current.retry();
    });

    expect(chatPosts).toHaveLength(1);
    expect(chatPosts[0].body.trigger).toBe('regenerate-message');
    expect(chatPosts[0].body.repairStoryDeck).toBe(true);
  });

  it('polls a persisted running turn without exposing a premature Retry', async () => {
    const history: Message[] = [{
      id: 'persisted-running-user',
      novelId: 'novel-1',
      conversationId: 'conv-A',
      role: 'user',
      content: 'Keep writing',
      createdAt: 1,
    }];
    let status = 'running';
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(history), {
      headers: { 'Content-Type': 'application/json', 'X-InkMarshal-Chat-Turn-Status': status },
    })));

    const { result, unmount } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.recovering).toBe(true);
    expect(result.current.status).toBe('submitted');

    status = 'failed';
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.errorMessage).toBe('failed');
    expect(result.current.retryKind).toBe('ordinary');
    expect(result.current.recovering).toBe(false);
    unmount();
  });

  it('polls a snapshot-raced succeeded receipt until its assistant row appears', async () => {
    const user: Message = {
      id: 'snapshot-race-user',
      novelId: 'novel-1',
      conversationId: 'conv-A',
      role: 'user',
      content: 'Finish this response',
      createdAt: 1,
    };
    const assistant: Message = {
      id: 'snapshot-race-assistant',
      novelId: 'novel-1',
      conversationId: 'conv-A',
      role: 'assistant',
      content: 'Finished response',
      createdAt: 2,
    };
    let history = [user];
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(history), {
      headers: { 'Content-Type': 'application/json', 'X-InkMarshal-Chat-Turn-Status': 'succeeded' },
    })));

    const { result, unmount } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recovering).toBe(true);
    expect(result.current.status).toBe('submitted');
    expect(result.current.errorMessage).toBeNull();

    history = [user, assistant];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.recovering).toBe(false);
    expect(result.current.status).toBe('ready');
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.messages).toEqual(history);
    unmount();
  });

  it('exposes Retry after a running receipt passes the durable stale lease', async () => {
    const history: Message[] = [{
      id: 'stale-running-user',
      novelId: 'novel-1',
      conversationId: 'conv-A',
      role: 'user',
      content: 'Recover me',
      createdAt: 1,
    }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(history), {
      headers: { 'Content-Type': 'application/json', 'X-InkMarshal-Chat-Turn-Status': 'stale' },
    }));

    const { result } = renderHook(() => useNovelChatRuntime(baseArgs('conv-A')));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recovering).toBe(false);
    expect(result.current.errorMessage).toBe('failed');
    expect(result.current.retryKind).toBe('ordinary');
  });

  it('hydrates a persisted Stop with Retry and continues without replacing the partial', async () => {
    const persistedStop = stoppedPersistenceLabel('en');
    const history: Message[] = [
      {
        id: 'stopped-user',
        novelId: 'novel-1',
        conversationId: 'conv-A',
        role: 'user',
        content: 'Write a long scene',
        createdAt: 1,
      },
      {
        id: 'stopped-assistant',
        novelId: 'novel-1',
        conversationId: 'conv-A',
        role: 'assistant',
        content: `Durable partial\n\n${persistedStop}`,
        createdAt: 2,
      },
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat')) {
        chatPosts.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'retry preflight failed' }),
          { status: 503, statusText: 'Service Unavailable' },
        ));
      }
      return Promise.resolve({ ok: true, json: async () => history } as Response);
    });

    const { result } = renderHook(() => useNovelChatRuntime({
      ...baseArgs('conv-A'),
      stoppedLabel: persistedStop,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errorMessage).toBe('[Stopped]');
    expect(result.current.retryKind).toBe('stopped');
    expect(result.current.messages).toEqual(history);

    await act(async () => {
      await result.current.retry();
    });

    expect(chatPosts).toHaveLength(1);
    const postedMessages = chatPosts[0].body.messages as Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>;
    expect(postedMessages.at(-1)).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: stoppedContinuationPrompt('en') }],
    });
    expect(result.current.messages).toEqual(history);
    expect(result.current.retryKind).toBe('ordinary');
  });

  it('restores ordinary Retry when a persisted continuation user turn failed after startup', async () => {
    const persistedStop = stoppedPersistenceLabel('en');
    const history: Message[] = [
      {
        id: 'stopped-assistant',
        novelId: 'novel-1',
        conversationId: 'conv-A',
        role: 'assistant',
        content: `Durable partial\n\n${persistedStop}`,
        createdAt: 1,
      },
      {
        id: 'persisted-continuation-user',
        novelId: 'novel-1',
        conversationId: 'conv-A',
        role: 'user',
        content: stoppedContinuationPrompt('en'),
        createdAt: 2,
      },
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/chat')) {
        chatPosts.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'provider still unavailable' }),
          { status: 503, statusText: 'Service Unavailable' },
        ));
      }
      return Promise.resolve({ ok: true, json: async () => history } as Response);
    });

    const { result } = renderHook(() => useNovelChatRuntime({
      ...baseArgs('conv-A'),
      stoppedLabel: persistedStop,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errorMessage).toBe('failed');
    expect(result.current.retryKind).toBe('ordinary');

    await act(async () => {
      await result.current.retry();
    });

    expect(chatPosts).toHaveLength(1);
    expect(chatPosts[0].body.trigger).toBe('regenerate-message');
  });
});
