import {
  getKnowledgeEntryById,
  getKnowledgeRelationsByEntry,
  type KnowledgeEntryRow,
} from '@/lib/db';
import {
  buildKnowledgeIndexInsert,
  syncIndexFromEntry,
  type IndexSyncInput,
} from '@/lib/knowledge/index-sync';
import type { KnowledgeIndexInsert } from '@/lib/db/queries-vault';
import type { KnowledgeType } from '@/lib/types/knowledge';
import { nowIso, parseJsonField } from '@/lib/utils';

/**
 * Adjustments to the relation set when the DB doesn't yet reflect an in-flight
 * mutation:
 *  - `summary` overrides the row's stored summary (AI-summarize path).
 *  - `add` injects a relation not yet committed (relation-create path).
 *  - `excludeRelationId` / `excludeTargetId` drop a relation being deleted.
 */
export interface IndexSyncInputOptions {
  summary?: string;
  add?: { targetTitle: string; relationType: string; label: string };
  /** Batch form of `add` — inject several not-yet-committed relations (the
   *  atomic relation-drafts sync projects its whole create set at once). */
  adds?: { targetTitle: string; relationType: string; label: string }[];
  excludeRelationId?: string;
  /** Batch form of `excludeRelationId` — drop several relations being deleted. */
  excludeRelationIds?: string[];
  excludeTargetId?: string;
}

export async function refreshKnowledgeIndexForEntry(entryId: string, updatedAt = nowIso()): Promise<void> {
  const entry = await getKnowledgeEntryById(entryId);
  if (!entry) return;

  await syncIndexFromEntry(await buildIndexSyncInputForEntry(entry, updatedAt));
}

export async function buildKnowledgeIndexInsertForEntry(
  entryId: string,
  updatedAt = nowIso(),
  overrides: IndexSyncInputOptions = {},
): Promise<KnowledgeIndexInsert | null> {
  const entry = await getKnowledgeEntryById(entryId);
  if (!entry) return null;

  return buildKnowledgeIndexInsert(await buildIndexSyncInputForEntry(entry, updatedAt, overrides));
}

/**
 * Single source for projecting a knowledge entry row into an {@link IndexSyncInput}:
 * parse data/tags, strip the embedded `relations`, then re-derive outgoing
 * relations from the relation table (honouring `opts` adjustments) and fold them
 * back in. Previously this projection existed in three near-identical copies
 * (refresh-index, actions/knowledge buildRelationSourceIndex, summarize via
 * buildKnowledgeIndexInsertForEntry).
 */
export async function buildIndexSyncInputForEntry(
  entry: KnowledgeEntryRow,
  updatedAt: string,
  opts: IndexSyncInputOptions = {},
): Promise<IndexSyncInput> {
  const dataForIndex = parseJsonField<Record<string, unknown>>(entry.data, {});
  delete dataForIndex.relations;
  const tags = parseJsonField<string[]>(entry.tags, []);

  const excludedRelationIds = new Set(opts.excludeRelationIds ?? []);
  if (opts.excludeRelationId) excludedRelationIds.add(opts.excludeRelationId);

  const outgoingRelations: { target: string; type: string; label: string }[] = [];
  const relationRows = await getKnowledgeRelationsByEntry(entry.id);
  for (const rel of relationRows) {
    if (
      excludedRelationIds.has(rel.id)
      || rel.target_id === opts.excludeTargetId
      || rel.source_id !== entry.id
    ) continue;
    const target = await getKnowledgeEntryById(rel.target_id);
    if (!target || target.novel_id !== entry.novel_id) continue;
    outgoingRelations.push({ target: target.title, type: rel.relation_type, label: rel.label });
  }
  for (const add of [...(opts.add ? [opts.add] : []), ...(opts.adds ?? [])]) {
    outgoingRelations.push({ target: add.targetTitle, type: add.relationType, label: add.label });
  }
  if (outgoingRelations.length > 0) {
    dataForIndex.relations = outgoingRelations;
  }

  return {
    id: entry.id,
    novelId: entry.novel_id,
    type: entry.type as KnowledgeType,
    title: entry.title,
    summary: opts.summary ?? entry.summary,
    data: dataForIndex,
    tags: Array.isArray(tags) ? tags : [],
    updatedAt,
  };
}
