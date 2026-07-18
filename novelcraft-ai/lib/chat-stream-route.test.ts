import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  onFinish: (event: { text: string; usage: undefined }) => Promise<void>;
  onError: (event: { error: unknown }) => Promise<void>;
}

interface MockUIMessageResponseOptions {
  headers?: HeadersInit;
  generateMessageId?: () => string;
  onError?: (error: unknown) => string;
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

  it('persists an aborted partial assistant response through the server stream lifecycle', async () => {
    aiMocks.streamText.mockImplementation((opts: MockStreamTextOptions) => ({
      toUIMessageStreamResponse: (responseOptions: MockUIMessageResponseOptions) => uiResponse(responseOptions, async () => {
        await opts.onFinish({ text: 'partial reply', usage: undefined });
        await responseOptions.onFinish?.({
          responseMessage: uiMessage('assistant-1', 'assistant', 'partial reply'),
          isAborted: true,
          isContinuation: false,
          messages: [],
        });
        return { 'text-delta': 'partial reply' };
      }),
    }));
    const aiUsage = makeAiUsage();
    const persistence = makePersistence();
    const requestController = new AbortController();
    requestController.abort();

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

    await drain(response);

    expect(persistence.persistAssistant).not.toHaveBeenCalled();
    expect(persistence.persistStoppedAssistant).toHaveBeenCalledWith('assistant-1', 'partial reply\n\nStopped');
    expect(aiUsage.settle).toHaveBeenCalledTimes(1);
    expect(aiUsage.settle).toHaveBeenCalledWith({ outcome: 'cancelled', usage: undefined });
  });
});
