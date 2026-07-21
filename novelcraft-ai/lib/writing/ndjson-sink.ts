// NDJSON stream adapter for the autonomous writing flow (Phase 3). Owns the
// transport-keepalive concerns the use case shouldn't: the controller, the
// newline-framed encode, the heartbeat timer, the background lock-renew timer,
// and the once-only release + close in finally. The use case body runs as
// `run(sink)` and only ever calls `sink.emit` — it never touches the controller.
//
// Business terminal handling (the END log + writing_jobs finalize) stays inside
// the use case, which knows the end reason; this layer only tears down transport.

import type { WritingFrame } from '@/lib/writing-orchestrator';
import { WRITING_LOCK_RENEW_MS, type WritingLease } from '@/lib/writing/lease';
import { START_WRITING_EVENTS } from '@/lib/start-writing-logging';

type Logger = (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;

export interface WritingEventSink {
  emit(frame: WritingFrame): void;
  /** True once the client disconnected (an enqueue threw). */
  isClosed(): boolean;
}

export interface NdjsonWritingStreamOptions {
  signal: AbortSignal;
  lease: WritingLease;
  log: Logger;
  /** Invoked when the background renew timer reports the lock is gone (cancel). */
  onTimerLockLost: () => void;
  /** The use case body. Receives the sink; resolves/rejects to end the stream. */
  run: (sink: WritingEventSink) => Promise<void>;
}

export function createNdjsonWritingStream(opts: NdjsonWritingStreamOptions): ReadableStream {
  const encoder = new TextEncoder();
  let releaseOnCancel: Promise<void> | null = null;

  return new ReadableStream({
    async start(controller) {
      let controllerClosed = false;
      const send = (frame: WritingFrame) => {
        if (controllerClosed || opts.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n'));
        } catch {
          controllerClosed = true;
          opts.log(START_WRITING_EVENTS.streamClosed);
        }
      };
      const sink: WritingEventSink = { emit: send, isClosed: () => controllerClosed };

      // Heartbeat keeps proxies/clients from timing out during slow model calls.
      const heartbeat = setInterval(() => send({ type: 'heartbeat', at: new Date().toISOString() }), 5000);
      // Renew on a timer too, not only at chapter boundaries: a single chapter
      // can exceed the lock TTL on slow local engines, which would let another
      // session steal the lock mid-generation. If renewal reports the lock is
      // gone, cancel so we stop promptly.
      const lockRenewInterval = setInterval(() => {
        void opts.lease.renewQuietly(opts.onTimerLockLost);
      }, WRITING_LOCK_RENEW_MS);

      try {
        await opts.run(sink);
      } finally {
        clearInterval(heartbeat);
        clearInterval(lockRenewInterval);
        try {
          await opts.lease.release();
          opts.log(START_WRITING_EVENTS.lockReleased);
        } catch (releaseErr) {
          console.error('Failed to release writing lock:', releaseErr);
        }
        if (!controllerClosed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    async cancel() {
      // Client aborted the fetch: stop the run and release the lock once.
      opts.onTimerLockLost();
      releaseOnCancel ??= opts.lease.release();
      await releaseOnCancel;
    },
  });
}
