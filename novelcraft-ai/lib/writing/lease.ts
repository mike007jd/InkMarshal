// Writing-lock lease (Phase 3): a thin wrapper over the novels-table writing
// lock (acquire/renew/release), so the use case renews at chapter boundaries
// and the stream adapter renews on a timer + releases once — without either
// knowing the lock's storage. The lock itself is unchanged (queries-novel).
//
// acquire stays in the route (it must return 409 synchronously before any
// stream is created); the route hands the acquired token to createWritingLease.

import { releaseWritingLock, renewWritingLock } from '@/lib/db';
import { START_WRITING_EVENTS } from '@/lib/start-writing-logging';

export const WRITING_LOCK_TTL_SEC = 600;
// Proactively renew the writing lock partway through its TTL so a single slow
// chapter (common with local engines) can't outlive the lock and let another
// session steal it mid-generation. TTL/3 leaves two renewal attempts of slack.
export const WRITING_LOCK_RENEW_MS = (WRITING_LOCK_TTL_SEC * 1000) / 3;

type Logger = (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;

export interface WritingLease {
  /** Boundary renewal: false means another session took the lock — caller stops. */
  renew(): Promise<boolean>;
  /** Background timer renewal (never throws); calls onLost if the lock is gone. */
  renewQuietly(onLost: () => void): Promise<void>;
  /** Release the lock exactly once (idempotent across calls). */
  release(): Promise<void>;
}

export function createWritingLease(novelId: string, token: string, log: Logger): WritingLease {
  let releasePromise: Promise<void> | null = null;
  return {
    async renew() {
      const newExpiry = await renewWritingLock(novelId, token, WRITING_LOCK_TTL_SEC);
      if (newExpiry) {
        log(START_WRITING_EVENTS.lockRenewed, { expiresAt: new Date(newExpiry).toISOString() });
        return true;
      }
      log(START_WRITING_EVENTS.lockFailed, { reason: 'lock_lost_during_run' });
      return false;
    },
    async renewQuietly(onLost) {
      try {
        const expiry = await renewWritingLock(novelId, token, WRITING_LOCK_TTL_SEC);
        if (expiry) {
          log(START_WRITING_EVENTS.lockRenewed, {
            expiresAt: new Date(expiry).toISOString(),
            via: 'timer',
          });
          return;
        }
        log(START_WRITING_EVENTS.lockFailed, { reason: 'lock_lost_mid_chapter' });
        onLost();
      } catch {
        // A single transient DB hiccup shouldn't kill an in-flight chapter;
        // the boundary renew() calls still catch a genuine loss.
      }
    },
    release() {
      releasePromise ??= releaseWritingLock(novelId, token);
      return releasePromise;
    },
  };
}
