import { afterEach, describe, expect, it, vi } from 'vitest';

const headerMocks = vi.hoisted(() => ({
  buildRoleAwareHeaders: vi.fn(),
  buildRoleAwareHeadersForOperations: vi.fn(),
}));

const gateMocks = vi.hoisted(() => ({
  awaitAIActionReady: vi.fn(async () => undefined),
}));

vi.mock('@/lib/model-supply/headers', () => ({
  buildRoleAwareHeaders: headerMocks.buildRoleAwareHeaders,
  buildRoleAwareHeadersForOperations: headerMocks.buildRoleAwareHeadersForOperations,
}));

vi.mock('@/lib/ai-action-gate', () => ({
  awaitAIActionReady: gateMocks.awaitAIActionReady,
}));

import { buildModelHeaders, consumeNdjsonStream } from '@/lib/streaming-client';

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildModelHeaders', () => {
  it('emits the single-operation role-aware headers with the JSON content type', async () => {
    headerMocks.buildRoleAwareHeaders.mockResolvedValue({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://127.0.0.1:8000/v1',
      'x-im-model': 'draft-model',
      'x-im-secret': 'sk-role-aware',
    });

    await expect(buildModelHeaders('chapter')).resolves.toEqual({
      'Content-Type': 'application/json',
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://127.0.0.1:8000/v1',
      'x-im-model': 'draft-model',
      'x-im-secret': 'sk-role-aware',
    });
    expect(headerMocks.buildRoleAwareHeadersForOperations).not.toHaveBeenCalled();
    expect(gateMocks.awaitAIActionReady).toHaveBeenCalledWith('chapter', undefined);
  });

  it('emits the multi-operation scoped role-aware headers with the JSON content type', async () => {
    headerMocks.buildRoleAwareHeadersForOperations.mockResolvedValue({
      'x-im-draft-transport': 'openai-compatible',
      'x-im-draft-base-url': 'http://127.0.0.1:8000/v1',
      'x-im-draft-model': 'draft-model',
      'x-im-planning-transport': 'openai-compatible',
      'x-im-planning-base-url': 'http://127.0.0.1:8001/v1',
      'x-im-planning-model': 'planning-model',
    });

    await expect(buildModelHeaders(['chapter', 'outline'])).resolves.toEqual({
      'Content-Type': 'application/json',
      'x-im-draft-transport': 'openai-compatible',
      'x-im-draft-base-url': 'http://127.0.0.1:8000/v1',
      'x-im-draft-model': 'draft-model',
      'x-im-planning-transport': 'openai-compatible',
      'x-im-planning-base-url': 'http://127.0.0.1:8001/v1',
      'x-im-planning-model': 'planning-model',
    });
    expect(headerMocks.buildRoleAwareHeaders).not.toHaveBeenCalled();
  });

  it('propagates a role binding failure instead of swallowing it', async () => {
    headerMocks.buildRoleAwareHeadersForOperations.mockRejectedValue(
      new Error('Local model runtime "Draft" is not running'),
    );

    await expect(buildModelHeaders(['chapter', 'outline'])).rejects.toThrow(
      'Local model runtime "Draft" is not running',
    );
  });
});

describe('consumeNdjsonStream', () => {
  it('parses NDJSON split across chunks', async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"progress","progress":1}\n{"type":"wri'));
        controller.enqueue(encoder.encode('ting","chunk":"hello"}\n'));
        controller.close();
      },
    }));
    const events: Record<string, unknown>[] = [];

    await consumeNdjsonStream(response, {
      onEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([
      { type: 'progress', progress: 1 },
      { type: 'writing', chunk: 'hello' },
    ]);
  });

  it('counts malformed JSON lines without suppressing valid events', async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('not-json\n{"type":"done"}\ntrailing-garbage'));
        controller.close();
      },
    }));
    const events: Record<string, unknown>[] = [];
    const malformed: string[] = [];

    const stats = await consumeNdjsonStream(response, {
      onEvent(event) {
        events.push(event);
      },
    }, {
      onMalformedLine(line) {
        malformed.push(line);
      },
    });

    expect(events).toEqual([{ type: 'done' }]);
    expect(stats.malformedLines).toBe(2);
    expect(malformed).toEqual(['not-json', 'trailing-garbage']);
  });

  it('propagates handler errors instead of treating them as malformed JSON', async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"done"}\n'));
        controller.close();
      },
    }));

    await expect(consumeNdjsonStream(response, {
      onEvent() {
        throw new Error('refresh failed');
      },
    })).rejects.toThrow('refresh failed');
  });

  it('cancels the response stream when a handler fails', async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"done"}\n'));
      },
      cancel,
    }));

    await expect(consumeNdjsonStream(response, {
      onEvent() {
        throw new Error('refresh failed');
      },
    })).rejects.toThrow('refresh failed');

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects when no stream data arrives before the read timeout', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start() {}, cancel }));
    const promise = consumeNdjsonStream(
      response,
      { onEvent: vi.fn() },
      { readTimeoutMs: 5, timeoutMessage: 'No data' },
    );

    await expect(promise).rejects.toThrow('No data');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // A7: a trailing event whose last multi-byte CJK character is split across
  // the final two chunks must decode exactly once (not garbled/dropped). The
  // old `decoder.decode() + buffer` ordering could misplace the flushed tail.
  it('decodes a trailing CJK event split across chunk boundaries once', async () => {
    const encoder = new TextEncoder();
    // Build a complete event ending in a CJK char, then split its UTF-8 bytes
    // mid-character so the second chunk completes the final codepoint.
    const full = encoder.encode('{"type":"done","text":"完成"}\n');
    // 找到最后的 '成' (3 bytes) 第一个字节之后的位置切分,保证第二个 chunk 才补全它。
    // '完' = e5 ae 8c, '成' = e6 88 90. Split before the last 2 bytes of '成'.
    const splitAt = full.length - 2;
    const first = full.slice(0, splitAt);
    const second = full.slice(splitAt);

    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    }));
    const events: Record<string, unknown>[] = [];
    await consumeNdjsonStream(response, { onEvent: e => { events.push(e); } });

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('完成');
  });
});
