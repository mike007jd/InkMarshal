'use server';

// W3-3 series / shared worldbuilding — server actions.
//
// Orchestrates the series lifecycle on top of the local SQLite store: create /
// rename / delete a series, add / remove member novels, promote a private
// knowledge entry to shared (and back), set a per-novel override or cross-book
// state on a shared entry, and run the cross-book consistency check.
//
// Every mutation that changes the shared-entry set or its overlays re-runs the
// projection (`reprojectSharedEntriesForSeries`) so each member novel's
// `shared/%` index rows + recall stay current, and schedules embedding refresh
// for the affected member projections.

import { getUser } from '@/lib/local-auth';
import { getActiveNovel, getActiveNovels, verifyNovelOwnership } from '@/lib/db';
import {
  getKnowledgeEntryById,
  getKnowledgeEntriesByNovel,
  type KnowledgeEntryRow,
} from '@/lib/db/queries-knowledge';
import {
  listSeries,
  getSeries,
  createSeries as dbCreateSeries,
  listSeriesMembers,
  listActiveSeriesMembers,
  getNovelSeriesId,
  setNovelSeries,
  listSharedEntriesForSeries,
  setEntrySeriesId,
  setEntryData,
  clearSharedProjectionForNovel,
  novelAnchorsSharedEntries,
  reanchorSharedEntries,
  reprojectSharedEntriesForSeries,
  type Series,
} from '@/lib/db/queries-series';
import {
  checkSeriesConsistency,
  summarizeConflicts,
  type CrossBookConflict,
  type SeriesMemberOrder,
  type SharedEntryForCheck,
} from '@/lib/series/cross-book-check';
import {
  parseKnowledgeEntryUpdate,
  type CrossBookStateEntry,
  type KnowledgeType,
} from '@/lib/types/knowledge';
import { scheduleEmbeddingRefresh } from '@/lib/knowledge/apply-write';
import { invalidateEmbeddingCache } from '@/lib/knowledge/embedding';
import { isUuid, parseJsonField } from '@/lib/utils';

const TITLE_MAX = 200;
const DESC_MAX = 2000;

function cleanText(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

async function requireUser() {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  return user;
}

/** Verify the series exists + belongs to the local user. */
async function requireSeriesOwner(seriesId: string, userId: string): Promise<Series> {
  if (!isUuid(seriesId)) throw new Error('Not found');
  const series = await getSeries(seriesId);
  if (!series || series.userId !== userId) throw new Error('Not found');
  return series;
}

// --- series CRUD -----------------------------------------------------------

export async function getSeriesList(): Promise<Series[]> {
  const user = await requireUser();
  return listSeries(user.id);
}

export interface SeriesDetail {
  series: Series;
  members: { id: string; title: string }[];
  sharedEntries: {
    id: string;
    novelId: string;
    type: KnowledgeType;
    title: string;
    summary: string;
    data: Record<string, unknown>;
  }[];
}

export async function getSeriesDetail(seriesId: string): Promise<SeriesDetail> {
  const user = await requireUser();
  const series = await requireSeriesOwner(seriesId, user.id);
  const members = (await listActiveSeriesMembers(seriesId)).map(m => ({ id: m.id, title: m.title }));
  const sharedEntries = (await listSharedEntriesForSeries(seriesId)).map(row => ({
    id: row.id,
    novelId: row.novel_id,
    type: row.type as KnowledgeType,
    title: row.title,
    summary: row.summary,
    data: parseJsonField<Record<string, unknown>>(row.data, {}),
  }));
  return { series, members, sharedEntries };
}

/** Novels owned by the user that aren't yet in THIS series (candidates to add).
 *  Each carries its current series id so the UI can warn about re-homing. */
export async function listAddableNovels(
  seriesId: string,
): Promise<{ id: string; title: string; currentSeriesId: string | null }[]> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  const novels = await getActiveNovels(user.id);
  const out: { id: string; title: string; currentSeriesId: string | null }[] = [];
  for (const novel of novels) {
    const currentSeriesId = await getNovelSeriesId(novel.id);
    if (currentSeriesId === seriesId) continue;
    out.push({ id: novel.id, title: novel.title, currentSeriesId });
  }
  return out;
}

/** A member novel's PRIVATE knowledge entries (series_id NULL) — candidates the
 *  author can promote to shared. Outline entries are excluded (they're
 *  per-novel structure, never shared). */
export async function listShareableEntries(
  seriesId: string,
  novelId: string,
): Promise<{ id: string; type: KnowledgeType; title: string; summary: string }[]> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  await verifyNovelOwnership(novelId, user.id);
  if ((await getNovelSeriesId(novelId)) !== seriesId) throw new Error('Novel is not in this series');

  const entries = await getKnowledgeEntriesByNovel(novelId);
  return entries
    .filter(e => (e.series_id ?? null) === null && e.type !== 'outline')
    .map(e => ({
      id: e.id,
      type: e.type as KnowledgeType,
      title: e.title,
      summary: e.summary,
    }));
}

export async function createSeries(input: {
  title?: string;
  description?: string;
}): Promise<Series> {
  const user = await requireUser();
  const title = cleanText(input?.title, TITLE_MAX);
  if (!title) throw new Error('Series title is required');
  const id = crypto.randomUUID();
  return dbCreateSeries({
    id,
    userId: user.id,
    title,
    description: cleanText(input?.description, DESC_MAX),
  });
}

// --- membership ------------------------------------------------------------

export async function addNovelToSeries(seriesId: string, novelId: string): Promise<void> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  await verifyNovelOwnership(novelId, user.id);

  const current = await getNovelSeriesId(novelId);
  if (current === seriesId) return;
  // If the novel was in another series, drop its shared projection there first.
  if (current) await clearSharedProjectionForNovel(novelId);

  await setNovelSeries(novelId, seriesId);
  await reprojectSharedEntriesForSeries(seriesId);
  await refreshMemberProjectionEmbeddings(seriesId, [novelId]);
}

/**
 * Remove a member novel from its series. A novel that still anchors shared
 * entries cannot be removed without first transferring those entries to another
 * member (`transferToNovelId`) — otherwise the shared rows would be orphaned.
 */
export async function removeNovelFromSeries(
  seriesId: string,
  novelId: string,
  opts?: { transferToNovelId?: string },
): Promise<{ ok: true } | { ok: false; reason: 'anchors_shared_entries'; sharedCount: number }> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  await verifyNovelOwnership(novelId, user.id);

  if (await novelAnchorsSharedEntries(novelId)) {
    const transferTo = opts?.transferToNovelId;
    if (!transferTo) {
      const shared = await listSharedEntriesForSeries(seriesId);
      const sharedCount = shared.filter(e => e.novel_id === novelId).length;
      return { ok: false, reason: 'anchors_shared_entries', sharedCount };
    }
    // Transfer target must be a different member of the same series.
    const targetSeries = await getNovelSeriesId(transferTo);
    if (transferTo === novelId || targetSeries !== seriesId) {
      throw new Error('Invalid transfer target');
    }
    await verifyNovelOwnership(transferTo, user.id);
    await reanchorSharedEntries(novelId, transferTo);
  }

  await clearSharedProjectionForNovel(novelId);
  await setNovelSeries(novelId, null);
  // Reproject so the (possibly re-anchored) shared set is fresh for the
  // remaining members.
  await reprojectSharedEntriesForSeries(seriesId);
  invalidateEmbeddingCache(novelId);
  return { ok: true };
}

// --- shared / private toggle + overrides ------------------------------------

async function verifyEntryInSeries(
  entryId: string,
  seriesId: string,
  userId: string,
): Promise<KnowledgeEntryRow> {
  if (!isUuid(entryId)) throw new Error('Not found');
  const entry = await getKnowledgeEntryById(entryId);
  if (!entry) throw new Error('Not found');
  const novel = await getActiveNovel(entry.novel_id);
  if (!novel || novel.userId !== userId) throw new Error('Not found');
  // The anchor novel must belong to this series.
  const anchorSeries = await getNovelSeriesId(entry.novel_id);
  if (anchorSeries !== seriesId) throw new Error('Entry anchor novel is not in this series');
  return entry;
}

/** Promote a private knowledge entry (on a member novel) to a shared series
 *  entry. The entry keeps its novel_id (becomes the series anchor). */
export async function shareKnowledgeEntry(seriesId: string, entryId: string): Promise<void> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  const entry = await verifyEntryInSeries(entryId, seriesId, user.id);
  if (entry.series_id === seriesId) return;
  await setEntrySeriesId(entryId, seriesId);
  await reprojectSharedEntriesForSeries(seriesId);
  await refreshMemberProjectionEmbeddings(seriesId);
}

/** Demote a shared entry back to private (removes it from every member's
 *  projection, keeps the canonical entry on its anchor novel). */
export async function unshareKnowledgeEntry(seriesId: string, entryId: string): Promise<void> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  const entry = await getKnowledgeEntryById(entryId);
  if (!entry || entry.series_id !== seriesId) throw new Error('Not found');
  const novel = await getActiveNovel(entry.novel_id);
  if (!novel || novel.userId !== user.id) throw new Error('Not found');

  await setEntrySeriesId(entryId, null);
  // Rebuild projections for the remaining shared set across all members.
  await reprojectSharedEntriesForSeries(seriesId);
  await refreshMemberProjectionEmbeddings(seriesId);
}

/**
 * Edit a shared entry's CANONICAL main value (affects every member). The caller
 * confirms in the UI which members are affected before invoking this. Uses the
 * type's update schema to validate the `data` patch.
 */
export async function updateSharedEntryMainValue(
  seriesId: string,
  entryId: string,
  updates: { title?: string; data?: unknown; tags?: string[] },
): Promise<void> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  const entry = await verifyEntryInSeries(entryId, seriesId, user.id);
  if (entry.series_id !== seriesId) throw new Error('Entry is not shared in this series');

  const parsed = parseKnowledgeEntryUpdate(entry.type as KnowledgeType, updates);
  if (parsed.data !== undefined) {
    await setEntryData(entryId, JSON.stringify(parsed.data));
  }
  await reprojectSharedEntriesForSeries(seriesId);
  await refreshMemberProjectionEmbeddings(seriesId);
}

/**
 * Set (or clear) a per-novel override patch on a shared entry. This writes only
 * into `data.perNovelOverrides[novelId]` — the canonical main value and every
 * OTHER member's view are untouched (the spec's "本书覆盖" path).
 */
export async function setPerNovelOverride(
  seriesId: string,
  entryId: string,
  novelId: string,
  patch: Record<string, unknown> | null,
): Promise<void> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  const entry = await verifyEntryInSeries(entryId, seriesId, user.id);
  if (entry.series_id !== seriesId) throw new Error('Entry is not shared in this series');
  // The override target must be a member of this series.
  await verifyNovelOwnership(novelId, user.id);
  if ((await getNovelSeriesId(novelId)) !== seriesId) throw new Error('Override novel is not in this series');

  const data = parseJsonField<Record<string, unknown>>(entry.data, {});
  const overrides: Record<string, unknown> =
    data.perNovelOverrides && typeof data.perNovelOverrides === 'object' && !Array.isArray(data.perNovelOverrides)
      ? { ...(data.perNovelOverrides as Record<string, unknown>) }
      : {};
  if (patch === null || Object.keys(patch).length === 0) {
    delete overrides[novelId];
  } else {
    overrides[novelId] = sanitizeOverridePatch(patch);
  }
  if (Object.keys(overrides).length === 0) delete data.perNovelOverrides;
  else data.perNovelOverrides = overrides;

  // Validate through the type schema so a bad override can't corrupt the entry.
  const validated = parseKnowledgeEntryUpdate(entry.type as KnowledgeType, { data });
  await setEntryData(entryId, JSON.stringify(validated.data ?? data));
  await reprojectSharedEntriesForSeries(seriesId);
  await refreshMemberProjectionEmbeddings(seriesId, [novelId]);
}

/** Set (or clear) a member novel's cross-book state (age/status/relationsDelta)
 *  on a shared entry. Drives the consistency checker. */
export async function setCrossBookState(
  seriesId: string,
  entryId: string,
  novelId: string,
  state: CrossBookStateEntry | null,
): Promise<void> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);
  const entry = await verifyEntryInSeries(entryId, seriesId, user.id);
  if (entry.series_id !== seriesId) throw new Error('Entry is not shared in this series');
  await verifyNovelOwnership(novelId, user.id);
  if ((await getNovelSeriesId(novelId)) !== seriesId) throw new Error('State novel is not in this series');

  const data = parseJsonField<Record<string, unknown>>(entry.data, {});
  const bag: Record<string, unknown> =
    data.crossBookState && typeof data.crossBookState === 'object' && !Array.isArray(data.crossBookState)
      ? { ...(data.crossBookState as Record<string, unknown>) }
      : {};
  if (state === null || (state.age === undefined && state.status === undefined && state.relationsDelta === undefined)) {
    delete bag[novelId];
  } else {
    bag[novelId] = state;
  }
  if (Object.keys(bag).length === 0) delete data.crossBookState;
  else data.crossBookState = bag;

  const validated = parseKnowledgeEntryUpdate(entry.type as KnowledgeType, { data });
  await setEntryData(entryId, JSON.stringify(validated.data ?? data));
  // crossBookState drives the consistency report, and (via age/status) the
  // projected member view — reproject so recall reflects the per-book state.
  await reprojectSharedEntriesForSeries(seriesId);
  await refreshMemberProjectionEmbeddings(seriesId, [novelId]);
}

// --- cross-book consistency report -----------------------------------------

export interface CrossBookReport {
  conflicts: CrossBookConflict[];
  summary: { total: number; major: number; minor: number };
  /** Member id → title, so the panel can label the involved novels. */
  novelTitles: Record<string, string>;
}

export async function runCrossBookCheck(seriesId: string): Promise<CrossBookReport> {
  const user = await requireUser();
  await requireSeriesOwner(seriesId, user.id);

  const members = await listActiveSeriesMembers(seriesId);
  // In-world order = insertion order of the member list (most-recently-updated
  // first from the query, so reverse to make older books "earlier"). A future
  // explicit ordering control can set this from series.settings.
  const ordered: SeriesMemberOrder[] = [...members]
    .reverse()
    .map((m, idx) => ({ novelId: m.id, title: m.title, order: idx }));

  const sharedEntries: SharedEntryForCheck[] = (await listSharedEntriesForSeries(seriesId)).map(row => ({
    id: row.id,
    type: row.type,
    title: row.title,
    data: parseJsonField<Record<string, unknown>>(row.data, {}),
  }));

  const conflicts = checkSeriesConsistency(sharedEntries, ordered);
  const novelTitles: Record<string, string> = {};
  for (const m of members) novelTitles[m.id] = m.title;

  return { conflicts, summary: summarizeConflicts(conflicts), novelTitles };
}

// --- helpers ---------------------------------------------------------------

function sanitizeOverridePatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k.length > 64) continue;
    out[k] = v;
  }
  return out;
}

/** Schedule embedding refresh for the projected `shared/%` rows of the given
 *  members (or all members when omitted). Best-effort; embedding is additive. */
async function refreshMemberProjectionEmbeddings(
  seriesId: string,
  onlyNovelIds?: string[],
): Promise<void> {
  const members = await listActiveSeriesMembers(seriesId);
  const targetNovelIds = onlyNovelIds ?? members.map(m => m.id);
  const shared = await listSharedEntriesForSeries(seriesId);
  for (const novelId of targetNovelIds) {
    invalidateEmbeddingCache(novelId);
    for (const entry of shared) {
      // projection-row id is `<entryId>::<novelId>` (see lib/series/projection.ts).
      scheduleEmbeddingRefresh(`${entry.id}::${novelId}`);
    }
  }
}
