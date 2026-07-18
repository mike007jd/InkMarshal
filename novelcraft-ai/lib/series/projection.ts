// W3-3 series / shared worldbuilding — projection layer.
//
// A shared knowledge entry physically lives once (anchored on one member
// novel), but every member novel needs to *see* it through its own recall.
// Rather than rewrite every `WHERE novel_id = ?` recall / embedding / wikilink
// / timeline query into a UNION, we project the shared entry into each member
// novel's `knowledge_index` as an extra row whose `novel_id` is the member's
// and whose `path` is namespaced under `shared/` (so it can never collide with
// the member's own local entry paths, which all live under
// characters/ worlds/ timeline/ outline/ styles/).
//
// This module owns the two pure halves of that:
//   1. `mergeSharedEntryForNovel` — overlay a member's per-novel override patch
//      on top of the shared entry's canonical main value, producing the
//      effective entry from that novel's point of view. Used both by index-sync
//      (what gets written into the projection row) and any caller that wants the
//      novel-view data without going through the index.
//   2. `buildSharedProjectionInsert` — turn a merged shared entry into the
//      `KnowledgeIndexInsert` the upsert layer writes (with the `shared/` path).
//
// No SQL, no IO — all DB orchestration is in lib/db/queries-series.ts +
// app/actions/series.ts; recall reads the projected rows unchanged.

import { buildKnowledgeIndexInsert, type IndexSyncInput } from '@/lib/knowledge/index-sync';
import { slugifyForFs } from '@/lib/vault/filename';
import type { KnowledgeIndexInsert } from '@/lib/db/queries-vault';
import type { KnowledgeType } from '@/lib/types/knowledge';

/** Canonical shared entry (as stored on its anchor novel). */
export interface SharedEntrySource {
  id: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  /** Parsed `data` JSON of the shared entry (carries the overlay bags). */
  data: Record<string, unknown>;
  tags: string[];
  updatedAt: string;
}

/** Path prefix that namespaces every projected shared row. Reconcilers /
 *  index-sync rebuild use `path LIKE 'shared/%'` to find + replace them. */
export const SHARED_PROJECTION_PREFIX = 'shared/';

/** True when a `knowledge_index.path` is a projected shared row. */
export function isSharedProjectionPath(path: string): boolean {
  return path.startsWith(SHARED_PROJECTION_PREFIX);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Shallow-merge a member novel's override patch over the shared entry's main
 * data. The override is `data.perNovelOverrides[novelId]` — a partial field
 * patch. We:
 *   - start from a copy of the shared `data`,
 *   - strip the overlay bags (`perNovelOverrides` / `crossBookState`) from the
 *     projected view (they're authoring metadata, not content the model should
 *     ingest),
 *   - apply the member's `crossBookState` (age/status) as effective fields when
 *     present (a per-book age/status is, semantically, an override),
 *   - then apply the explicit `perNovelOverrides[novelId]` patch last so an
 *     author's manual override always wins.
 */
export function mergeSharedEntryForNovel(
  shared: SharedEntrySource,
  novelId: string,
): SharedEntrySource {
  const base: Record<string, unknown> = { ...shared.data };

  const overridesBag = isPlainObject(base.perNovelOverrides)
    ? (base.perNovelOverrides as Record<string, unknown>)
    : {};
  const crossBookBag = isPlainObject(base.crossBookState)
    ? (base.crossBookState as Record<string, unknown>)
    : {};

  // The overlay bags never travel into the projected view.
  delete base.perNovelOverrides;
  delete base.crossBookState;

  // crossBookState[novelId] = { age, status, relationsDelta } applied as
  // effective fields (a per-book age/status divergence).
  const cb = crossBookBag[novelId];
  if (isPlainObject(cb)) {
    if (cb.age !== undefined) base.age = cb.age;
    if (cb.status !== undefined) base.status = cb.status;
  }

  // perNovelOverrides[novelId] is the explicit author patch — applied last.
  const patch = overridesBag[novelId];
  if (isPlainObject(patch)) {
    for (const [k, v] of Object.entries(patch)) {
      base[k] = v;
    }
  }

  return {
    id: shared.id,
    type: shared.type,
    title: shared.title,
    summary: shared.summary,
    data: base,
    tags: shared.tags,
    updatedAt: shared.updatedAt,
  };
}

/**
 * Build the `KnowledgeIndexInsert` for one shared entry projected into one
 * member novel. The row's `id` is deterministic (`<entryId>::<novelId>`) so a
 * rebuild upserts in place rather than churning, and its `path` is under
 * `shared/` so it can't collide with the member's own entries.
 */
export async function buildSharedProjectionInsert(
  shared: SharedEntrySource,
  novelId: string,
): Promise<KnowledgeIndexInsert> {
  const merged = mergeSharedEntryForNovel(shared, novelId);
  const projectionId = sharedProjectionId(shared.id, novelId);
  const slug = slugifyForFs(merged.title || merged.type);
  const path = `${SHARED_PROJECTION_PREFIX}${merged.type}/${slug}-${shortId(shared.id)}.md`;

  const input: IndexSyncInput = {
    id: projectionId,
    novelId,
    type: merged.type,
    title: merged.title,
    summary: merged.summary,
    data: merged.data,
    tags: merged.tags,
    updatedAt: merged.updatedAt,
  };
  const base = await buildKnowledgeIndexInsert(input);
  // buildKnowledgeIndexInsert resolves a path from the index/vault dirs; force
  // the namespaced shared path so the projection can never collide with (or be
  // mistaken for) a real local entry.
  return { ...base, id: projectionId, novelId, path };
}

/** Deterministic projection-row id for (sharedEntryId, memberNovelId). */
export function sharedProjectionId(entryId: string, novelId: string): string {
  return `${entryId}::${novelId}`;
}

function shortId(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'shared';
}
