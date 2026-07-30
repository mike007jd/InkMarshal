import { getDb } from '@/lib/db/connection';

type Db = ReturnType<typeof getDb>;

type KnowledgeVaultOutboxStatus = 'pending' | 'completed' | 'dead_letter';

export interface KnowledgeVaultOutboxRow {
  entryId: string;
  novelId: string;
  operation: 'upsert' | 'delete';
  relPath: string | null;
  status: KnowledgeVaultOutboxStatus;
  intentRevision: number;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawKnowledgeVaultOutboxRow {
  entry_id: string;
  novel_id: string;
  operation: 'upsert' | 'delete';
  rel_path: string | null;
  status: KnowledgeVaultOutboxStatus;
  intent_revision: number;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawKnowledgeVaultOutboxRow): KnowledgeVaultOutboxRow {
  return {
    entryId: row.entry_id,
    novelId: row.novel_id,
    operation: row.operation,
    relPath: row.rel_path,
    status: row.status,
    intentRevision: row.intent_revision,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRawIntentByEntryId(db: Db, entryId: string): RawKnowledgeVaultOutboxRow | undefined {
  return db.prepare(
    'SELECT * FROM knowledge_vault_outbox WHERE entry_id = ?',
  ).get(entryId) as RawKnowledgeVaultOutboxRow | undefined;
}

/**
 * Enqueue/supersede an upsert intent on the caller's db handle so it can join
 * an open claim-fenced transaction with the canonical row and knowledge_index.
 * Returns the monotonic revision to CAS against after commit.
 */
export function enqueueKnowledgeVaultUpsert(
  db: Db,
  input: { entryId: string; novelId: string; relPath: string; updatedAt: string },
): number {
  db.prepare(
    `INSERT INTO knowledge_vault_outbox
       (entry_id, novel_id, operation, rel_path, status, intent_revision, attempt_count, last_error, created_at, updated_at)
     VALUES (?, ?, 'upsert', ?, 'pending', 1, 0, NULL, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       novel_id = excluded.novel_id,
       operation = 'upsert',
       rel_path = excluded.rel_path,
       status = 'pending',
       intent_revision = knowledge_vault_outbox.intent_revision + 1,
       attempt_count = 0,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(input.entryId, input.novelId, input.relPath, input.updatedAt, input.updatedAt);
  return getRawIntentByEntryId(db, input.entryId)!.intent_revision;
}

/** Enqueue/supersede a delete intent; returns the monotonic revision to CAS against. */
export function enqueueKnowledgeVaultDelete(
  db: Db,
  input: { entryId: string; novelId: string; relPath: string | null; updatedAt: string },
): number {
  db.prepare(
    `INSERT INTO knowledge_vault_outbox
       (entry_id, novel_id, operation, rel_path, status, intent_revision, attempt_count, last_error, created_at, updated_at)
     VALUES (?, ?, 'delete', ?, 'pending', 1, 0, NULL, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       novel_id = excluded.novel_id,
       operation = 'delete',
       rel_path = excluded.rel_path,
       status = 'pending',
       intent_revision = knowledge_vault_outbox.intent_revision + 1,
       attempt_count = 0,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(input.entryId, input.novelId, input.relPath, input.updatedAt, input.updatedAt);
  return getRawIntentByEntryId(db, input.entryId)!.intent_revision;
}

export function enqueueKnowledgeVaultUpsertForCurrentEntry(entryId: string): number | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT ke.novel_id, ki.path, ke.updated_at
       FROM knowledge_entries ke
       JOIN knowledge_index ki ON ki.id = ke.id
      WHERE ke.id = ?`,
  ).get(entryId) as { novel_id: string; path: string; updated_at: string } | undefined;
  if (!row) return null;
  const existing = getRawIntentByEntryId(db, entryId);
  if (
    existing?.operation === 'upsert'
    && existing.status === 'pending'
    && existing.novel_id === row.novel_id
    && existing.rel_path === row.path
  ) {
    return existing.intent_revision;
  }
  return enqueueKnowledgeVaultUpsert(db, {
    entryId,
    novelId: row.novel_id,
    relPath: row.path,
    updatedAt: row.updated_at,
  });
}

export function enqueueKnowledgeVaultDeleteIntent(input: {
  entryId: string;
  novelId: string;
  relPath: string | null;
}): number {
  const db = getDb();
  const existing = getRawIntentByEntryId(db, input.entryId);
  if (
    existing?.operation === 'delete'
    && existing.status === 'pending'
    && existing.novel_id === input.novelId
    && existing.rel_path === input.relPath
  ) {
    return existing.intent_revision;
  }
  return enqueueKnowledgeVaultDelete(db, { ...input, updatedAt: new Date().toISOString() });
}

export function getKnowledgeVaultOutboxIntent(
  novelId: string,
  entryId: string | null,
  relPath: string,
): KnowledgeVaultOutboxRow | null {
  const db = getDb();
  const row = (entryId
    ? db.prepare(
      'SELECT * FROM knowledge_vault_outbox WHERE novel_id = ? AND entry_id = ? LIMIT 1',
    ).get(novelId, entryId)
    : db.prepare(
      'SELECT * FROM knowledge_vault_outbox WHERE novel_id = ? AND rel_path = ? LIMIT 1',
    ).get(novelId, relPath)) as RawKnowledgeVaultOutboxRow | undefined;
  return row ? mapRow(row) : null;
}

export function getKnowledgeVaultOutboxRow(entryId: string): KnowledgeVaultOutboxRow | null {
  const row = getRawIntentByEntryId(getDb(), entryId);
  return row ? mapRow(row) : null;
}

/**
 * Clear an upsert intent only when it still matches the attempted revision.
 * Stale async completions must not delete a newer superseding intent.
 */
export function completeKnowledgeVaultUpsert(entryId: string, intentRevision: number): boolean {
  const result = getDb().prepare(
    `DELETE FROM knowledge_vault_outbox
      WHERE entry_id = ?
        AND operation = 'upsert'
        AND status = 'pending'
        AND intent_revision = ?`,
  ).run(entryId, intentRevision);
  return result.changes > 0;
}

/**
 * Mark a delete intent completed only when it still matches the attempted revision.
 */
export function completeKnowledgeVaultDelete(entryId: string, intentRevision: number): boolean {
  const result = getDb().prepare(
    `UPDATE knowledge_vault_outbox
        SET status = 'completed', attempt_count = 0, last_error = NULL, updated_at = ?
      WHERE entry_id = ?
        AND operation = 'delete'
        AND status = 'pending'
        AND intent_revision = ?`,
  ).run(new Date().toISOString(), entryId, intentRevision);
  return result.changes > 0;
}

/**
 * Annotate failure only when the pending intent still matches the attempted revision.
 * A stale failure must not reset attempt accounting on a newer superseding intent.
 */
export function recordKnowledgeVaultFailure(
  entryId: string,
  intentRevision: number,
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const result = getDb().prepare(
    `UPDATE knowledge_vault_outbox
        SET status = 'pending',
            attempt_count = attempt_count + 1,
            last_error = ?,
            updated_at = ?
      WHERE entry_id = ?
        AND status = 'pending'
        AND intent_revision = ?`,
  ).run(message.slice(0, 2000), new Date().toISOString(), entryId, intentRevision);
  return result.changes > 0;
}

/**
 * Pending outbox intents eligible for one drain trigger.
 * Explicit `status = 'pending'` only — never inferred from timestamps, and
 * never hidden by an attempt ceiling (each trigger attempts each eligible row once).
 */
export function listPendingKnowledgeVaultOutbox(novelId?: string): KnowledgeVaultOutboxRow[] {
  const db = getDb();
  const rows = (novelId
    ? db.prepare(
      `SELECT * FROM knowledge_vault_outbox
        WHERE novel_id = ?
          AND status = 'pending'
        ORDER BY created_at ASC, entry_id ASC`,
    ).all(novelId)
    : db.prepare(
      `SELECT * FROM knowledge_vault_outbox
        WHERE status = 'pending'
        ORDER BY created_at ASC, entry_id ASC`,
    ).all()) as RawKnowledgeVaultOutboxRow[];
  return rows.map(mapRow);
}
