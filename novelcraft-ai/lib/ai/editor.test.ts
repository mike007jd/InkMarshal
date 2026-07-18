import { describe, expect, it, vi } from 'vitest';

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  Output: { object: vi.fn((config: unknown) => ({ type: 'object-output', config })) },
}));

vi.mock('ai', () => ({
  streamText: aiMocks.streamText,
  Output: aiMocks.Output,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('streamEdit', () => {
  it('does not resolve the final object before usage and onFinish settle', async () => {
    const { streamEdit } = await import('@/lib/ai/editor');
    const output = deferred<{ changes: never[]; summary: string }>();
    const usage = deferred<{ inputTokens: number; outputTokens: number; totalTokens: number }>();
    const finishGate = deferred<void>();
    const onFinish = vi.fn(async () => {
      await finishGate.promise;
    });

    aiMocks.streamText.mockReturnValueOnce({
      output: output.promise,
      usage: usage.promise,
      partialOutputStream: (async function* () {})(),
    });

    const result = streamEdit({
      model: {} as never,
      novelContext: { title: 'Novel', genre: 'Fantasy' },
      chapterText: 'Original chapter text.',
      instruction: 'Tighten it.',
      onFinish,
    });

    let outputResolved = false;
    const outputPromise = Promise.resolve(result.output).then(value => {
      outputResolved = true;
      return value;
    });

    output.resolve({ changes: [], summary: 'done' });
    await flushMicrotasks();
    expect(outputResolved).toBe(false);
    expect(onFinish).not.toHaveBeenCalled();

    usage.resolve({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    await flushMicrotasks();
    expect(outputResolved).toBe(false);
    expect(onFinish).toHaveBeenCalledWith({
      object: { changes: [], summary: 'done' },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });

    finishGate.resolve();
    await expect(outputPromise).resolves.toEqual({ changes: [], summary: 'done' });
    expect(outputResolved).toBe(true);
    expect('object' in result).toBe(false);
    expect('partialObjectStream' in result).toBe(false);
    // Own adapter surface (not the mutated SDK result): partial stream + output
    // + usage.
    expect('partialOutputStream' in result).toBe(true);
    expect('usage' in result).toBe(true);
  });
});
