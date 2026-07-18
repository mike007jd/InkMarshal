// Shared NDJSON framing for the streaming API surface. Producers emit frames
// via `ndjson(...)`; clients consume them via `consumeNdjsonStream` from
// streaming-client.ts. One wire format, one error-frame key (`error`).

export type StreamFrame =
  | { type: 'chunk'; text: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; error: string };

/** Encode one frame as a single line of NDJSON (`{...}\n`). */
function ndjson(frame: StreamFrame): string {
  return JSON.stringify(frame) + '\n';
}

const NDJSON_CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

export const STREAMING_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': NDJSON_CONTENT_TYPE,
  'Cache-Control': 'no-store',
  'X-Accel-Buffering': 'no',
  'X-Content-Type-Options': 'nosniff',
};

export interface TextStreamFramingOptions {
  /**
   * Some providers buffer the complete response and surface it only through
   * `onFinish.text`. When no delta chunks arrived, emit that final text as the
   * single chunk so the editor still receives the generation.
   */
  finalText?: Promise<string | null | undefined>;
  /**
   * Resolves to the stream's finishReason (settled by the caller's onFinish /
   * onError). When it is a non-clean reason ('length' = cut off at the output
   * cap, 'error' = provider failed mid-stream after some text), it rides along
   * on the `done` frame so the client can warn the writer the result may be
   * incomplete instead of presenting truncated prose as a finished generation.
   */
  finishReason?: Promise<string | null | undefined>;
}

export interface FinalTextCapture {
  promise: Promise<string>;
  resolve(text: string): void;
  reject(error: unknown): void;
}

export function createFinalTextCapture(): FinalTextCapture {
  let settled = false;
  let resolvePromise: (text: string) => void = () => {};
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<string>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    resolve(text: string) {
      if (settled) return;
      settled = true;
      resolvePromise(text);
    },
    reject(error: unknown) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

export async function* textStreamWithFinalTextFallback(
  textStream: AsyncIterable<string>,
  options: TextStreamFramingOptions = {},
): AsyncGenerator<string> {
  let hasStreamed = false;
  for await (const text of textStream) {
    hasStreamed = true;
    yield text;
  }
  if (!hasStreamed && options.finalText) {
    const finalText = await options.finalText;
    if (finalText) {
      yield finalText;
    }
  }
}

/**
 * Wrap an async text stream as NDJSON frames (chunk → done | error) and run
 * `onRelease` exactly once when the stream exits (success, error, or abort).
 * Shared by the chapter continue/rewrite routes so they speak the same wire
 * format and release shared resources (writing locks, etc.) on every path.
 */
export async function* frameTextStreamWithCleanup(
  textStream: AsyncIterable<string>,
  onRelease: () => Promise<void> | void,
  options: TextStreamFramingOptions = {},
): AsyncGenerator<string> {
  try {
    try {
      for await (const text of textStreamWithFinalTextFallback(textStream, options)) {
        yield ndjson({ type: 'chunk', text });
      }
      // The loop only exits after the stream closes, i.e. after the finish part
      // that drives onFinish — so this promise is already settled and adds no
      // latency. Surface only non-clean reasons; a normal 'stop' stays absent.
      const finishReason = options.finishReason ? await options.finishReason : undefined;
      yield ndjson(
        finishReason && finishReason !== 'stop'
          ? { type: 'done', finishReason }
          : { type: 'done' },
      );
    } catch (err) {
      yield ndjson({
        type: 'error',
        error: err instanceof Error ? err.message : 'stream failed',
      });
    }
  } finally {
    await onRelease();
  }
}
