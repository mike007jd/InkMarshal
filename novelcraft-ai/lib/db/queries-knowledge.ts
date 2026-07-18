import { getDb } from '@/lib/db/connection';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';
import { nowIso } from '@/lib/utils';
import { upsertKnowledgeIndex, type KnowledgeIndexInsert } from '@/lib/db/queries-vault';
import { SAFE_DATA_JSON } from '@/lib/db/json-columns';

// `ke.`-aliased variant of SAFE_DATA_JSON (see json-columns.ts) for JOINs where
// the knowledge table is aliased `ke`.
const SAFE_KE_DATA_JSON = "CASE WHEN json_valid(ke.data) THEN ke.data ELSE '{}' END";

export interface KnowledgeEntryRow {
  id: string;
  novel_id: string;
  /** W3-3: non-null when this entry is shared across a series (the series id);
   *  NULL for a private/standalone entry. Present on `SELECT *` reads after the
   *  0017 migration adds the column; older callers ignore it. */
  series_id?: string | null;
  type: string;
  title: string;
  summary: string;
  data: string;
  sort_order: number;
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeRelationRow {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  label: string;
  created_at: string;
}

export async function getKnowledgeEntries(
  novelId: string,
  opts?: { type?: string; search?: string },
): Promise<KnowledgeEntryRow[]> {
  const db = getDb();
  let sql = 'SELECT * FROM knowledge_entries WHERE novel_id = ?';
  const params: unknown[] = [novelId];

  if (opts?.type) {
    sql += ' AND type = ?';
    params.push(opts.type);
  }
  if (opts?.search) {
    const like = `%${opts.search}%`;
    sql += ' AND (title LIKE ? OR summary LIKE ?)';
    params.push(like, like);
  }
  sql += ' ORDER BY sort_order ASC, updated_at DESC';

  return db.prepare(sql).all(...params) as KnowledgeEntryRow[];
}

export async function getKnowledgeEntry(
  id: string,
  novelId: string,
): Promise<KnowledgeEntryRow | undefined> {
  const db = getDb();
  return db
    .prepare('SELECT * FROM knowledge_entries WHERE id = ? AND novel_id = ?')
    .get(id, novelId) as KnowledgeEntryRow | undefined;
}

export async function getKnowledgeEntryById(id: string): Promise<KnowledgeEntryRow | undefined> {
  const db = getDb();
  return db
    .prepare('SELECT * FROM knowledge_entries WHERE id = ?')
    .get(id) as KnowledgeEntryRow | undefined;
}

export async function createKnowledgeEntry(data: {
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
}): Promise<KnowledgeEntryRow> {
  const db = getDb();
  db.prepare(
    `INSERT INTO knowledge_entries (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.novelId,
    data.type,
    data.title,
    data.summary,
    data.data,
    data.sortOrder,
    data.tags,
    data.createdAt,
    data.updatedAt,
  );
  touchNovelUpdatedAt(db, data.novelId);
  return db
    .prepare('SELECT * FROM knowledge_entries WHERE id = ?')
    .get(data.id) as KnowledgeEntryRow;
}

export async function createKnowledgeEntryWithIndex(
  data: {
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
  },
  index: KnowledgeIndexInsert,
): Promise<KnowledgeEntryRow> {
  const db = getDb();
  const insertEntry = db.prepare(
    `INSERT INTO knowledge_entries (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    insertEntry.run(
      data.id,
      data.novelId,
      data.type,
      data.title,
      data.summary,
      data.data,
      data.sortOrder,
      data.tags,
      data.createdAt,
      data.updatedAt,
    );
    upsertKnowledgeIndex(db, index);
    touchNovelUpdatedAt(db, data.novelId);
  });
  tx();
  return db
    .prepare('SELECT * FROM knowledge_entries WHERE id = ?')
    .get(data.id) as KnowledgeEntryRow;
}

export async function updateKnowledgeEntry(
  id: string,
  fields: {
    title?: string;
    type?: string;
    summary?: string;
    data?: string;
    tags?: string;
    updatedAt: string;
  },
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare('SELECT novel_id FROM knowledge_entries WHERE id = ?')
    .get(id) as { novel_id: string } | undefined;
  const setParts: string[] = ['updated_at = ?'];
  const values: unknown[] = [fields.updatedAt];

  if (fields.title !== undefined) { setParts.push('title = ?'); values.push(fields.title); }
  if (fields.type !== undefined) { setParts.push('type = ?'); values.push(fields.type); }
  if (fields.summary !== undefined) { setParts.push('summary = ?'); values.push(fields.summary); }
  if (fields.data !== undefined) { setParts.push('data = ?'); values.push(fields.data); }
  if (fields.tags !== undefined) { setParts.push('tags = ?'); values.push(fields.tags); }

  values.push(id);
  const info = db.prepare(`UPDATE knowledge_entries SET ${setParts.join(', ')} WHERE id = ?`).run(...values);
  if (info.changes > 0 && row) touchNovelUpdatedAt(db, row.novel_id);
}

export async function updateKnowledgeEntryWithIndex(
  id: string,
  fields: {
    title?: string;
    type?: string;
    summary?: string;
    data?: string;
    tags?: string;
    updatedAt: string;
  },
  index: KnowledgeIndexInsert,
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare('SELECT novel_id FROM knowledge_entries WHERE id = ?')
    .get(id) as { novel_id: string } | undefined;
  const setParts: string[] = ['updated_at = ?'];
  const values: unknown[] = [fields.updatedAt];

  if (fields.title !== undefined) { setParts.push('title = ?'); values.push(fields.title); }
  if (fields.type !== undefined) { setParts.push('type = ?'); values.push(fields.type); }
  if (fields.summary !== undefined) { setParts.push('summary = ?'); values.push(fields.summary); }
  if (fields.data !== undefined) { setParts.push('data = ?'); values.push(fields.data); }
  if (fields.tags !== undefined) { setParts.push('tags = ?'); values.push(fields.tags); }

  const updateEntry = db.prepare(`UPDATE knowledge_entries SET ${setParts.join(', ')} WHERE id = ?`);
  const tx = db.transaction(() => {
    const info = updateEntry.run(...values, id);
    if (info.changes > 0 && row) {
      upsertKnowledgeIndex(db, index);
      touchNovelUpdatedAt(db, row.novel_id);
    }
  });
  tx();
}

export async function deleteKnowledgeEntry(
  id: string,
  cleanupUpdates: { id: string; data: string; updatedAt: string; index: KnowledgeIndexInsert }[] = [],
  sourceIndexUpdates: KnowledgeIndexInsert[] = [],
): Promise<void> {
  const db = getDb();
  const row = db
    .prepare('SELECT novel_id FROM knowledge_entries WHERE id = ?')
    .get(id) as { novel_id: string } | undefined;
  const updateCleanup = db.prepare(
    'UPDATE knowledge_entries SET data = ?, updated_at = ? WHERE id = ?',
  );
  const deleteIndex = db.prepare('DELETE FROM knowledge_index WHERE id = ?');
  const deleteEntry = db.prepare('DELETE FROM knowledge_entries WHERE id = ?');
  const tx = db.transaction(() => {
    for (const update of cleanupUpdates) {
      updateCleanup.run(update.data, update.updatedAt, update.id);
      upsertKnowledgeIndex(db, update.index);
    }
    for (const index of sourceIndexUpdates) {
      upsertKnowledgeIndex(db, index);
    }
    deleteIndex.run(id);
    const info = deleteEntry.run(id);
    if (info.changes > 0 && row) touchNovelUpdatedAt(db, row.novel_id);
  });
  tx();
}

export async function getKnowledgeEntriesByNovel(novelId: string): Promise<KnowledgeEntryRow[]> {
  const db = getDb();
  return db
    .prepare('SELECT * FROM knowledge_entries WHERE novel_id = ?')
    .all(novelId) as KnowledgeEntryRow[];
}

export async function getKnowledgeEntryIdsByNovel(novelId: string): Promise<string[]> {
  const db = getDb();
  const rows = db
    .prepare('SELECT id FROM knowledge_entries WHERE novel_id = ?')
    .all(novelId) as { id: string }[];
  return rows.map(r => r.id);
}

export async function getKnowledgeRelationsByNovel(novelId: string): Promise<KnowledgeRelationRow[]> {
  const db = getDb();
  // Indexed JOIN on novel_id instead of loading every entry id into JS and
  // building a duplicated `IN (?,?…)` list. Source-side ownership: a relation is
  // returned for the novel that owns its SOURCE entry. For standalone novels both
  // endpoints share a novel (original same-novel invariant) so this is exact.
  // After W3-3, the same-SCOPE trigger also permits relations between shared
  // entries anchored on different member novels; such a cross-anchor relation is
  // deliberately owned by its source novel here (the full series graph is queried
  // by series scope in the series workspace, and source-side ownership keeps the
  // per-novel result self-contained for backup referential integrity). (D9)
  return db
    .prepare(
      `SELECT kr.* FROM knowledge_relations kr
         JOIN knowledge_entries src ON src.id = kr.source_id
        WHERE src.novel_id = ?`,
    )
    .all(novelId) as KnowledgeRelationRow[];
}

export async function getKnowledgeRelationsByEntry(entryId: string): Promise<KnowledgeRelationRow[]> {
  const db = getDb();
  return db
    .prepare('SELECT * FROM knowledge_relations WHERE source_id = ? OR target_id = ?')
    .all(entryId, entryId) as KnowledgeRelationRow[];
}

export async function createKnowledgeRelation(data: {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  label: string;
  createdAt: string;
}): Promise<KnowledgeRelationRow> {
  const db = getDb();
  const source = db
    .prepare('SELECT novel_id FROM knowledge_entries WHERE id = ?')
    .get(data.sourceId) as { novel_id: string } | undefined;
  db.prepare(
    `INSERT INTO knowledge_relations (id, source_id, target_id, relation_type, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(data.id, data.sourceId, data.targetId, data.relationType, data.label, data.createdAt);
  if (source) touchNovelUpdatedAt(db, source.novel_id);
  return db
    .prepare('SELECT * FROM knowledge_relations WHERE id = ?')
    .get(data.id) as KnowledgeRelationRow;
}

export async function createKnowledgeRelationWithSourceIndex(
  data: {
    id: string;
    sourceId: string;
    targetId: string;
    relationType: string;
    label: string;
    createdAt: string;
  },
  sourceIndex: KnowledgeIndexInsert,
): Promise<KnowledgeRelationRow> {
  const db = getDb();
  const source = db
    .prepare('SELECT novel_id FROM knowledge_entries WHERE id = ?')
    .get(data.sourceId) as { novel_id: string } | undefined;
  const insertRelation = db.prepare(
    `INSERT INTO knowledge_relations (id, source_id, target_id, relation_type, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    insertRelation.run(data.id, data.sourceId, data.targetId, data.relationType, data.label, data.createdAt);
    upsertKnowledgeIndex(db, sourceIndex);
    if (source) touchNovelUpdatedAt(db, source.novel_id);
  });
  tx();
  return db
    .prepare('SELECT * FROM knowledge_relations WHERE id = ?')
    .get(data.id) as KnowledgeRelationRow;
}

/**
 * KN-01: apply a whole relation-drafts sync for one source entry — all deletes,
 * all creates, and the rebuilt source index — in a SINGLE transaction. Replaces
 * the previous per-relation delete/create round-trips, which could leave the
 * relation set partially updated if any create failed midway. `sourceIndex` is
 * pre-projected from the intended final relation set by the caller so nothing
 * async runs inside the (synchronous) transaction.
 */
export async function syncKnowledgeRelationsForSource(
  sourceNovelId: string,
  deleteIds: string[],
  creates: {
    id: string;
    sourceId: string;
    targetId: string;
    relationType: string;
    label: string;
    createdAt: string;
  }[],
  sourceIndex: KnowledgeIndexInsert,
): Promise<void> {
  const db = getDb();
  const deleteRelation = db.prepare('DELETE FROM knowledge_relations WHERE id = ?');
  const insertRelation = db.prepare(
    `INSERT INTO knowledge_relations (id, source_id, target_id, relation_type, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const id of deleteIds) deleteRelation.run(id);
    for (const c of creates) {
      insertRelation.run(c.id, c.sourceId, c.targetId, c.relationType, c.label, c.createdAt);
    }
    upsertKnowledgeIndex(db, sourceIndex);
    touchNovelUpdatedAt(db, sourceNovelId);
  });
  tx();
}

export async function deleteKnowledgeRelation(id: string): Promise<void> {
  const db = getDb();
  const rel = db
    .prepare(
      `SELECT ke.novel_id
         FROM knowledge_relations kr
         JOIN knowledge_entries ke ON ke.id = kr.source_id
        WHERE kr.id = ?`,
    )
    .get(id) as { novel_id: string } | undefined;
  const info = db.prepare('DELETE FROM knowledge_relations WHERE id = ?').run(id);
  if (info.changes > 0 && rel) touchNovelUpdatedAt(db, rel.novel_id);
}

export async function deleteKnowledgeRelationWithSourceIndex(
  id: string,
  sourceIndex: KnowledgeIndexInsert,
): Promise<void> {
  const db = getDb();
  const rel = db
    .prepare(
      `SELECT ke.novel_id
         FROM knowledge_relations kr
         JOIN knowledge_entries ke ON ke.id = kr.source_id
        WHERE kr.id = ?`,
    )
    .get(id) as { novel_id: string } | undefined;
  const deleteRelation = db.prepare('DELETE FROM knowledge_relations WHERE id = ?');
  const tx = db.transaction(() => {
    const info = deleteRelation.run(id);
    if (info.changes > 0 && rel) {
      upsertKnowledgeIndex(db, sourceIndex);
      touchNovelUpdatedAt(db, rel.novel_id);
    }
  });
  tx();
}

export async function getKnowledgeRelationById(id: string): Promise<KnowledgeRelationRow | undefined> {
  const db = getDb();
  return db
    .prepare('SELECT * FROM knowledge_relations WHERE id = ?')
    .get(id) as KnowledgeRelationRow | undefined;
}

/**
 * Reorder outline entries in one atomic transaction.
 *
 * Behaviour (post-W2-D):
 *   - `sort_order` is always rewritten to match `orderedEntryIds.indexOf(id)`.
 *   - When `opts.syncChapterNumbers !== false` (default true) we also rewrite
 *     each entry's frontmatter `data.chapterNumber` to `sort_order + 1`. This
 *     keeps the projected blueprint stable when callers shuffle cards.
 *
 * What we DO NOT touch: the `chapters` table's `chapter_number` column. The
 * manuscript URL `?chapter=N` is stable on purpose (plan §3.5 trade-off): the
 * outline view's "displayed chapter number" can differ from the manuscript
 * chapter_number when a user reshuffles cards after drafting.
 */
export async function reorderOutlineAtomic(
  novelId: string,
  orderedEntryIds: string[],
  opts?: { syncChapterNumbers?: boolean; preserveChapterNumbers?: boolean },
): Promise<void> {
  const db = getDb();
  // Pull each outline row's level so we can (a) decide whether this is a pure
  // single-level tree (legacy fast path, behaviour unchanged) and (b) skip
  // chapterNumber writes on non-chapter nodes (scene/beat must never carry a
  // chapterNumber — it would pollute the blueprint projection's de-dup/renumber).
  const currentRows = db
    .prepare(
      `SELECT id, COALESCE(json_extract(${SAFE_DATA_JSON}, '$.level'), 'chapter') AS level
         FROM knowledge_entries
        WHERE novel_id = ? AND type = 'outline'`,
    )
    .all(novelId) as { id: string; level: string }[];
  const levelById = new Map(currentRows.map(row => [row.id, row.level]));
  const currentIds = new Set(currentRows.map(row => row.id));
  const treeHasNonChapter = currentRows.some(row => row.level !== 'chapter');

  // When the tree is pure chapter AND the caller didn't opt out, we run the
  // legacy contract verbatim: the payload must be a full, dup-free permutation
  // of every outline row, and chapterNumber is synced to index+1. This keeps
  // every pre-W3-1 test green and the blueprint projection stable.
  const useHierarchyPath = treeHasNonChapter || opts?.preserveChapterNumbers === true;

  if (!useHierarchyPath) {
    if (
      currentRows.length !== orderedEntryIds.length ||
      new Set(orderedEntryIds).size !== orderedEntryIds.length ||
      orderedEntryIds.some(id => !currentIds.has(id))
    ) {
      throw new Error('Invalid outline order');
    }
  } else {
    // Hierarchy path: validation relaxes from "full permutation" to "valid
    // same-novel subset reorder" — the payload may carry any non-empty,
    // dup-free subset of this novel's outline rows (a cross-level drag only
    // resequences the affected branch, not the whole tree).
    if (
      orderedEntryIds.length === 0 ||
      new Set(orderedEntryIds).size !== orderedEntryIds.length ||
      orderedEntryIds.some(id => !currentIds.has(id))
    ) {
      throw new Error('Invalid outline order');
    }
  }

  // On the hierarchy path we never touch chapterNumber. The stored
  // chapterNumber on chapter rows is left exactly as-is so the projection stays
  // deterministic and scene/beat rows are never stamped.
  // `syncChapterNumbers` is forced off.
  const syncChapterNumbers = useHierarchyPath ? false : opts?.syncChapterNumbers !== false;

  const updateOrder = db.prepare(
    'UPDATE knowledge_entries SET sort_order = ?, updated_at = ? WHERE id = ? AND novel_id = ? AND type = ?',
  );
  const updateBoth = db.prepare(
    `UPDATE knowledge_entries
        SET sort_order = ?,
            data = json_set(${SAFE_DATA_JSON}, '$.chapterNumber', ?),
            updated_at = ?
      WHERE id = ? AND novel_id = ? AND type = ?`,
  );
  const updateIndexChapterNumber = db.prepare(
    `UPDATE knowledge_index
        SET data = json_set(${SAFE_DATA_JSON}, '$.chapterNumber', ?),
            updated_at = ?
      WHERE id = ? AND novel_id = ?`,
  );

  const now = nowIso();
  const tx = db.transaction(() => {
    for (let i = 0; i < orderedEntryIds.length; i++) {
      const id = orderedEntryIds[i];
      // Guard at the row level too: even if a future caller passed
      // syncChapterNumbers:true with a mixed payload, a non-chapter node here
      // would still only get its sort_order rewritten.
      const isChapter = (levelById.get(id) ?? 'chapter') === 'chapter';
      if (syncChapterNumbers && isChapter) {
        updateBoth.run(i, i + 1, now, id, novelId, 'outline');
        updateIndexChapterNumber.run(i + 1, now, id, novelId);
      } else {
        updateOrder.run(i, now, id, novelId, 'outline');
      }
    }
    touchNovelUpdatedAt(db, novelId);
  });
  tx();
}

/** All outline rows for a novel, sorted by their projected chapter number. */
export interface OutlineEntryRow extends KnowledgeEntryRow {
  parsedChapterNumber: number;
}

export async function getOutlineEntries(novelId: string): Promise<OutlineEntryRow[]> {
  const db = getDb();
  return db
    .prepare(
      `SELECT *, COALESCE(json_extract(${SAFE_DATA_JSON}, '$.chapterNumber'), sort_order + 1) AS parsedChapterNumber
         FROM knowledge_entries
        WHERE novel_id = ? AND type = 'outline'
        ORDER BY parsedChapterNumber ASC, sort_order ASC`,
    )
    .all(novelId) as (KnowledgeEntryRow & { parsedChapterNumber: number })[];
}

/**
 * Outline rows joined against the `chapters` table. Returned shape is
 * convenient for outline consumers: each row gets a
 * `hasChapter` boolean + `chapterWordCount` so the "已写 / 未写" badge can
 * render without an extra round-trip.
 */
export interface OutlineWithChapterStatusRow extends KnowledgeEntryRow {
  parsedChapterNumber: number;
  hasChapter: boolean;
  chapterWordCount: number;
}

export async function getOutlineWithChapterStatus(
  novelId: string,
): Promise<OutlineWithChapterStatusRow[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ke.*,
              COALESCE(json_extract(${SAFE_KE_DATA_JSON}, '$.chapterNumber'), ke.sort_order + 1) AS parsedChapterNumber,
              c.id IS NOT NULL AS hasChapter,
              COALESCE(c.word_count, 0) AS chapterWordCount
         FROM knowledge_entries ke
         LEFT JOIN chapters c
                ON c.novel_id = ke.novel_id
               AND c.chapter_number = COALESCE(json_extract(${SAFE_KE_DATA_JSON}, '$.chapterNumber'), ke.sort_order + 1)
        WHERE ke.novel_id = ?
          AND ke.type = 'outline'
        ORDER BY parsedChapterNumber ASC, ke.sort_order ASC`,
    )
    .all(novelId) as (KnowledgeEntryRow & {
      parsedChapterNumber: number;
      hasChapter: number | boolean;
      chapterWordCount: number;
    })[];
  return rows.map(r => ({
    ...r,
    hasChapter: Boolean(r.hasChapter),
  }));
}
