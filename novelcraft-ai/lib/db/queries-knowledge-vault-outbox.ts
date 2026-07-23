import { getDb } from '@/lib/db/connection';

type Db = ReturnType<typeof getDb>;

export interface KnowledgeVaultOutboxRow {
  entryId: string;
  novelId: string;
  operation: 'upsert' | 'delete';
  relPath: string | null;
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

export function enqueueKnowledgeVaultUpsert(
  db: Db,
  input: { entryId: string; novelId: string; relPath: string; updatedAt: string },
): void {
  db.prepare(
    `INSERT INTO knowledge_vault_outbox
       (entry_id, novel_id, operation, rel_path, attempt_count, last_error, created_at, updated_at)
     VALUES (?, ?, 'upsert', ?, 0, NULL, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       novel_id = excluded.novel_id,
       operation = 'upsert',
       rel_path = excluded.rel_path,
       attempt_count = 0,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(input.entryId, input.novelId, input.relPath, input.updatedAt, input.updatedAt);
}

export function enqueueKnowledgeVaultDelete(
  db: Db,
  input: { entryId: string; novelId: string; relPath: string | null; updatedAt: string },
): void {
  db.prepare(
    `INSERT INTO knowledge_vault_outbox
       (entry_id, novel_id, operation, rel_path, attempt_count, last_error, created_at, updated_at)
     VALUES (?, ?, 'delete', ?, 0, NULL, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       novel_id = excluded.novel_id,
       operation = 'delete',
       rel_path = excluded.rel_path,
       attempt_count = 0,
       last_error = NULL,
       updated_at = excluded.updated_at`,
  ).run(input.entryId, input.novelId, input.relPath, input.updatedAt, input.updatedAt);
}

export function enqueueKnowledgeVaultUpsertForCurrentEntry(entryId: string): void {
  const db = getDb();
  const row = db.prepare(
    `SELECT ke.novel_id, ki.path, ke.updated_at
       FROM knowledge_entries ke
       JOIN knowledge_index ki ON ki.id = ke.id
      WHERE ke.id = ?`,
  ).get(entryId) as { novel_id: string; path: string; updated_at: string } | undefined;
  if (!row) return;
  const existing = getRawIntentByEntryId(db, entryId);
  if (
    existing?.operation === 'upsert'
    && existing.novel_id === row.novel_id
    && existing.rel_path === row.path
  ) return;
  enqueueKnowledgeVaultUpsert(db, {
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
}): void {
  const db = getDb();
  const existing = getRawIntentByEntryId(db, input.entryId);
  if (
    existing?.operation === 'delete'
    && existing.novel_id === input.novelId
    && existing.rel_path === input.relPath
  ) return;
  enqueueKnowledgeVaultDelete(db, { ...input, updatedAt: new Date().toISOString() });
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

export function completeKnowledgeVaultUpsert(entryId: string): void {
  getDb().prepare(
    "DELETE FROM knowledge_vault_outbox WHERE entry_id = ? AND operation = 'upsert'",
  ).run(entryId);
}

export function completeKnowledgeVaultDelete(entryId: string): void {
  getDb().prepare(
    `UPDATE knowledge_vault_outbox
        SET attempt_count = 0, last_error = NULL, updated_at = ?
      WHERE entry_id = ? AND operation = 'delete'`,
  ).run(new Date().toISOString(), entryId);
}

export function recordKnowledgeVaultFailure(entryId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  getDb().prepare(
    `UPDATE knowledge_vault_outbox
        SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
      WHERE entry_id = ?`,
  ).run(message.slice(0, 2000), new Date().toISOString(), entryId);
}
