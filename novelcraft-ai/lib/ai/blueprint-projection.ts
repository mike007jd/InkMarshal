// Wave 2 commit D — `novels.blueprint` is no longer a stored column. Each
// chapter's outline lives as its own `knowledge_entries` (type = 'outline')
// row, mirrored to `knowledge_index` and to a vault `outline/ch-{slug}.md`
// file. This module projects those rows into the writing `NovelBlueprint`
// shape used by start-writing and blueprint APIs.
//
// Read order:
//   1. `knowledge_index` (fast, FS-backed mirror) when populated.
//   2. `knowledge_entries` as the canonical source of truth when the mirror is
//      missing or stale.
//
// We do NOT touch the vault filesystem from this module — server-side reads
// stay in SQLite. The vault index is kept in sync by `index-sync.ts` whenever
// an outline entry is written through Server Actions, so by the time recall
// asks for an outline projection the rows are already mirrored.

import { getDb } from '@/lib/db/connection';
import { parseJsonField } from '@/lib/utils';
import type { NovelBlueprint, ChapterBlueprintEntry } from '@/lib/db-types';

interface OutlineProjectionRow {
  id: string;
  title: string;
  data: string;
  sort_order: number;
  updated_at: string;
}

/**
 * Project the persisted outline knowledge entries for a novel into the
 * `NovelBlueprint` shape.
 *
 * Returns `null` when no outline rows exist (callers fall back to
 * `generateBookBlueprint`).
 */
export async function projectBlueprintFromOutline(
  novelId: string,
): Promise<NovelBlueprint | null> {
  const db = getDb();
  // Prefer `knowledge_index` rows only when the mirror is complete. A partial
  // mirror would truncate the writing blueprint, so canonical entries stay the
  // correctness source whenever the id sets diverge.
  let indexRows: OutlineProjectionRow[] = [];
  try {
    indexRows = db
      .prepare(
        // W3-1: only `level='chapter'` rows project into the writing blueprint.
        // volume/scene/beat nodes are transparent to start-writing. The
        // COALESCE keeps pre-W3-1 rows (no `level` key) projecting as chapters,
        // so all-chapter novels are byte-identical to the pre-W3-1 behaviour.
        `SELECT id, title, data, COALESCE(json_extract(data, '$.chapterNumber'), 0) AS sort_order, updated_at
           FROM knowledge_index
          WHERE novel_id = ? AND type = 'outline'
            AND COALESCE(json_extract(data, '$.level'), 'chapter') = 'chapter'`,
      )
      .all(novelId) as OutlineProjectionRow[];
  } catch {
    indexRows = [];
  }
  const entryRows = db
    .prepare(
      // Same `level='chapter'` guard on the canonical source; both SELECTs must
      // filter or a partial mirror would resurrect scene/beat rows as phantom
      // chapters.
      `SELECT id, title, data, sort_order, updated_at
         FROM knowledge_entries
        WHERE novel_id = ? AND type = 'outline'
          AND COALESCE(json_extract(data, '$.level'), 'chapter') = 'chapter'`,
    )
    .all(novelId) as OutlineProjectionRow[];

  const rows = chooseOutlineProjectionRows(indexRows, entryRows);

  if (rows.length === 0) return null;

  const chapters: ChapterBlueprintEntry[] = [];
  let maxUpdated = 0;
  let wordTargetSum = 0;
  let wordTargetCount = 0;

  for (const row of rows) {
    const data = parseJsonField<Record<string, unknown>>(row.data, {});
    const chapterNumberRaw = (data['chapterNumber'] as number | undefined) ?? row.sort_order + 1;
    const chapterNumber = Number.isFinite(chapterNumberRaw) && chapterNumberRaw > 0
      ? Math.trunc(chapterNumberRaw)
      : row.sort_order + 1;
    const synopsis = typeof data['synopsis'] === 'string'
      ? data['synopsis']
      : '';
    const wordTarget = typeof data['wordCountTarget'] === 'number'
      ? data['wordCountTarget']
      : 0;
    if (wordTarget > 0) {
      wordTargetSum += wordTarget;
      wordTargetCount += 1;
    }
    chapters.push({
      chapterNumber,
      title: row.title || `Chapter ${chapterNumber}`,
      summary: synopsis,
    });
    const ts = Date.parse(row.updated_at);
    if (Number.isFinite(ts) && ts > maxUpdated) maxUpdated = ts;
  }

  chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);

  // Renumber to 1..N when the persisted numbers have gaps / duplicates so the
  // downstream coverage check (start-writing loadOrGenerateBlueprint) stays
  // deterministic. The persisted entries themselves are untouched — this is a
  // projection only.
  const seen = new Set<number>();
  const hasDupOrGap = chapters.some((c, idx) => {
    if (seen.has(c.chapterNumber)) return true;
    seen.add(c.chapterNumber);
    return c.chapterNumber !== idx + 1;
  });
  if (hasDupOrGap) {
    chapters.forEach((c, idx) => {
      c.chapterNumber = idx + 1;
    });
  }

  const targetWordsPerChapter = wordTargetCount > 0
    ? Math.round(wordTargetSum / wordTargetCount)
    : 0;
  const generatedAt = maxUpdated > 0
    ? new Date(maxUpdated).toISOString()
    : new Date().toISOString();

  return {
    chapters,
    targetWordsPerChapter,
    generatedAt,
    modelId: 'derived',
  };
}

function chooseOutlineProjectionRows(
  indexRows: OutlineProjectionRow[],
  entryRows: OutlineProjectionRow[],
): OutlineProjectionRow[] {
  if (entryRows.length === 0) return indexRows;
  if (indexRows.length === entryRows.length) {
    const entryById = new Map(entryRows.map(row => [row.id, row]));
    if (indexRows.every(row => {
      const entry = entryById.get(row.id);
      if (!entry) return false;
      const indexUpdatedAt = Date.parse(row.updated_at);
      const entryUpdatedAt = Date.parse(entry.updated_at);
      return Number.isFinite(indexUpdatedAt)
        && Number.isFinite(entryUpdatedAt)
        && indexUpdatedAt >= entryUpdatedAt;
    })) return indexRows;
  }
  return entryRows;
}
