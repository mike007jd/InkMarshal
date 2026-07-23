// Thin run-history queries for the autonomous writing flow (Phase 3). Server-only
// (loads better-sqlite3 via getDb). There are exactly TWO status writes:
// createWritingJob (entry) and finalizeWritingJob (terminal); bumpWritingJobProgress
// only advances progress without touching status. See lib/db/schema/0001_initial.ts.

import { getDb } from '@/lib/db/connection';
import { applyNovelUpdate } from '@/lib/db/queries-novel';
import type { Novel } from '@/lib/db-types';
import { nowIso } from '@/lib/utils';

export type WritingJobStatus = 'running' | 'paused' | 'completed' | 'failed';

export interface WritingJob {
  id: string;
  novelId: string;
  status: WritingJobStatus;
  endReason: string | null;
  currentChapter: number | null;
  completedInRun: number;
  seq: number;
  errorMessage: string | null;
  startedAt: string;
  updatedAt: string;
}

interface WritingJobRow {
  id: string;
  novel_id: string;
  status: WritingJobStatus;
  end_reason: string | null;
  current_chapter: number | null;
  completed_in_run: number;
  seq: number;
  error_message: string | null;
  started_at: string;
  updated_at: string;
}

function rowToJob(row: WritingJobRow): WritingJob {
  return {
    id: row.id,
    novelId: row.novel_id,
    status: row.status,
    endReason: row.end_reason,
    currentChapter: row.current_chapter,
    completedInRun: row.completed_in_run,
    seq: row.seq,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Open a run-history record for a writing run. MUST be called only after the
 * writing lock is acquired: it first reclaims any 'running' job left behind by a
 * crashed prior run (a process that died never reached finalize), marking it
 * 'paused'/'superseded' so the UI never shows a permanent 'running' ghost.
 */
export function createWritingJob(novelId: string): WritingJob {
  const db = getDb();
  const now = nowIso();
  const id = crypto.randomUUID();
  db.transaction(() => {
    // Reclaim a crashed prior run and insert its successor atomically: a crash
    // can leave the old job running or the new job running, never neither.
    db.prepare(
      `UPDATE writing_jobs SET status='paused', end_reason='superseded', updated_at=?
       WHERE novel_id=? AND status='running'`,
    ).run(now, novelId);
    db.prepare(
      `INSERT INTO writing_jobs (id, novel_id, status, completed_in_run, seq, started_at, updated_at)
       VALUES (?, ?, 'running', 0, 0, ?, ?)`,
    ).run(id, novelId, now, now);
  })();
  return {
    id,
    novelId,
    status: 'running',
    endReason: null,
    currentChapter: null,
    completedInRun: 0,
    seq: 0,
    errorMessage: null,
    startedAt: now,
    updatedAt: now,
  };
}

/** Advance progress after a chapter lands. Does NOT change status. */
export function bumpWritingJobProgress(id: string, currentChapter: number, seq: number): void {
  getDb()
    .prepare(
      `UPDATE writing_jobs
       SET current_chapter=?, completed_in_run=completed_in_run+1, seq=?, updated_at=?
       WHERE id=?`,
    )
    .run(currentChapter, seq, nowIso(), id);
}

/** The single terminal write. */
export function finalizeWritingJob(
  id: string,
  novelId: string,
  status: Exclude<WritingJobStatus, 'running'>,
  endReason?: string | null,
  errorMessage?: string | null,
  novelUpdate: Partial<Novel> = {},
  assistantMessage?: string,
): Novel {
  const db = getDb();
  return db.transaction(() => {
    const novel = applyNovelUpdate(db, novelId, novelUpdate);
    if (!novel) throw new Error('Novel not found while finalizing writing job');
    if (assistantMessage) {
      db.prepare(
        `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
         VALUES (?, ?, 'assistant', ?, NULL, ?)`,
      ).run(crypto.randomUUID(), novelId, assistantMessage, nowIso());
    }
    const info = db
      .prepare(
        `UPDATE writing_jobs SET status=?, end_reason=?, error_message=?, updated_at=?
         WHERE id=? AND novel_id=? AND status='running'`,
      )
      .run(status, endReason ?? null, errorMessage ?? null, nowIso(), id, novelId);
    if (info.changes !== 1) throw new Error('Writing job is missing or already terminal');
    return novel;
  })();
}

/** Most recent run for a novel (UI: "last run stopped because…"). */
export function getLatestWritingJob(novelId: string): WritingJob | null {
  const row = getDb()
    // rowid DESC tiebreaks two rows created in the same millisecond (a reclaim +
    // a fresh create) so "latest" is deterministically the newest insert.
    .prepare(
      'SELECT * FROM writing_jobs WHERE novel_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1',
    )
    .get(novelId) as WritingJobRow | undefined;
  return row ? rowToJob(row) : null;
}
