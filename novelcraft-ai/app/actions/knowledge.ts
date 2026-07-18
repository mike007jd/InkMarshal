'use server';

import { getUser } from '@/lib/local-auth';
import {
  verifyNovelOwnership,
  getKnowledgeEntryById,
  getActiveNovel,
  createKnowledgeEntryWithIndex as dbCreateKnowledgeEntryWithIndex,
  deleteKnowledgeEntry as dbDeleteKnowledgeEntry,
  getKnowledgeEntriesByNovel,
  createKnowledgeRelationWithSourceIndex as dbCreateKnowledgeRelationWithSourceIndex,
  deleteKnowledgeRelationWithSourceIndex as dbDeleteKnowledgeRelationWithSourceIndex,
  syncKnowledgeRelationsForSource as dbSyncKnowledgeRelationsForSource,
  getKnowledgeRelationById,
  getKnowledgeRelationsByEntry,
  type KnowledgeEntryRow,
} from '@/lib/db';
import {
  createKnowledgeEntrySchema,
  knowledgeRelationSchema,
  knowledgeRelationDraftsSchema,
  parseKnowledgeEntryUpdate,
  type KnowledgeType,
} from '@/lib/types/knowledge';
import { planKnowledgeRelationDraftSync } from '@/lib/knowledge/relation-drafts';
import { buildKnowledgeEntrySummary, removeDanglingRefs } from '@/lib/knowledge';
import { buildKnowledgeIndexInsert } from '@/lib/knowledge/index-sync';
import { invalidateEmbeddingCache } from '@/lib/knowledge/embedding';
import { buildIndexSyncInputForEntry, refreshKnowledgeIndexForEntry } from '@/lib/knowledge/refresh-index';
import {
  applyKnowledgeEntryWrite,
  clearStaleEmbedding,
  scheduleEmbeddingRefresh,
  trySyncKnowledgeEntryToVault,
  tryDeleteKnowledgeEntryFromVault,
} from '@/lib/knowledge/apply-write';
import { getKnowledgeIndexById } from '@/lib/db/queries-knowledge-vault';
import { knowledgeRelationEndpointsMatch } from '@/lib/knowledge-ownership';
import { isUuid, nowIso, parseJsonField } from '@/lib/utils';

async function refreshIncomingRelationSources(targetEntryId: string, novelId: string): Promise<void> {
  const relations = await getKnowledgeRelationsByEntry(targetEntryId);
  const sourceIds = Array.from(new Set(
    relations
      .filter(rel => rel.target_id === targetEntryId && rel.source_id !== targetEntryId)
      .map(rel => rel.source_id),
  ));
  await Promise.all(sourceIds.map(async sourceId => {
    const source = await getKnowledgeEntryById(sourceId);
    if (!source || source.novel_id !== novelId) return;
    await refreshKnowledgeIndexForEntry(source.id);
    await trySyncKnowledgeEntryToVault(novelId, source.id, 'refreshIncomingRelationSources');
    await clearStaleEmbedding(source.id, source.novel_id);
    scheduleEmbeddingRefresh(source.id);
  }));
}

/** Build a fresh index insert for a relation's source entry, with an optional
 *  in-flight add/exclude adjustment. Thin wrapper over the shared projection. */
async function buildRelationSourceIndex(
  source: KnowledgeEntryRow,
  updatedAt: string,
  opts?: { add?: { targetTitle: string; relationType: string; label: string }; excludeRelationId?: string; excludeTargetId?: string },
) {
  return buildKnowledgeIndexInsert(await buildIndexSyncInputForEntry(source, updatedAt, opts));
}

function hasKnowledgeEntryUpdateChange(
  parsed: { title?: string; data?: unknown; tags?: string[] },
  entry: { title: string; data: string; tags: string },
): boolean {
  if (parsed.title !== undefined && parsed.title !== entry.title) return true;
  if (parsed.data !== undefined && JSON.stringify(parsed.data) !== entry.data) return true;
  if (parsed.tags !== undefined && JSON.stringify(parsed.tags) !== entry.tags) return true;
  return false;
}

/** Verify the entry's novel belongs to the current user and return the row. */
async function verifyEntryOwnership(entryId: string, userId: string): Promise<KnowledgeEntryRow> {
  if (!isUuid(entryId)) throw new Error('Not found');
  const entry = await getKnowledgeEntryById(entryId);
  if (!entry) throw new Error('Not found');

  // Verify novel ownership
  const novel = await getActiveNovel(entry.novel_id);
  if (!novel || novel.userId !== userId) throw new Error('Not found');

  return entry;
}

async function verifyRelationEndpointOwnership(
  sourceId: string,
  targetId: string,
  userId: string,
): Promise<{ source: KnowledgeEntryRow; target: KnowledgeEntryRow }> {
  const [source, target] = await Promise.all([
    getKnowledgeEntryById(sourceId),
    getKnowledgeEntryById(targetId),
  ]);
  if (!knowledgeRelationEndpointsMatch(
    source ? { novel_id: source.novel_id } : undefined,
    target ? { novel_id: target.novel_id } : undefined,
  )) throw new Error('Not found');

  await verifyNovelOwnership(source!.novel_id, userId);
  return { source: source!, target: target! };
}

export async function createKnowledgeEntry(novelId: string, input: unknown) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const parsed = createKnowledgeEntrySchema.parse(input);
  await verifyNovelOwnership(novelId, user.id);

  const now = nowIso();
  const id = crypto.randomUUID();

  const summary = buildKnowledgeEntrySummary(parsed.type, parsed.data);
  const tags = parsed.tags ?? [];

  const index = await buildKnowledgeIndexInsert({
    id,
    novelId,
    type: parsed.type,
    title: parsed.title,
    summary,
    data: parsed.data as Record<string, unknown>,
    tags,
    updatedAt: now,
  });

  await dbCreateKnowledgeEntryWithIndex({
    id,
    novelId,
    type: parsed.type,
    title: parsed.title,
    summary,
    data: JSON.stringify(parsed.data),
    sortOrder: 0,
    tags: JSON.stringify(tags),
    createdAt: now,
    updatedAt: now,
  }, index);
  await trySyncKnowledgeEntryToVault(novelId, id, 'createKnowledgeEntry');
  scheduleEmbeddingRefresh(id);

  return { id, novelId, type: parsed.type, title: parsed.title };
}

export async function updateKnowledgeEntry(entryId: string, updates: unknown) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const entry = await verifyEntryOwnership(entryId, user.id);
  if (!entry.type) throw new Error('Not found');
  const parsed = parseKnowledgeEntryUpdate(entry.type as KnowledgeType, updates);
  if (!hasKnowledgeEntryUpdateChange(parsed, entry)) return;

  const now = nowIso();
  const fields: { title?: string; summary?: string; data?: string; tags?: string; updatedAt: string } = {
    updatedAt: now,
  };
  if (parsed.title !== undefined) fields.title = parsed.title;
  if (parsed.data !== undefined) {
    fields.data = JSON.stringify(parsed.data);
    fields.summary = buildKnowledgeEntrySummary(entry.type as KnowledgeType, parsed.data as Record<string, unknown>);
  }
  if (parsed.tags !== undefined) fields.tags = JSON.stringify(parsed.tags);

  const nextData = parsed.data !== undefined
    ? parsed.data as Record<string, unknown>
    : parseJsonField<Record<string, unknown>>(entry.data, {});
  const nextTags = parsed.tags !== undefined
    ? parsed.tags
    : parseJsonField<string[]>(entry.tags, []);
  const nextTitle = parsed.title ?? entry.title;
  const nextSummary = fields.summary ?? entry.summary;
  const index = await buildKnowledgeIndexInsert({
    id: entryId,
    novelId: entry.novel_id,
    type: entry.type as KnowledgeType,
    title: nextTitle,
    summary: nextSummary,
    data: nextData,
    tags: nextTags,
    updatedAt: now,
  });

  await applyKnowledgeEntryWrite({
    entryId,
    novelId: entry.novel_id,
    fields,
    index,
    context: 'updateKnowledgeEntry',
  });
  if (parsed.title !== undefined && parsed.title !== entry.title) {
    await refreshIncomingRelationSources(entryId, entry.novel_id);
  }
}

export async function deleteKnowledgeEntry(entryId: string) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const entry = await verifyEntryOwnership(entryId, user.id);
  const novelId = entry.novel_id;
  const incomingRelationSourceIds = Array.from(new Set(
    (await getKnowledgeRelationsByEntry(entryId))
      .filter(rel => rel.target_id === entryId && rel.source_id !== entryId)
      .map(rel => rel.source_id),
  ));

  const siblings = await getKnowledgeEntriesByNovel(novelId);
  const deletedIndexPath = (await getKnowledgeIndexById(entryId))?.path ?? null;
  const filteredSiblings = siblings.filter(r => r.id !== entryId);

  const dirty: {
    row: (typeof filteredSiblings)[number];
    data: Record<string, unknown>;
    dataJson: string;
    updatedAt: string;
  }[] = [];
  const now = nowIso();
  for (const row of filteredSiblings) {
    const data = parseJsonField<Record<string, unknown>>(row.data, {});
    const cleaned = removeDanglingRefs(data, entryId);
    const cleanedJson = JSON.stringify(cleaned);
    if (cleanedJson !== JSON.stringify(data)) {
      dirty.push({ row, data: cleaned, dataJson: cleanedJson, updatedAt: now });
    }
  }

  const cleanupUpdates = await Promise.all(dirty.map(async item => ({
    id: item.row.id,
    data: item.dataJson,
    updatedAt: item.updatedAt,
    index: await buildKnowledgeIndexInsert({
      id: item.row.id,
      novelId: item.row.novel_id,
      type: item.row.type as KnowledgeType,
      title: item.row.title,
      summary: item.row.summary,
      data: item.data,
      tags: parseJsonField<string[]>(item.row.tags, []),
      updatedAt: item.updatedAt,
    }),
  })));
  const sourceIndexUpdates = await Promise.all(incomingRelationSourceIds.map(async sourceId => {
    const source = await getKnowledgeEntryById(sourceId);
    if (!source || source.novel_id !== novelId) return null;
    return buildRelationSourceIndex(source, now, { excludeTargetId: entryId });
  }));

  // Relations cascade via FK ON DELETE CASCADE in the schema. The DB helper
  // also deletes the recall index row, applies sibling reference cleanup, and
  // removes incoming source outgoing-link projections in the same transaction;
  // the embedding row follows via the knowledge_index FK cascade. If any index
  // update fails, the target deletion and cleanup roll back together.
  await dbDeleteKnowledgeEntry(
    entryId,
    cleanupUpdates,
    sourceIndexUpdates.filter((index): index is NonNullable<typeof index> => index !== null),
  );
  await tryDeleteKnowledgeEntryFromVault(novelId, entryId, deletedIndexPath, 'deleteKnowledgeEntry');
  invalidateEmbeddingCache(novelId);
  if (dirty.length) {
    await Promise.all(dirty.map(async item => {
      await trySyncKnowledgeEntryToVault(item.row.novel_id, item.row.id, 'deleteKnowledgeEntry.cleanupSibling');
      await clearStaleEmbedding(item.row.id, item.row.novel_id);
      scheduleEmbeddingRefresh(item.row.id);
    }));
  }
  await Promise.all(incomingRelationSourceIds.map(async sourceId => {
    const source = await getKnowledgeEntryById(sourceId);
    if (!source || source.novel_id !== novelId) return;
    await trySyncKnowledgeEntryToVault(source.novel_id, source.id, 'deleteKnowledgeEntry.refreshIncomingSource');
    await clearStaleEmbedding(source.id, source.novel_id);
    scheduleEmbeddingRefresh(source.id);
  }));
}

export async function createKnowledgeRelation(input: unknown) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const parsed = knowledgeRelationSchema.parse(input);
  const { source, target } = await verifyRelationEndpointOwnership(parsed.sourceId, parsed.targetId, user.id);

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const sourceIndex = await buildRelationSourceIndex(source, createdAt, {
    add: {
      targetTitle: target.title,
      relationType: parsed.relationType,
      label: parsed.label,
    },
  });
  await dbCreateKnowledgeRelationWithSourceIndex({
    id,
    sourceId: parsed.sourceId,
    targetId: parsed.targetId,
    relationType: parsed.relationType,
    label: parsed.label,
    createdAt,
  }, sourceIndex);
  await trySyncKnowledgeEntryToVault(source.novel_id, source.id, 'createKnowledgeRelation');
  await clearStaleEmbedding(parsed.sourceId, source.novel_id);
  scheduleEmbeddingRefresh(parsed.sourceId);

  return { id };
}

export async function deleteKnowledgeRelation(relId: string) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const rel = await getKnowledgeRelationById(relId);
  if (!rel) return;
  const source = await verifyEntryOwnership(rel.source_id, user.id);
  const novelId = source.novel_id;

  const sourceIndex = await buildRelationSourceIndex(source, nowIso(), {
    excludeRelationId: relId,
  });
  await dbDeleteKnowledgeRelationWithSourceIndex(relId, sourceIndex);
  await trySyncKnowledgeEntryToVault(novelId, source.id, 'deleteKnowledgeRelation');
  await clearStaleEmbedding(rel.source_id, novelId);
  scheduleEmbeddingRefresh(rel.source_id);
}

/**
 * KN-01: atomically reconcile a source entry's outgoing relations to the desired
 * final draft set. Diffs against the DB, applies every delete + create and the
 * rebuilt source index in ONE transaction (dbSyncKnowledgeRelationsForSource),
 * then runs the vault/embedding side effects exactly once. Replaces the former
 * client-side delete-then-create loop, which could leave the relation set
 * partially updated when a single create failed.
 */
export async function syncKnowledgeRelationDrafts(sourceEntryId: string, drafts: unknown) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const source = await verifyEntryOwnership(sourceEntryId, user.id);
  const parsedDrafts = knowledgeRelationDraftsSchema.parse(drafts);

  // Current outgoing relations from the DB are the source of truth for the diff.
  const existing = (await getKnowledgeRelationsByEntry(sourceEntryId))
    .filter(rel => rel.source_id === sourceEntryId)
    .map(rel => ({
      id: rel.id,
      sourceId: rel.source_id,
      targetId: rel.target_id,
      relationType: rel.relation_type,
      label: rel.label,
    }));

  const plan = planKnowledgeRelationDraftSync(sourceEntryId, existing, parsedDrafts);
  if (plan.deleteIds.length === 0 && plan.creates.length === 0) return;

  // Verify every create target belongs to the same novel and collect its title
  // for the projected index.
  const now = nowIso();
  const creates = await Promise.all(plan.creates.map(async create => {
    if (create.targetId === sourceEntryId) {
      throw new Error('Knowledge relation source and target must differ');
    }
    const target = await getKnowledgeEntryById(create.targetId);
    if (!target || target.novel_id !== source.novel_id) throw new Error('Not found');
    return {
      id: crypto.randomUUID(),
      sourceId: sourceEntryId,
      targetId: create.targetId,
      relationType: create.relationType,
      label: create.label,
      createdAt: now,
      targetTitle: target.title,
    };
  }));

  // Project the index from the intended FINAL relation set: drop the deletes,
  // fold in the creates. Built outside the (synchronous) transaction.
  const sourceIndex = await buildKnowledgeIndexInsert(
    await buildIndexSyncInputForEntry(source, now, {
      excludeRelationIds: plan.deleteIds,
      adds: creates.map(c => ({ targetTitle: c.targetTitle, relationType: c.relationType, label: c.label })),
    }),
  );

  await dbSyncKnowledgeRelationsForSource(
    source.novel_id,
    plan.deleteIds,
    creates.map(c => ({
      id: c.id,
      sourceId: c.sourceId,
      targetId: c.targetId,
      relationType: c.relationType,
      label: c.label,
      createdAt: c.createdAt,
    })),
    sourceIndex,
  );

  // Side effects AFTER the transaction commits — one vault sync + one embedding
  // refresh for the source, regardless of how many rows changed.
  await trySyncKnowledgeEntryToVault(source.novel_id, source.id, 'syncKnowledgeRelationDrafts');
  await clearStaleEmbedding(source.id, source.novel_id);
  scheduleEmbeddingRefresh(source.id);
}
