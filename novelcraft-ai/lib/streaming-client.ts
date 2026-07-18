import {
  buildRoleAwareHeaders,
  buildRoleAwareHeadersForOperations,
  type AIHeaderOptions,
} from '@/lib/model-supply/headers';
// Reuse B.1's client-safe operation union as the AI operation type. Importing
// it from `lib/model-supply/types` (not `@/lib/ai-usage`, which pulls server-
// ish `ai`/ai-providers code) keeps this client module's bundle clean.
import { type OperationKind } from '@/lib/model-supply/types';
import { awaitAIActionReady } from '@/lib/ai-action-gate';

/** Client-side AI operation. Alias of B.1's {@link OperationKind}. */
export type AIRequestOperation = OperationKind;
export type AIRequestOperations = AIRequestOperation | readonly AIRequestOperation[];

function isOperationList(operation: AIRequestOperations): operation is readonly AIRequestOperation[] {
  return Array.isArray(operation);
}

/**
 * Headers to send with any AI-call fetch from the client, for a specific
 * writing `operation` (REQUIRED — every call site must declare intent so tsc
 * flags any missed one). Emits the role-aware `x-im-*` set resolved from the
 * user's capability bindings.
 *
 * Optional `opts` adds `x-im-creativity`/`x-im-style-id` hints.
 */
export async function buildModelHeaders(
  operation: AIRequestOperations,
  opts?: AIHeaderOptions,
  gate?: { signal?: AbortSignal },
): Promise<Record<string, string>> {
  await awaitAIActionReady(operation, gate?.signal);
  const roleHeaders = isOperationList(operation)
    ? await buildRoleAwareHeadersForOperations(operation, opts)
    : await buildRoleAwareHeaders(operation, opts);
  return {
    'Content-Type': 'application/json',
    ...roleHeaders,
  };
}

/**
 * Wraps buildModelHeaders + x-locale so callers don't forget the locale —
 * server routes default to 'en' otherwise, which silently breaks zh callers.
 */
export async function buildAIRequestHeaders(
  locale: string,
  operation: AIRequestOperations,
  opts?: AIHeaderOptions,
  gate?: { signal?: AbortSignal },
): Promise<Record<string, string>> {
  return { ...(await buildModelHeaders(operation, opts, gate)), 'x-locale': locale };
}

export interface NdjsonHandlers {
  onEvent(data: Record<string, unknown>): void | Promise<void>;
}

export interface ConsumeNdjsonOptions {
  readTimeoutMs?: number;
  timeoutMessage?: string;
  onMalformedLine?: (line: string) => void;
}

export interface NdjsonStreamStats {
  malformedLines: number;
}

/**
 * Coalesce streaming text chunks into a single per-frame setState. A naive
 * `setState(prev => prev + chunk)` per token forces a render storm during long
 * AI generations (each render also re-runs heavy children — Markdown parsers,
 * pagination). Use the returned `enqueue` for every chunk and call `flush`
 * once the stream finishes; `cancel` discards pending work on abort.
 */
export interface ChunkBatcher {
  enqueue(text: string): void;
  flush(): void;
  cancel(): void;
}

export function createChunkBatcher(apply: (chunk: string) => void): ChunkBatcher {
  let buffer = '';
  let scheduled = false;
  let raf: ReturnType<typeof requestAnimationFrame> | null = null;
  const hasRaf = typeof requestAnimationFrame === 'function';
  const drain = () => {
    raf = null;
    scheduled = false;
    if (!buffer) return;
    const out = buffer;
    buffer = '';
    apply(out);
  };
  const cancelScheduled = () => {
    if (raf != null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    scheduled = false;
  };
  return {
    enqueue(text: string) {
      if (!text) return;
      buffer += text;
      if (scheduled) return;
      scheduled = true;
      // Fall back to microtasks under SSR / tests where rAF is undefined,
      // otherwise the buffer would only drain on explicit flush().
      if (hasRaf) raf = requestAnimationFrame(drain);
      else queueMicrotask(drain);
    },
    flush() {
      cancelScheduled();
      drain();
    },
    cancel() {
      buffer = '';
      cancelScheduled();
    },
  };
}

/**
 * Read an NDJSON-framed Response stream and dispatch each parsed object via
 * `onEvent`. Tolerates partial lines split across chunk boundaries. The three
 * client-side AI streaming consumers used to inline the same reader+decoder+
 * `buffer.split('\n')` boilerplate; this helper centralises it so future
 * tweaks (back-pressure, abort handling) live in one place.
 */
export async function consumeNdjsonStream(
  response: Response,
  handlers: NdjsonHandlers,
  options: ConsumeNdjsonOptions = {},
): Promise<NdjsonStreamStats> {
  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let malformedLines = 0;
  const readTimeoutMs = options.readTimeoutMs ?? 0;
  const timeoutMessage = options.timeoutMessage ?? 'Stream timed out';
  const noteMalformedLine = (line: string) => {
    malformedLines += 1;
    options.onMalformedLine?.(line);
    if (
      !options.onMalformedLine &&
      (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
    ) {
      console.warn('Malformed NDJSON frame skipped', { preview: line.slice(0, 160) });
    }
  };

  const readNext = async () => {
    if (readTimeoutMs <= 0) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            void reader.cancel(timeoutMessage).catch(() => {});
            reject(new Error(timeoutMessage));
          }, readTimeoutMs);
        }),
      ]);
      if (timedOut) throw new Error(timeoutMessage);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    while (true) {
      const { done, value } = await readNext();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Production stays resilient; development/test can still observe
          // protocol drift through the malformed counter/callback.
          noteMalformedLine(line);
          continue;
        }
        await handlers.onEvent(event);
      }
    }

    // Final flush. The decoder may still hold an incomplete multi-byte sequence
    // (a CJK character split across the last two chunks) that stream-mode
    // decoding did NOT emit into `buffer` yet — so flush it and append, do NOT
    // prepend (buffer already holds the decoded tail; the flush only adds the
    // newly-completed trailing bytes).
    const trailing = (buffer + decoder.decode()).trim();
    if (trailing) {
      let event: Record<string, unknown> | null = null;
      try {
        event = JSON.parse(trailing) as Record<string, unknown>;
      } catch {
        noteMalformedLine(trailing);
      }
      if (event) await handlers.onEvent(event);
    }
    return { malformedLines };
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The stream may already be closed or cancellation may already be in
      // flight from the timeout path. Either way the original error is what
      // the caller needs.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing can throw when a timed-out read is still settling after
      // cancel(); the cancellation itself is the important side effect.
    }
  }
}
