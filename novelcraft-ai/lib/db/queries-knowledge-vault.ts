// Wave 2 commit C — query helpers that read the `knowledge_index` table
// (W2-B's lightweight projection of vault `.md` files) and the
// `knowledge_embeddings` BLOB store.
//
// These are the *index-time* lookups used by `lib/knowledge/recall.ts`. They
// intentionally never touch the vault filesystem — recall works off the
// SQLite mirror so a recall pass stays fast even when a vault lives on a slow
// network share. The vault remains the truth source; the index just lets us
// skip the walk on the hot path.
//
// Shape mirrors the legacy queries-knowledge module: tiny helpers, no
// business logic, no caching. Callers stitch results together.

import { getDb } from '@/lib/db/connection';
import type { KnowledgeType } from '@/lib/types/knowledge';
import type { VaultIndexRow } from '@/lib/vault/types';
import { mapKnowledgeIndexRow, type RawKnowledgeIndexRow } from '@/lib/db/queries-vault';

/** List every index row for a novel — used as the recall pool. */
export async function listKnowledgeIndexForNovel(
  novelId: string,
  type?: KnowledgeType,
): Promise<VaultIndexRow[]> {
  const db = getDb();
  const rows = (type
    ? db
        .prepare(
          'SELECT * FROM knowledge_index WHERE novel_id = ? AND type = ? ORDER BY title ASC',
        )
        .all(novelId, type)
    : db
        .prepare('SELECT * FROM knowledge_index WHERE novel_id = ? ORDER BY title ASC')
        .all(novelId)) as RawKnowledgeIndexRow[];
  return rows.map(mapKnowledgeIndexRow);
}

/**
 * Index-based candidate match. Looks up rows by exact title or alias presence,
 * then filters by type if requested. We pull a few more rows than asked for
 * (LIMIT 200) so the caller can de-dupe before scoring.
 *
 * SQLite has no array containment operator we can lean on cross-platform, so
 * aliases are resolved via JSON1's json_each — available on every SQLite
 * build shipped with better-sqlite3.
 */
export async function matchKnowledgeIndexByNames(
  novelId: string,
  names: string[],
  type?: KnowledgeType,
): Promise<VaultIndexRow[]> {
  if (names.length === 0) return [];
  const db = getDb();
  const placeholders = names.map(() => '?').join(',');
  const sql = type
    ? `SELECT DISTINCT ki.* FROM knowledge_index ki
       LEFT JOIN json_each(CASE WHEN json_valid(ki.aliases) THEN ki.aliases ELSE '[]' END) AS alias
       WHERE ki.novel_id = ?
         AND ki.type = ?
         AND (lower(ki.title) IN (${placeholders}) OR lower(CAST(alias.value AS TEXT)) IN (${placeholders}))
       LIMIT 200`
    : `SELECT DISTINCT ki.* FROM knowledge_index ki
       LEFT JOIN json_each(CASE WHEN json_valid(ki.aliases) THEN ki.aliases ELSE '[]' END) AS alias
       WHERE ki.novel_id = ?
         AND (lower(ki.title) IN (${placeholders}) OR lower(CAST(alias.value AS TEXT)) IN (${placeholders}))
       LIMIT 200`;
  const normalizedNames = names.map(name => name.toLowerCase());
  const params: unknown[] = type
    ? [novelId, type, ...normalizedNames, ...normalizedNames]
    : [novelId, ...normalizedNames, ...normalizedNames];
  const rows = db.prepare(sql).all(...params) as RawKnowledgeIndexRow[];
  return rows.map(mapKnowledgeIndexRow);
}

/**
 * Lookup timeline entries whose `data.chapterIds` array contains any of the
 * provided chapter ids. Uses JSON1 `json_each` so we don't have to manually
 * `LIKE %chapterId%` (which would false-match substrings).
 */
export async function matchTimelineByChapterIds(
  novelId: string,
  chapterIds: string[],
): Promise<VaultIndexRow[]> {
  if (chapterIds.length === 0) return [];
  const db = getDb();
  const placeholders = chapterIds.map(() => '?').join(',');
  const sql = `SELECT DISTINCT ki.* FROM knowledge_index ki, json_each(CASE WHEN json_valid(ki.data) THEN ki.data ELSE '{}' END, '$.chapterIds') AS cid
     WHERE ki.novel_id = ?
       AND ki.type = 'timeline'
       AND cid.value IN (${placeholders})
     LIMIT 100`;
  try {
    const rows = db.prepare(sql).all(novelId, ...chapterIds) as RawKnowledgeIndexRow[];
    return rows.map(mapKnowledgeIndexRow);
  } catch {
    return [];
  }
}

/**
 * Lookup timeline entries that *mention* the given chapter number — used when
 * we have a chapterNumber but no resolved chapter id (which is the common case
 * during draft-time recall: the chapter row may not exist yet).
 *
 * The canonical table seeded `data.chapterIds` as ['ch-{number}'] in many demos;
 * this is just a best-effort by-number fallback. Real chapter ids are checked
 * first by {@link matchTimelineByChapterIds}.
 */
export async function matchTimelineByChapterNumber(
  novelId: string,
  chapterNumber: number,
): Promise<VaultIndexRow[]> {
  const db = getDb();
  const sql = `SELECT DISTINCT ki.* FROM knowledge_index ki
     LEFT JOIN json_each(CASE WHEN json_valid(ki.data) THEN ki.data ELSE '{}' END, '$.chapterIds') AS cid
     WHERE ki.novel_id = ?
       AND ki.type = 'timeline'
       AND (
        json_extract(CASE WHEN json_valid(ki.data) THEN ki.data ELSE '{}' END, '$.chapterNumber') = ?
        OR cid.value = ?
        OR cid.value = ?
        OR cid.value = ?
       )
     LIMIT 100`;
  try {
    const rows = db
      .prepare(sql)
      .all(
        novelId,
        chapterNumber,
        chapterNumber,
        String(chapterNumber),
        `ch-${chapterNumber}`,
      ) as RawKnowledgeIndexRow[];
    return rows.map(mapKnowledgeIndexRow);
  } catch {
    return [];
  }
}

/** Fetch a single index row by entry id. */
export async function getKnowledgeIndexById(id: string): Promise<VaultIndexRow | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM knowledge_index WHERE id = ?').get(id) as
    | RawKnowledgeIndexRow
    | undefined;
  return row ? mapKnowledgeIndexRow(row) : null;
}

/** Look up the outline entry whose frontmatter `chapterNumber == n`. */
export async function getOutlineIndexForChapter(
  novelId: string,
  chapterNumber: number,
): Promise<VaultIndexRow | null> {
  const db = getDb();
  const sql = `SELECT * FROM knowledge_index
       WHERE novel_id = ? AND type = 'outline'
         AND (
          json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.chapterNumber') = ?
          OR json_extract(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.chapterNumber') = ?
         )
       LIMIT 1`;
  try {
    const row = db
      .prepare(sql)
      .get(novelId, chapterNumber, String(chapterNumber)) as RawKnowledgeIndexRow | undefined;
    return row ? mapKnowledgeIndexRow(row) : null;
  } catch {
    return null;
  }
}

// ── knowledge_embeddings CRUD ─────────────────────────────────────────────

export interface KnowledgeEmbeddingRow {
  id: string;
  novelId: string;
  modelId: string;
  dim: number;
  vector: Float32Array;
  contentHash: string;
  updatedAt: string;
}

export async function upsertKnowledgeEmbedding(row: {
  id: string;
  novelId: string;
  modelId: string;
  dim: number;
  vector: Float32Array;
  contentHash: string;
  updatedAt: string;
}): Promise<void> {
  const db = getDb();
  const buffer = Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
  db.prepare(
    `INSERT INTO knowledge_embeddings (id, novel_id, model_id, dim, vector, content_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       model_id     = excluded.model_id,
       dim          = excluded.dim,
       vector       = excluded.vector,
       content_hash = excluded.content_hash,
       updated_at   = excluded.updated_at`,
  ).run(row.id, row.novelId, row.modelId, row.dim, buffer, row.contentHash, row.updatedAt);
}

export async function getKnowledgeEmbedding(id: string): Promise<KnowledgeEmbeddingRow | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM knowledge_embeddings WHERE id = ?').get(id) as
    | {
        id: string;
        novel_id: string;
        model_id: string;
        dim: number;
        vector: Buffer | Uint8Array;
        content_hash: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  const vector = decodeKnowledgeEmbeddingVector(row.vector, row.dim);
  if (!vector) return null;
  return {
    id: row.id,
    novelId: row.novel_id,
    modelId: row.model_id,
    dim: row.dim,
    // Copy so callers don't mutate the underlying Buffer (which may be reused by SQLite).
    vector,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  };
}

export async function listKnowledgeEmbeddings(novelId: string): Promise<KnowledgeEmbeddingRow[]> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM knowledge_embeddings WHERE novel_id = ?')
    .all(novelId) as {
    id: string;
    novel_id: string;
    model_id: string;
    dim: number;
    vector: Buffer | Uint8Array;
    content_hash: string;
    updated_at: string;
  }[];
  const decoded: KnowledgeEmbeddingRow[] = [];
  for (const r of rows) {
    const vector = decodeKnowledgeEmbeddingVector(r.vector, r.dim);
    if (!vector) continue;
    decoded.push({
      id: r.id,
      novelId: r.novel_id,
      modelId: r.model_id,
      dim: r.dim,
      vector,
      contentHash: r.content_hash,
      updatedAt: r.updated_at,
    });
  }
  return decoded;
}

/**
 * Cheap aggregate over a novel's embedding rows — `COUNT(*)` plus the latest
 * `updated_at`. Used as a cache-validity probe so callers can skip the full
 * BLOB read + Float32 decode of {@link listKnowledgeEmbeddings} when nothing
 * has changed. Returns `count: 0` (and empty `maxUpdatedAt`) for an empty set.
 */
export async function getKnowledgeEmbeddingStats(
  novelId: string,
): Promise<{ count: number; maxUpdatedAt: string }> {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT COUNT(*) AS count, MAX(updated_at) AS maxUpdatedAt FROM knowledge_embeddings WHERE novel_id = ?',
    )
    .get(novelId) as { count: number; maxUpdatedAt: string | null } | undefined;
  return {
    count: row?.count ?? 0,
    maxUpdatedAt: row?.maxUpdatedAt ?? '',
  };
}

function decodeKnowledgeEmbeddingVector(
  raw: Buffer | Uint8Array,
  dim: number,
): Float32Array | null {
  const buf = raw instanceof Buffer ? raw : Buffer.from(raw);
  if (buf.byteLength === 0 || buf.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    console.warn('[knowledge-embedding] skipping malformed vector blob', {
      byteLength: buf.byteLength,
      dim,
    });
    return null;
  }
  const vector = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
  if (Number.isFinite(dim) && dim > 0 && vector.length !== dim) {
    console.warn('[knowledge-embedding] skipping vector with mismatched dimension', {
      byteLength: buf.byteLength,
      dim,
      actualDim: vector.length,
    });
    return null;
  }
  return new Float32Array(vector);
}

export async function deleteKnowledgeEmbedding(id: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM knowledge_embeddings WHERE id = ?').run(id);
}
