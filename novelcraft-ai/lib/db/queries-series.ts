// W3-3 series / shared worldbuilding — SQLite query layer.
//
// A `series` is the parent node a set of novels belongs to. Knowledge entries
// whose `series_id` is set are "shared" and visible (via the index-sync
// projection — see lib/series/projection.ts) to every member novel. The shared
// entry stays physically anchored to ONE novel (`novel_id` is NOT NULL — the
// series "anchor" novel) so the existing `WHERE novel_id = ?` query universe is
// undisturbed.
//
// These helpers are deliberately small + additive, mirroring queries-novel /
// queries-knowledge: no business logic, no vault/embedding side effects (those
// live in app/actions/series.ts which composes them inside one transaction).

import { getDb } from '@/lib/db/connection';
import { nowIso, parseJsonField } from '@/lib/utils';
import { upsertKnowledgeIndex } from '@/lib/db/queries-vault';
import {
  buildSharedProjectionInsert,
  type SharedEntrySource,
} from '@/lib/series/projection';
import type { KnowledgeType } from '@/lib/types/knowledge';

export interface SeriesRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  vault_path: string | null;
  settings: string | null;
  created_at: string;
  updated_at: string;
}

export interface Series {
  id: string;
  userId: string;
  title: string;
  description: string;
  vaultPath: string | null;
  settings: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeriesMember {
  id: string;
  title: string;
  seriesId: string | null;
}

function parseSeriesSettings(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function mapSeries(row: SeriesRow): Series {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description,
    vaultPath: row.vault_path,
    settings: parseSeriesSettings(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listSeries(userId: string): Promise<Series[]> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM series WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as SeriesRow[];
  return rows.map(mapSeries);
}

export async function getSeries(id: string): Promise<Series | null> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM series WHERE id = ?').get(id) as SeriesRow | undefined;
  return row ? mapSeries(row) : null;
}

export async function createSeries(data: {
  id: string;
  userId: string;
  title: string;
  description?: string;
  vaultPath?: string | null;
  settings?: Record<string, unknown> | null;
}): Promise<Series> {
  const db = getDb();
  const now = nowIso();
  db.prepare(
    `INSERT INTO series (id, user_id, title, description, vault_path, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.userId,
    data.title,
    data.description ?? '',
    data.vaultPath ?? null,
    data.settings ? JSON.stringify(data.settings) : null,
    now,
    now,
  );
  return (await getSeries(data.id))!;
}

/**
 * Delete a series and clean every artefact that pointed at it, in one
 * transaction:
 *   - member novels are un-linked (`novels.series_id` FK is ON DELETE SET NULL,
 *     but we also clear it explicitly so the un-link is visible to the same
 *     transaction's later statements);
 *   - every shared knowledge entry of this series, plus the `shared/%`
 *     projection rows + embeddings those produced, are removed.
 *
 * Returns the member novel ids whose projected `shared/%` rows were just wiped
 * so the caller can re-run vault sync for them. The anchor-novel guard
 * (don't orphan a shared entry) is enforced one level up in actions-series.
 */
export async function deleteSeriesCascade(id: string): Promise<{ memberNovelIds: string[] }> {
  const db = getDb();
  const tx = db.transaction(() => {
    const members = db
      .prepare('SELECT id FROM novels WHERE series_id = ?')
      .all(id) as { id: string }[];
    const memberNovelIds = members.map(m => m.id);

    // Drop the projected shared rows + their embeddings for every member novel.
    for (const novelId of memberNovelIds) {
      db.prepare(
        `DELETE FROM knowledge_embeddings
          WHERE id IN (SELECT id FROM knowledge_index WHERE novel_id = ? AND path LIKE 'shared/%')`,
      ).run(novelId);
      db.prepare(
        `DELETE FROM knowledge_index WHERE novel_id = ? AND path LIKE 'shared/%'`,
      ).run(novelId);
    }

    // Remove the shared entries themselves (anchored on whichever novel owns
    // them) + their canonical index rows / embeddings.
    const sharedEntries = db
      .prepare('SELECT id FROM knowledge_entries WHERE series_id = ?')
      .all(id) as { id: string }[];
    for (const entry of sharedEntries) {
      // Clear relations referencing this entry first — SQLite FK enforcement is
      // off by default, so without this the DELETE leaves orphan relation rows
      // pointing at a now-missing entry (mirrors deleteKnowledgeEntry).
      db.prepare(
        'DELETE FROM knowledge_relations WHERE source_id = ? OR target_id = ?',
      ).run(entry.id, entry.id);
      db.prepare('DELETE FROM knowledge_embeddings WHERE id = ?').run(entry.id);
      db.prepare('DELETE FROM knowledge_index WHERE id = ?').run(entry.id);
      db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(entry.id);
    }

    db.prepare('UPDATE novels SET series_id = NULL WHERE series_id = ?').run(id);
    db.prepare('DELETE FROM series WHERE id = ?').run(id);
    return memberNovelIds;
  });
  return { memberNovelIds: tx() };
}

// --- membership ------------------------------------------------------------

export async function listSeriesMembers(seriesId: string): Promise<SeriesMember[]> {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, title, series_id FROM novels WHERE series_id = ? ORDER BY updated_at DESC')
    .all(seriesId) as { id: string; title: string; series_id: string | null }[];
  return rows.map(r => ({ id: r.id, title: r.title, seriesId: r.series_id }));
}

/** Author-facing member list. Trash preserves series membership so restoring a
 * book also restores its place, but hidden books must not appear as ghost links
 * in ordinary Series screens. Internal projection/cleanup continues to use
 * listSeriesMembers above and therefore sees the complete membership graph. */
export async function listActiveSeriesMembers(seriesId: string): Promise<SeriesMember[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, title, series_id
         FROM novels
        WHERE series_id = ?
          AND json_extract(settings, '$.trashedAt') IS NULL
        ORDER BY updated_at DESC`,
    )
    .all(seriesId) as { id: string; title: string; series_id: string | null }[];
  return rows.map(r => ({ id: r.id, title: r.title, seriesId: r.series_id }));
}

export async function getNovelSeriesId(novelId: string): Promise<string | null> {
  const db = getDb();
  const row = db.prepare('SELECT series_id FROM novels WHERE id = ?').get(novelId) as
    | { series_id: string | null }
    | undefined;
  return row?.series_id ?? null;
}

export async function setNovelSeries(novelId: string, seriesId: string | null): Promise<void> {
  const db = getDb();
  db.prepare('UPDATE novels SET series_id = ?, updated_at = ? WHERE id = ?')
    .run(seriesId, nowIso(), novelId);
}

// --- shared knowledge entries ----------------------------------------------

/** Author-facing shared entries whose anchor novel is active. Trash preserves
 * canonical rows, but they must not leak through Series, consistency, recall,
 * or projections until that anchor is restored. */
export async function listSharedEntriesForSeries(seriesId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT e.id, e.novel_id, e.series_id, e.type, e.title, e.summary,
              e.data, e.sort_order, e.tags, e.created_at, e.updated_at
         FROM knowledge_entries e
         JOIN novels n ON n.id = e.novel_id
        WHERE e.series_id = ?
          AND json_extract(n.settings, '$.trashedAt') IS NULL
        ORDER BY e.type ASC, e.sort_order ASC, e.updated_at DESC`,
    )
    .all(seriesId) as {
      id: string;
      novel_id: string;
      series_id: string;
      type: string;
      title: string;
      summary: string;
      data: string;
      sort_order: number;
      tags: string;
      created_at: string;
      updated_at: string;
    }[];
}

/**
 * Promote a private entry to shared (or change its series) by stamping
 * `series_id`. The entry keeps its `novel_id` (becomes the anchor). Returns
 * true when a row changed.
 */
export async function setEntrySeriesId(entryId: string, seriesId: string | null): Promise<boolean> {
  const db = getDb();
  const info = db
    .prepare('UPDATE knowledge_entries SET series_id = ?, updated_at = ? WHERE id = ?')
    .run(seriesId, nowIso(), entryId);
  return info.changes > 0;
}

/**
 * Persist a new `data` JSON blob for a shared entry (used by the override /
 * cross-book-state writers). Caller has already validated + serialized.
 */
export async function setEntryData(entryId: string, dataJson: string): Promise<void> {
  const db = getDb();
  db.prepare('UPDATE knowledge_entries SET data = ?, updated_at = ? WHERE id = ?')
    .run(dataJson, nowIso(), entryId);
}

/**
 * Remove a single member novel's `shared/%` projection rows + their
 * embeddings (member-removal / un-share cleanup), in one transaction.
 */
export async function clearSharedProjectionForNovel(novelId: string): Promise<void> {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM knowledge_embeddings
        WHERE id IN (SELECT id FROM knowledge_index WHERE novel_id = ? AND path LIKE 'shared/%')`,
    ).run(novelId);
    db.prepare(
      `DELETE FROM knowledge_index WHERE novel_id = ? AND path LIKE 'shared/%'`,
    ).run(novelId);
  });
  tx();
}

/**
 * True when `entryId` is the only remaining shared entry anchored on `novelId`
 * within its series — used to block removing/deleting an anchor novel that
 * still owns shared rows (the caller offers to transfer ownership instead).
 */
export async function novelAnchorsSharedEntries(novelId: string): Promise<boolean> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_entries
        WHERE novel_id = ? AND series_id IS NOT NULL`,
    )
    .get(novelId) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/** Re-anchor every shared entry currently owned by `fromNovelId` onto
 *  `toNovelId` (anchor-novel transfer before removing a member). */
export async function reanchorSharedEntries(
  fromNovelId: string,
  toNovelId: string,
): Promise<number> {
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE knowledge_entries
          SET novel_id = ?, updated_at = ?
        WHERE novel_id = ? AND series_id IS NOT NULL`,
    )
    .run(toNovelId, nowIso(), fromNovelId);
  return info.changes;
}

// --- projection orchestration ----------------------------------------------

function toSharedEntrySource(row: {
  id: string;
  type: string;
  title: string;
  summary: string;
  data: string;
  tags: string;
  updated_at: string;
}): SharedEntrySource {
  return {
    id: row.id,
    type: row.type as KnowledgeType,
    title: row.title,
    summary: row.summary,
    data: parseJsonField<Record<string, unknown>>(row.data, {}),
    tags: parseJsonField<string[]>(row.tags, []),
    updatedAt: row.updated_at,
  };
}

/**
 * Rebuild the `shared/%` projection rows for every member novel of a series.
 *
 * This is THE single index-sync seam for shared entries (the spec's "收敛到
 * index-sync 一处" decision). For each member novel we:
 *   1. delete its existing `shared/%` index rows (+ their embeddings) so a
 *      rebuild fully replaces the previous projection — no stale rows, no
 *      `UNIQUE(novel_id, path)` churn;
 *   2. re-insert one row per shared entry, with the member's per-novel
 *      overrides merged in (`mergeSharedEntryForNovel`).
 *
 * The DELETE-then-write happens inside one transaction so recall never observes
 * a half-rebuilt projection. The merge/insert builders are async (content
 * hashing), so we precompute the inserts before opening the transaction.
 */
export async function reprojectSharedEntriesForSeries(seriesId: string): Promise<void> {
  const members = await listActiveSeriesMembers(seriesId);
  if (members.length === 0) return;
  const sharedRows = (await listSharedEntriesForSeries(seriesId)).map(toSharedEntrySource);

  // Precompute every (member × shared entry) projection insert up front.
  const insertsByNovel = new Map<string, Awaited<ReturnType<typeof buildSharedProjectionInsert>>[]>();
  for (const member of members) {
    const inserts = await Promise.all(
      sharedRows.map(shared => buildSharedProjectionInsert(shared, member.id)),
    );
    insertsByNovel.set(member.id, inserts);
  }

  const db = getDb();
  const tx = db.transaction(() => {
    for (const member of members) {
      db.prepare(
        `DELETE FROM knowledge_embeddings
          WHERE id IN (SELECT id FROM knowledge_index WHERE novel_id = ? AND path LIKE 'shared/%')`,
      ).run(member.id);
      db.prepare(
        `DELETE FROM knowledge_index WHERE novel_id = ? AND path LIKE 'shared/%'`,
      ).run(member.id);
      for (const insert of insertsByNovel.get(member.id) ?? []) {
        upsertKnowledgeIndex(db, insert);
      }
    }
  });
  tx();
}
