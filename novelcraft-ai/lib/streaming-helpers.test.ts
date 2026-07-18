import { describe, expect, it, vi } from 'vitest';
import {
  createFinalTextCapture,
  frameTextStreamWithCleanup,
  textStreamWithFinalTextFallback,
} from '@/lib/streaming-helpers';

async function collectFrames(stream: AsyncIterable<string>): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = [];
  for await (const line of stream) {
    frames.push(JSON.parse(line));
  }
  return frames;
}

describe('frameTextStreamWithCleanup', () => {
  it('exposes buffered final text as a plain text stream fallback', async () => {
    const finalText = createFinalTextCapture();
    finalText.resolve('buffered chapter');

    const chunks: string[] = [];
    for await (const chunk of textStreamWithFinalTextFallback((async function* () {})(), {
      finalText: finalText.promise,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['buffered chapter']);
  });

  it('emits buffered final text when no delta chunks arrive', async () => {
    const finalText = createFinalTextCapture();
    const release = vi.fn();
    finalText.resolve('buffered rewrite');

    const frames = await collectFrames(frameTextStreamWithCleanup((async function* () {})(), release, {
      finalText: finalText.promise,
    }));

    expect(frames).toEqual([
      { type: 'chunk', text: 'buffered rewrite' },
      { type: 'done' },
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate final text when delta chunks already arrived', async () => {
    const finalText = createFinalTextCapture();
    finalText.resolve('hello world');

    const frames = await collectFrames(frameTextStreamWithCleanup((async function* () {
      yield 'hello ';
      yield 'world';
    })(), vi.fn(), {
      finalText: finalText.promise,
    }));

    expect(frames).toEqual([
      { type: 'chunk', text: 'hello ' },
      { type: 'chunk', text: 'world' },
      { type: 'done' },
    ]);
  });

  it('still releases resources when the final-text fallback rejects', async () => {
    const finalText = createFinalTextCapture();
    const release = vi.fn();
    finalText.reject(new Error('usage settlement failed'));

    const frames = await collectFrames(frameTextStreamWithCleanup((async function* () {})(), release, {
      finalText: finalText.promise,
    }));

    expect(frames).toEqual([
      { type: 'error', error: 'usage settlement failed' },
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-clean finishReason on the done frame so the client can warn', async () => {
    const release = vi.fn();
    const frames = await collectFrames(frameTextStreamWithCleanup(
      (async function* () { yield 'partial'; })(),
      release,
      { finishReason: Promise.resolve('length') },
    ));

    expect(frames).toEqual([
      { type: 'chunk', text: 'partial' },
      { type: 'done', finishReason: 'length' },
    ]);
  });

  it('omits a clean stop finishReason from the done frame', async () => {
    const release = vi.fn();
    const frames = await collectFrames(frameTextStreamWithCleanup(
      (async function* () { yield 'all good'; })(),
      release,
      { finishReason: Promise.resolve('stop') },
    ));

    expect(frames).toEqual([
      { type: 'chunk', text: 'all good' },
      { type: 'done' },
    ]);
  });
});
