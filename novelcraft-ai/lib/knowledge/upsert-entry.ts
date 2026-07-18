import {
  createKnowledgeEntryWithIndex,
  getKnowledgeEntries,
  type KnowledgeEntryRow,
} from '@/lib/db';
import { buildKnowledgeEntrySummary } from '@/lib/knowledge';
import {
  applyKnowledgeEntryWrite,
  scheduleEmbeddingRefresh,
  trySyncKnowledgeEntryToVault,
} from '@/lib/knowledge/apply-write';
import { buildKnowledgeIndexInsert } from '@/lib/knowledge/index-sync';
import {
  createKnowledgeEntrySchema,
  parseKnowledgeEntryUpdate,
  type KnowledgeType,
} from '@/lib/types/knowledge';
import { nowIso, parseJsonField } from '@/lib/utils';

export type KnowledgeEntryUpsertResult = 'created' | 'updated' | 'unchanged';

export interface KnowledgeEntryByTitleUpsert {
  novelId: string;
  type: KnowledgeType;
  title: string;
  data: Record<string, unknown>;
  tags?: string[];
  existingEntries?: readonly KnowledgeEntryRow[];
  context: string;
}

function normalizedTitle(value: string): string {
  return value.trim().toLowerCase();
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

export async function upsertKnowledgeEntryByTitle(
  input: KnowledgeEntryByTitleUpsert,
): Promise<KnowledgeEntryUpsertResult> {
  const parsedCreate = createKnowledgeEntrySchema.parse({
    type: input.type,
    title: input.title,
    data: input.data,
    tags: input.tags ?? [],
  });
  const existingEntries = input.existingEntries ?? await getKnowledgeEntries(input.novelId, { type: parsedCreate.type });
  const existing = existingEntries.find(
    entry => normalizedTitle(entry.title) === normalizedTitle(parsedCreate.title),
  );
  const now = nowIso();

  if (!existing) {
    const id = crypto.randomUUID();
    const summary = buildKnowledgeEntrySummary(parsedCreate.type, parsedCreate.data);
    const index = await buildKnowledgeIndexInsert({
      id,
      novelId: input.novelId,
      type: parsedCreate.type,
      title: parsedCreate.title,
      summary,
      data: parsedCreate.data,
      tags: parsedCreate.tags,
      updatedAt: now,
    });
    await createKnowledgeEntryWithIndex({
      id,
      novelId: input.novelId,
      type: parsedCreate.type,
      title: parsedCreate.title,
      summary,
      data: JSON.stringify(parsedCreate.data),
      sortOrder: 0,
      tags: JSON.stringify(parsedCreate.tags),
      createdAt: now,
      updatedAt: now,
    }, index);
    await trySyncKnowledgeEntryToVault(input.novelId, id, input.context);
    scheduleEmbeddingRefresh(id);
    return 'created';
  }

  const parsedUpdate = parseKnowledgeEntryUpdate(parsedCreate.type, {
    title: parsedCreate.title,
    data: parsedCreate.data,
    tags: parsedCreate.tags,
  });
  if (!hasKnowledgeEntryUpdateChange(parsedUpdate, existing)) return 'unchanged';

  const nextData = parsedUpdate.data !== undefined
    ? parsedUpdate.data as Record<string, unknown>
    : parseJsonField<Record<string, unknown>>(existing.data, {});
  const nextTags = parsedUpdate.tags !== undefined
    ? parsedUpdate.tags
    : parseJsonField<string[]>(existing.tags, []);
  const nextTitle = parsedUpdate.title ?? existing.title;
  const nextSummary = parsedUpdate.data !== undefined
    ? buildKnowledgeEntrySummary(parsedCreate.type, nextData)
    : existing.summary;
  const index = await buildKnowledgeIndexInsert({
    id: existing.id,
    novelId: existing.novel_id,
    type: parsedCreate.type,
    title: nextTitle,
    summary: nextSummary,
    data: nextData,
    tags: nextTags,
    updatedAt: now,
  });
  await applyKnowledgeEntryWrite({
    entryId: existing.id,
    novelId: existing.novel_id,
    fields: {
      title: parsedUpdate.title,
      data: parsedUpdate.data === undefined ? undefined : JSON.stringify(nextData),
      summary: nextSummary,
      tags: parsedUpdate.tags === undefined ? undefined : JSON.stringify(nextTags),
      updatedAt: now,
    },
    index,
    context: input.context,
  });
  return 'updated';
}
