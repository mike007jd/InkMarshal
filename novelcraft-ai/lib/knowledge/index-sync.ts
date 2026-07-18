// Wave 2 commit C — server-side knowledge_index synchroniser.
//
// The SQLite `knowledge_index` mirror is kept in sync on every server action,
// and vault-enabled actions also write the matching `.md` file via
// `lib/vault/server-sync`. Recall reads the index so it stays fast even when
// the vault lives on a slow disk.
//
// We compose the same frontmatter shape as the vault file writer, hash it, and
// upsert. When the actual `.md` is written later, the watcher reconciles drift.

import { hashContent } from '@/lib/vault/content-hash';
import {
  upsertKnowledgeIndexRow,
  getKnowledgeIndexRowByPath,
  type KnowledgeIndexInsert,
} from '@/lib/db/queries-vault';
import { getKnowledgeIndexById } from '@/lib/db/queries-knowledge-vault';
import { slugifyForFs } from '@/lib/vault/filename';
import { collectOutgoingLinks } from '@/lib/vault/outgoing-links';
import { vaultPathFor } from '@/lib/vault/entry';
import { normalizeKnowledgeAliases } from '@/lib/knowledge/field-normalizers';
import type { KnowledgeType } from '@/lib/types/knowledge';

export interface IndexSyncInput {
  id: string;
  novelId: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  data: Record<string, unknown>;
  tags: string[];
  updatedAt: string;
}

/**
 * Compose + upsert a `knowledge_index` row from the canonical entry fields.
 * Idempotent; safe to call after every create/update. Never throws; callers use
 * this as a best-effort side effect and recall can rebuild the index from the
 * canonical knowledge table if needed.
 */
export async function syncIndexFromEntry(input: IndexSyncInput): Promise<void> {
  try {
    await upsertKnowledgeIndexRow(await buildKnowledgeIndexInsert(input));
  } catch (err) {
    console.warn('[index-sync] failed to upsert knowledge_index row', err);
  }
}

export async function buildKnowledgeIndexInsert(input: IndexSyncInput): Promise<KnowledgeIndexInsert> {
  const relPath = await resolveIndexPath(input);
  const aliases = normalizeKnowledgeAliases(input.data['aliases']);
  const importance = extractImportance(input.data);
  // Frontmatter `data` blob = everything in data minus structural keys + a
  // surfaced `summary` so render.ts can fall back to it without a body fetch.
  const dataForIndex: Record<string, unknown> = { ...input.data };
  if (input.summary && !dataForIndex['description']) {
    // Help the rendering fallback when description is empty.
    dataForIndex['__summary'] = input.summary;
  }
  // Outgoing wikilinks: `data` fields we know are character-link arrays
  // (relations.target, characters[]) encode the same edges as title
  // references; we also scan the summary for `[[X]]`.
  const outgoingLinks = collectOutgoingLinks({ fields: input.data, text: input.summary });
  const contentHash = await hashContent(JSON.stringify({
    title: input.title,
    type: input.type,
    data: input.data,
    summary: input.summary,
    tags: input.tags,
  }));
  return {
    id: input.id,
    novelId: input.novelId,
    type: input.type,
    path: relPath,
    title: input.title,
    tags: JSON.stringify(input.tags),
    aliases: JSON.stringify(aliases),
    importance,
    data: JSON.stringify(dataForIndex),
    outgoingLinks: JSON.stringify(outgoingLinks),
    contentHash,
    updatedAt: input.updatedAt,
  };
}

async function resolveIndexPath(input: Pick<IndexSyncInput, 'id' | 'novelId' | 'type' | 'title'>): Promise<string> {
  const existing = await getKnowledgeIndexById(input.id);
  if (existing) {
    if (existing.novelId !== input.novelId) {
      throw new Error('Knowledge index id belongs to another novel');
    }
    return existing.path;
  }

  const slug = slugifyForFs(input.title);
  const basePath = vaultPathFor(input.type, `${slug}.md`);
  const baseOwner = await getKnowledgeIndexRowByPath(input.novelId, basePath);
  if (!baseOwner || baseOwner.id === input.id) return basePath;

  const idSlug = slugifyForFs(input.id).slice(0, 64);
  const idPath = vaultPathFor(input.type, `${slug}-${idSlug}.md`);
  const idPathOwner = await getKnowledgeIndexRowByPath(input.novelId, idPath);
  if (!idPathOwner || idPathOwner.id === input.id) return idPath;

  const hash = (await hashContent(`${input.novelId}:${input.id}:${basePath}`)).slice(0, 16);
  return vaultPathFor(input.type, `${slug}-${hash}.md`);
}

function extractImportance(data: Record<string, unknown>): string | null {
  const v = data['importance'];
  if (v === 'low' || v === 'normal' || v === 'high') return v;
  if (v === 'major') return 'high';
  if (v === 'minor') return 'normal';
  return null;
}
