// Wave 2 commit B — SQLite query layer for the per-novel vault state
// (vault_path, vault_version) and the new `knowledge_index` / `knowledge_embeddings`
// tables.
//
// These helpers are intentionally small and additive: the legacy Novel queries
// keep working unchanged, and the vault columns are only touched through this
// module. That way W2-C can swap recall to read `knowledge_index` without
// having to refactor anything else.

import path from 'node:path';
import { realpathSync } from 'node:fs';

import { getDb } from '@/lib/db/connection';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';
import type { NovelVaultRow, VaultIndexRow } from '@/lib/vault/types';

export async function getNovelVault(novelId: string): Promise<NovelVaultRow | null> {
  const db = getDb();
  const row = db
    .prepare('SELECT vault_path, vault_version FROM novels WHERE id = ?')
    .get(novelId) as { vault_path: string | null; vault_version: number } | undefined;
  if (!row) return null;
  return {
    vaultPath: row.vault_path,
    vaultVersion: row.vault_version,
  };
}

export async function isVaultPathReferencedElsewhere(
  novelId: string,
  vaultPath: string,
): Promise<boolean> {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    try {
      return realpathSync(resolved);
    } catch {
      try {
        return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
      } catch {
        return resolved;
      }
    }
  };
  const target = normalize(vaultPath);
  const rows = getDb().prepare(
    `SELECT vault_path FROM novels WHERE id <> ? AND vault_path IS NOT NULL
     UNION ALL
     SELECT vault_path FROM series WHERE vault_path IS NOT NULL`,
  ).all(novelId) as Array<{ vault_path: string }>;
  return rows.some(row => normalize(row.vault_path) === target);
}

export async function setNovelVaultPath(
  novelId: string,
  vaultPath: string,
  vaultVersion?: number,
): Promise<void> {
  const db = getDb();
  if (typeof vaultVersion === 'number') {
    db.prepare('UPDATE novels SET vault_path = ?, vault_version = ?, updated_at = ? WHERE id = ?')
      .run(vaultPath, vaultVersion, new Date().toISOString(), novelId);
  } else {
    db.prepare('UPDATE novels SET vault_path = ?, updated_at = ? WHERE id = ?')
      .run(vaultPath, new Date().toISOString(), novelId);
  }
}

/**
 * The absolute value is a durable transition generation. Pending roots store
 * it as negative; established roots store it as positive. Advancing from
 * either state therefore cannot reuse an older B→C→B bootstrap token.
 */
export function nextVaultTransitionToken(currentVersion: number): number {
  if (!Number.isSafeInteger(currentVersion)) {
    throw new Error('Invalid Vault transition generation');
  }
  const nextGeneration = Math.abs(currentVersion) + 1;
  if (!Number.isSafeInteger(nextGeneration)) {
    throw new Error('Vault transition generation exhausted');
  }
  return -nextGeneration;
}

export function isVaultRootPending(vaultVersion: number): boolean {
  return vaultVersion <= 0;
}

/**
 * Atomically bind or rebind a novel Vault root and allocate a pending
 * transition token. Same established root is a no-op; same pending root
 * keeps its token.
 */
export async function bindNovelVaultRoot(
  novelId: string,
  vaultPath: string,
): Promise<NovelVaultRow> {
  const db = getDb();
  const now = new Date().toISOString();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT vault_path, vault_version FROM novels WHERE id = ?')
      .get(novelId) as { vault_path: string | null; vault_version: number } | undefined;
    if (!row) {
      throw new Error(`Novel not found: ${novelId}`);
    }
    if (row.vault_path === vaultPath) {
      return {
        vaultPath,
        vaultVersion: row.vault_version,
      };
    }
    const token = nextVaultTransitionToken(row.vault_version);
    db.prepare(
      'UPDATE novels SET vault_path = ?, vault_version = ?, updated_at = ? WHERE id = ?',
    ).run(vaultPath, token, now, novelId);
    return { vaultPath, vaultVersion: token };
  })();
}

/**
 * Promote one exact pending Vault root (path + transition token) while
 * retaining its generation. Never restores a stale path.
 */
export async function establishNovelVaultPath(
  novelId: string,
  expectedVaultPath: string,
  expectedToken: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(expectedToken) || expectedToken >= 0) return false;
  const establishedVersion = Math.abs(expectedToken);
  const result = getDb().prepare(
    `UPDATE novels
        SET vault_version = ?, updated_at = ?
      WHERE id = ?
        AND vault_path = ?
        AND vault_version = ?`,
  ).run(
    establishedVersion,
    new Date().toISOString(),
    novelId,
    expectedVaultPath,
    expectedToken,
  );
  return result.changes > 0;
}

export async function clearNovelVaultPath(novelId: string): Promise<void> {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare('SELECT vault_version FROM novels WHERE id = ?')
      .get(novelId) as { vault_version: number } | undefined;
    if (!row) throw new Error(`Novel not found: ${novelId}`);
    const clearedGeneration = Math.abs(nextVaultTransitionToken(row.vault_version));
    db.prepare(
      'UPDATE novels SET vault_path = NULL, vault_version = ?, updated_at = ? WHERE id = ?',
    ).run(clearedGeneration, new Date().toISOString(), novelId);
  })();
}

// --- knowledge_index helpers ----------------------------------------------

export interface KnowledgeIndexInsert {
  id: string;
  novelId: string;
  type: string;
  path: string;
  title: string;
  tags: string;
  aliases: string;
  importance: string | null;
  data: string;
  outgoingLinks: string;
  contentHash: string;
  updatedAt: string;
}

export interface VaultKnowledgeEntryInsert {
  id: string;
  novelId: string;
  type: string;
  title: string;
  summary: string;
  data: string;
  sortOrder: number;
  tags: string;
  createdAt: string;
  updatedAt: string;
}

// Single source for the knowledge_index upsert. The same INSERT … ON CONFLICT
// statement + its 12-param binding were copied 7× across queries-knowledge,
// queries-vault, and queries-novel; a column reorder would have to be made in
// all of them. `db.prepare` caches by SQL, so this is just as efficient inside a
// transaction as a hoisted prepared statement.
export const KNOWLEDGE_INDEX_UPSERT_SQL =
  `INSERT INTO knowledge_index
     (id, novel_id, type, path, title, tags, aliases, importance, data, outgoing_links, content_hash, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     type = excluded.type,
     path = excluded.path,
     title = excluded.title,
     tags = excluded.tags,
     aliases = excluded.aliases,
     importance = excluded.importance,
     data = excluded.data,
     outgoing_links = excluded.outgoing_links,
     content_hash = excluded.content_hash,
     updated_at = excluded.updated_at`;

/** Positional bind values for {@link KNOWLEDGE_INDEX_UPSERT_SQL}, in column order. */
export function knowledgeIndexParams(index: KnowledgeIndexInsert): unknown[] {
  return [
    index.id,
    index.novelId,
    index.type,
    index.path,
    index.title,
    index.tags,
    index.aliases,
    index.importance,
    index.data,
    index.outgoingLinks,
    index.contentHash,
    index.updatedAt,
  ];
}

/** Upsert a knowledge_index row using the given db handle (transaction-safe). */
export function upsertKnowledgeIndex(db: ReturnType<typeof getDb>, index: KnowledgeIndexInsert): void {
  db.prepare(KNOWLEDGE_INDEX_UPSERT_SQL).run(...knowledgeIndexParams(index));
}

/**
 * A knowledge entry `id` that the caller wants to project into one novel is
 * already owned by a *different* novel. The `ON CONFLICT(id) ... WHERE
 * novel_id = excluded.novel_id` clause below would silently no-op the insert
 * while the index/`touchNovelUpdatedAt` writes still ran — leaving a
 * knowledge_index row pointing at an entry that does not exist in this novel.
 * Cross-novel id reuse is realistic (copying a Vault, importing a project,
 * hand-editing markdown frontmatter ids), so we surface it as a typed error
 * the sync layer can fold into its skipped/report path instead of a silent
 * projection desync. (`reconcileVaultChangedFiles` already pre-skips this
 * case; this guard is the invariant for any future caller.)
 */
export class KnowledgeEntryIdCollisionError extends Error {
  constructor(
    readonly id: string,
    readonly existingNovelId: string,
    readonly attemptedNovelId: string,
  ) {
    super(
      `Knowledge entry id "${id}" already belongs to novel "${existingNovelId}"; ` +
        `refusing to project it into novel "${attemptedNovelId}".`,
    );
    this.name = 'KnowledgeEntryIdCollisionError';
  }
}

export async function replaceVaultKnowledgeProjection(row: {
  previousId?: string;
  entry: VaultKnowledgeEntryInsert;
  index: KnowledgeIndexInsert;
  cleanupUpdates?: { id: string; data: string; updatedAt: string; index: KnowledgeIndexInsert }[];
}): Promise<void> {
  const db = getDb();
  const idOwner = db.prepare('SELECT novel_id FROM knowledge_entries WHERE id = ?');
  const insertEntry = db.prepare(
    `INSERT INTO knowledge_entries (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       title = excluded.title,
       summary = excluded.summary,
       data = excluded.data,
       tags = excluded.tags,
       updated_at = excluded.updated_at
     WHERE knowledge_entries.novel_id = excluded.novel_id`,
  );
  const deleteEntry = db.prepare('DELETE FROM knowledge_entries WHERE id = ?');
  const deleteIndex = db.prepare('DELETE FROM knowledge_index WHERE id = ?');
  const deleteEmbedding = db.prepare('DELETE FROM knowledge_embeddings WHERE id = ?');
  const updateCleanup = db.prepare(
    'UPDATE knowledge_entries SET data = ?, updated_at = ? WHERE id = ?',
  );

  const tx = db.transaction(() => {
    // Fail fast (and roll back) before any write if this id is owned elsewhere.
    const owner = idOwner.get(row.entry.id) as { novel_id: string } | undefined;
    if (owner && owner.novel_id !== row.entry.novelId) {
      throw new KnowledgeEntryIdCollisionError(row.entry.id, owner.novel_id, row.entry.novelId);
    }
    for (const update of row.cleanupUpdates ?? []) {
      updateCleanup.run(update.data, update.updatedAt, update.id);
      upsertKnowledgeIndex(db, update.index);
      deleteEmbedding.run(update.id);
    }
    if (row.previousId && row.previousId !== row.entry.id) {
      deleteEmbedding.run(row.previousId);
      deleteIndex.run(row.previousId);
      deleteEntry.run(row.previousId);
    }
    insertEntry.run(
      row.entry.id,
      row.entry.novelId,
      row.entry.type,
      row.entry.title,
      row.entry.summary,
      row.entry.data,
      row.entry.sortOrder,
      row.entry.tags,
      row.entry.createdAt,
      row.entry.updatedAt,
    );
    upsertKnowledgeIndex(db, row.index);
    // The projection and its derived vector are one consistency boundary.
    // Delete the old vector inside this transaction so a crash can never leave
    // an embedding whose content_hash describes the previous Vault contents.
    deleteEmbedding.run(row.entry.id);
    touchNovelUpdatedAt(db, row.entry.novelId);
  });
  tx();
}

export async function upsertKnowledgeIndexRow(row: KnowledgeIndexInsert): Promise<void> {
  upsertKnowledgeIndex(getDb(), row);
}

export async function deleteKnowledgeIndexRow(id: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM knowledge_index WHERE id = ?').run(id);
}

export interface RawKnowledgeIndexRow {
  id: string;
  novel_id: string;
  type: string;
  path: string;
  title: string;
  tags: string;
  aliases: string;
  importance: string | null;
  data: string;
  outgoing_links: string;
  content_hash: string;
  mirror_content_hash?: string | null;
  updated_at: string;
}

export async function getKnowledgeIndexRowByPath(
  novelId: string,
  path: string,
): Promise<VaultIndexRow | null> {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM knowledge_index WHERE novel_id = ? AND path = ?')
    .get(novelId, path) as RawKnowledgeIndexRow | undefined;
  return row ? mapKnowledgeIndexRow(row) : null;
}

// --- JSON helpers ----------------------------------------------------------

export function safeJsonArray<T = string>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function safeJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mapKnowledgeIndexRow(r: RawKnowledgeIndexRow): VaultIndexRow {
  return {
    id: r.id,
    novelId: r.novel_id,
    type: r.type as VaultIndexRow['type'],
    path: r.path,
    title: r.title,
    tags: safeJsonArray(r.tags),
    aliases: safeJsonArray(r.aliases),
    importance: (r.importance as VaultIndexRow['importance']) ?? null,
    data: safeJsonObject(r.data),
    outgoingLinks: safeJsonArray(r.outgoing_links),
    contentHash: r.content_hash,
    mirrorContentHash: typeof r.mirror_content_hash === 'string' && r.mirror_content_hash.length > 0
      ? r.mirror_content_hash
      : null,
    updatedAt: r.updated_at,
  };
}

/** Persist the last observed/written Vault Markdown SHA-256 for conditional replace. */
export function setKnowledgeIndexMirrorContentHash(entryId: string, contentHash: string): void {
  getDb().prepare(
    'UPDATE knowledge_index SET mirror_content_hash = ? WHERE id = ?',
  ).run(contentHash, entryId);
}
