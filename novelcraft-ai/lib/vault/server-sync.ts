import { getKnowledgeEntryById, getKnowledgeRelationsByEntry } from '@/lib/db';
import { getNovelVault, isVaultRootPending } from '@/lib/db/queries-vault';
import { getKnowledgeIndexById } from '@/lib/db/queries-knowledge-vault';
import { renderEntryToMarkdown, type VaultEntry } from '@/lib/vault/entry';
import {
  deleteAnchoredVaultEntry,
  writeAnchoredVaultEntry,
} from '@/lib/vault/anchored-fs';
import { withNovelVaultRootLock } from '@/lib/vault/root-lock';
import { parseJsonField } from '@/lib/utils';
import type { KnowledgeType } from '@/lib/types/knowledge';
import type { KnowledgeEntryRow } from '@/lib/db/queries-knowledge';
import type { VaultFrontmatter, VaultRootFence } from '@/lib/vault/types';

function markdownBodyFor(row: KnowledgeEntryRow, data: Record<string, unknown>): string {
  const chunks = [
    data.description,
    data.sampleText,
    data.styleNotes,
    data.synopsis,
    data.summary,
    data.notes,
    data.backstory,
    data.arc,
    row.summary,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(value => value.trim());
  return chunks.length > 0 ? chunks.join('\n\n') : row.title;
}

async function renderKnowledgeEntryMarkdown(row: KnowledgeEntryRow, relPath: string): Promise<string> {
  const data = parseJsonField<Record<string, unknown>>(row.data, {});
  const tags = parseJsonField<string[]>(row.tags, []);
  const relations = await getKnowledgeRelationsByEntry(row.id);
  const outgoing = [];
  for (const relation of relations) {
    if (relation.source_id !== row.id) continue;
    const target = await getKnowledgeEntryById(relation.target_id);
    if (!target || target.novel_id !== row.novel_id) continue;
    outgoing.push({
      target: target.title,
      type: relation.relation_type,
      label: relation.label,
    });
  }
  // Strip reserved frontmatter keys from the data blob before folding it in, so
  // a data payload that happens to carry id/type/title/createdAt/updatedAt/tags
  // cannot overwrite the canonical identity fields.
  const RESERVED_FRONTMATTER_KEYS = new Set([
    'id', 'type', 'title', 'tags', 'createdAt', 'updatedAt', 'relations',
  ]);
  const safeData: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (RESERVED_FRONTMATTER_KEYS.has(k)) continue;
    safeData[k] = v;
  }
  const frontmatter: VaultFrontmatter = {
    id: row.id,
    type: row.type as KnowledgeType,
    title: row.title,
    tags: Array.isArray(tags) ? tags : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...safeData,
    ...(outgoing.length > 0 ? { relations: outgoing } : {}),
  };
  const entry: VaultEntry = {
    id: row.id,
    novelId: row.novel_id,
    type: row.type as KnowledgeType,
    path: relPath,
    frontmatter,
    body: markdownBodyFor(row, data),
  };
  return renderEntryToMarkdown(entry);
}

export type VaultMirrorWriteResult =
  | 'written'
  | 'skipped_unbound'
  | 'skipped_missing_entry'
  | 'skipped_stale_root';

function fenceMatches(
  vault: { vaultPath: string | null; vaultVersion: number } | null | undefined,
  fence: VaultRootFence | undefined,
): boolean {
  if (!fence) return true;
  return Boolean(
    vault?.vaultPath
    && vault.vaultPath === fence.expectedRoot
    && vault.vaultVersion === fence.expectedToken,
  );
}

export async function syncKnowledgeEntryToVault(
  novelId: string,
  entryId: string,
  fence?: VaultRootFence,
): Promise<VaultMirrorWriteResult> {
  return withNovelVaultRootLock(novelId, async () => {
    const [vault, row, index] = await Promise.all([
      getNovelVault(novelId),
      getKnowledgeEntryById(entryId),
      getKnowledgeIndexById(entryId),
    ]);
    // Unbound novels must leave durable outbox intents pending — never pretend
    // the mirror write completed when no root is configured.
    if (!vault?.vaultPath) return 'skipped_unbound';
    if (isVaultRootPending(vault.vaultVersion) && !fence) return 'skipped_stale_root';
    if (!fenceMatches(vault, fence)) return 'skipped_stale_root';
    if (!row || row.novel_id !== novelId || !index || index.novelId !== novelId) {
      return 'skipped_missing_entry';
    }
    const root = vault.vaultPath;
    const latest = await getNovelVault(novelId);
    if (!latest?.vaultPath || latest.vaultPath !== root) return 'skipped_stale_root';
    if (!fenceMatches(latest, fence)) return 'skipped_stale_root';
    await writeAnchoredVaultEntry(
      root,
      index.path,
      await renderKnowledgeEntryMarkdown(row, index.path),
    );
    return 'written';
  });
}

export async function deleteKnowledgeEntryFromVault(
  novelId: string,
  entryId: string,
  relPath?: string | null,
  fence?: VaultRootFence,
): Promise<VaultMirrorWriteResult> {
  return withNovelVaultRootLock(novelId, async () => {
    const vault = await getNovelVault(novelId);
    if (!vault?.vaultPath) return 'skipped_unbound';
    if (isVaultRootPending(vault.vaultVersion) && !fence) return 'skipped_stale_root';
    if (!fenceMatches(vault, fence)) return 'skipped_stale_root';
    const pathToDelete = relPath ?? (await getKnowledgeIndexById(entryId))?.path ?? null;
    if (!pathToDelete) return 'skipped_missing_entry';
    const root = vault.vaultPath;
    const latest = await getNovelVault(novelId);
    if (!latest?.vaultPath || latest.vaultPath !== root) return 'skipped_stale_root';
    if (!fenceMatches(latest, fence)) return 'skipped_stale_root';
    await deleteAnchoredVaultEntry(root, pathToDelete);
    return 'written';
  });
}

export const __serverSyncTest = {
  renderKnowledgeEntryMarkdown,
};
