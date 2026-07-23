import { describe, expect, it, vi } from 'vitest';
import { createNdjsonWritingStream } from '@/lib/writing/ndjson-sink';

async function readFrames(stream: ReadableStream): Promise<Array<Record<string, unknown>>> {
  const text = await new Response(stream).text();
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

describe('createNdjsonWritingStream', () => {
  it('delivers one business terminal after generation abort while dropping non-terminal frames', async () => {
    const abort = new AbortController();
    const stream = createNdjsonWritingStream({
      signal: abort.signal,
      lease: {
        renew: vi.fn(async () => true),
        renewQuietly: vi.fn(),
        hasLost: vi.fn(() => false),
        release: vi.fn(async () => {}),
      },
      log: vi.fn(),
      onTimerLockLost: vi.fn(),
      run: async sink => {
        abort.abort();
        sink.emit({ type: 'progress', progress: 10, message: 'late progress' });
        sink.emit({ type: 'error', error: 'Writing lock lost.' });
      },
    });

    await expect(readFrames(stream)).resolves.toEqual([
      { type: 'error', error: 'Writing lock lost.' },
    ]);
  });
});
