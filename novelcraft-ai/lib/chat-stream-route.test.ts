import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import type { Message } from '@/lib/db-types';
import type { NovelChatUIMessage } from '@/lib/chat-ui-message';

const aiMocks = vi.hoisted(() => ({ streamText: vi.fn() }));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: aiMocks.streamText,
}));

import { streamChatTurnResponse, type ChatTurnPersistence } from '@/lib/chat-stream-route';

function makeAiUsage() {
  return {
    model: {} as never,
    runtimeModel: { id: 't', label: 'T', provider: 'openai', modelId: 't', contextWindow: 8192 },
    addPromptText: vi.fn(),
    addPartialOutput: vi.fn(),
    recordUsage: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  };
}

function msg(id: string, role: Message['role'], content: string): Message {
  return { id, novelId: 'n', role, content, conversationId: null, createdAt: 1 };
}

function uiMessage(id: string, role: NovelChatUIMessage['role'], text: string): NovelChatUIMessage {
  return { id, role, parts: [{ type: 'text', text, state: 'done' }] };
}

function makePersistence(overrides: Partial<ChatTurnPersistence> = {}): ChatTurnPersistence {
  return {
    persistUser: vi.fn(async (id: string) => msg(id, 'user', 'hi')),
    persistAssistant: vi.fn(async (id: string, text: string) => msg(id, 'assistant', text)),
    persistStoppedAssistant: vi.fn(async (id: string, text: string) => msg(id, 'assistant', text)),
    ...overrides,
  };
}

async function drain(response: Response): Promise<string> {
  return await response.text();
}

interface MockStreamTextOptions {
  abortSignal?: AbortSignal;
  onFinish: (event: {
    text: string;
    usage: undefined;
    finishReason?: string;
  }) => Promise<void>;
  onError: (event: { error: unknown }) => Promise<void>;
}

interface MockUIMessageResponseOptions {
  headers?: HeadersInit;
  generateMessageId?: () => string;
  onError?: (error: unknown) => string;
  originalMessages?: NovelChatUIMessage[];
  consumeSseStream?: (options: {
    stream: ReadableStream<string>;
  }) => PromiseLike<void> | void;
  onFinish?: (event: {
    responseMessage: NovelChatUIMessage;
    isAborted: boolean;
    isContinuation: boolean;
    messages: NovelChatUIMessage[];
  }) => Promise<void> | void;
  messageMetadata?: (event: { part: { type: 'start' | 'finish' } }) => unknown;
}

function uiResponse(
  options: MockUIMessageResponseOptions,
  run: () => Promise<unknown>,
): Response {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'text/event-stream; charset=utf-8');
  return new Response(new ReadableStream({
    async start(controller) {
      const payload = await run();
      controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      controller.close();
    },
  }), { headers });
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

beforeEach(() => aiMocks.streamText.mockReset());
afterEach(() => vi.clearAllMocks());

describe('streamChatTurnResponse', () => {
  it('returns an AI SDK UIMessage stream and persists the submitted turn', async () => {
    aiMocks.streamText.mockImplementation((opts: MockStreamTextOptions) => ({
      toUIMessageStreamResponse: (responseOptions: MockUIMessageResponseOptions) => uiResponse(responseOptions, async () => {
        const startMetadata = responseOptions.messageMetadata?.({ part: { type: 'start' } });
        await opts.onFinish({ text: 'hello', usage: undefined });
        const finishMetadata = responseOptions.messageMetadata?.({ part: { type: 'finish' } });
        return {
          messageId: responseOptions.generateMessageId?.(),
          'text-delta': 'hello',
          startMetadata,
          finishMetadata,
        };
      }),
    }));
    const aiUsage = makeAiUsage();
    const persistence = makePersistence();

    const response = await streamChatTurnResponse({
      aiUsage: aiUsage as never,
      requestSignal: new AbortController().signal,
      system: 'sys',
      history: [{ role: 'user', content: 'hi' }],
      preset: { temperature: 0.75 },
      persistence,
      originalMessages: [uiMessage('user-1', 'user', 'hi')],
      submittedUserMessage: uiMessage('user-1', 'user', 'hi'),
      responseMessageId: 'assistant-1',
      headers: { 'X-Test': 'ok' },
    });
    const body = await drain(response);

    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(response.headers.get('X-Test')).toBe('ok');
    expect(body).toContain('text-delta');
    expect(body).toContain('assistant-1');
    expect(body).toContain('hello');
    expect(body).toContain('"persisted":true');
    expect(persistence.persistUser).toHaveBeenCalledWith('user-1');
    expect(persistence.persistAssistant).toHaveBeenCalledWith('assistant-1', 'hello');
    expect(persistence.persistStoppedAssistant).not.toHaveBeenCalled();
    expect(aiUsage.settle).toHaveBeenCalledWith({
      outcome: 'success',
      usage: undefined,
      finishReason: undefined,
    });
  });

  it('sends a sanitized stream error and fails usage when the provider stream errors', async () => {
    aiMocks.streamText.mockImplementation((opts: MockStreamTextOptions) => ({
      toUIMessageStreamResponse: (responseOptions: MockUIMessageResponseOptions) => uiResponse(responseOptions, async () => {
        const error = Object.assign(new Error('raw provider failure'), { statusCode: 401 });
        await opts.onError({ error });
        return { error: responseOptions.onError?.(error) };
      }),
    }));
    const aiUsage = makeAiUsage();
    const persistence = makePersistence();

    const response = await streamChatTurnResponse({
      aiUsage: aiUsage as never,
      requestSignal: new AbortController().signal,
      system: 'sys',
      history: [{ role: 'user', content: 'hi' }],
      preset: { temperature: 0.75 },
      persistence,
      originalMessages: [uiMessage('user-1', 'user', 'hi')],
      submittedUserMessage: uiMessage('user-1', 'user', 'hi'),
      responseMessageId: 'assistant-1',
    });
    const body = await drain(response);

    expect(body).toContain('INKMARSHAL_AI_ERROR:');
    expect(body).toContain('invalid_credentials');
    expect(body).toContain('aiErrorInvalidCredentials');
    expect(body).not.toContain('raw provider failure');
    expect(persistence.persistUser).toHaveBeenCalledWith('user-1');
    expect(persistence.persistAssistant).not.toHaveBeenCalled();
    expect(aiUsage.settle).toHaveBeenCalledWith({ outcome: 'failed' });
  });

  it('persists an aborted partial through real response cancellation and consumeSseStream', async () => {
    aiMocks.streamText.mockImplementation((opts: MockStreamTextOptions) => ({
      toUIMessageStreamResponse: (responseOptions: MockUIMessageResponseOptions) => {
        const responseMessageId = responseOptions.generateMessageId?.() ?? 'assistant-1';
        const stream = createUIMessageStream<NovelChatUIMessage>({
          originalMessages: responseOptions.originalMessages ?? [uiMessage('user-1', 'user', 'hi')],
          generateId: () => responseMessageId,
          onError: responseOptions.onError ?? (() => 'error'),
          onFinish: responseOptions.onFinish,
          execute: async ({ writer }) => {
            const textId = `${responseMessageId}:text`;
            writer.write({ type: 'start', messageId: responseMessageId });
            writer.write({ type: 'text-start', id: textId });
            writer.write({ type: 'text-delta', id: textId, delta: 'partial reply' });

            // Hold open like an in-flight generation until the request is aborted.
            await waitForAbort(opts.abortSignal);

            await opts.onFinish({
              text: 'partial reply',
              usage: undefined,
              finishReason: 'stop',
            });
            writer.write({ type: 'abort' });
          },
        });

        return createUIMessageStreamResponse({
          stream,
          headers: responseOptions.headers,
          // Pass through production wiring so cancelling the response reader
          // exercises the independent SSE consumer path.
          consumeSseStream: responseOptions.consumeSseStream,
        });
      },
    }));

    const aiUsage = makeAiUsage();
    let resolveStopped: ((value: { id: string; text: string }) => void) | undefined;
    const stoppedPersisted = new Promise<{ id: string; text: string }>((resolve) => {
      resolveStopped = resolve;
    });
    const persistence = makePersistence({
      persistStoppedAssistant: vi.fn(async (id: string, text: string) => {
        resolveStopped?.({ id, text });
        return msg(id, 'assistant', text);
      }),
    });
    const requestController = new AbortController();

    const response = await streamChatTurnResponse({
      aiUsage: aiUsage as never,
      requestSignal: requestController.signal,
      system: 'sys',
      history: [{ role: 'user', content: 'hi' }],
      preset: { temperature: 0.75 },
      persistence,
      originalMessages: [uiMessage('user-1', 'user', 'hi')],
      submittedUserMessage: uiMessage('user-1', 'user', 'hi'),
      responseMessageId: 'assistant-1',
      stoppedLabel: 'Stopped',
    });

    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buffered = '';

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes('partial reply')) {
        // Simulate client Stop: drop the response body first, then abort the
        // request. Without consumeSseStream the UI onFinish abort path dies here.
        await reader.cancel();
        requestController.abort();
        break;
      }
    }

    const saved = await stoppedPersisted;

    expect(saved).toEqual({
      id: 'assistant-1',
      text: 'partial reply\n\nStopped',
    });
    expect(persistence.persistStoppedAssistant).toHaveBeenCalledTimes(1);
    expect(persistence.persistAssistant).not.toHaveBeenCalled();
    expect(aiUsage.settle).toHaveBeenCalledTimes(1);
    expect(aiUsage.settle).toHaveBeenCalledWith({ outcome: 'cancelled', usage: undefined });
  });
});
