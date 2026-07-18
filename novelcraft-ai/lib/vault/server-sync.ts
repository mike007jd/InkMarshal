import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { getKnowledgeEntryById, getKnowledgeRelationsByEntry } from '@/lib/db';
import { getNovelVault } from '@/lib/db/queries-vault';
import { getKnowledgeIndexById } from '@/lib/db/queries-knowledge-vault';
import { renderEntryToMarkdown, VAULT_ENTRY_DIRS, type VaultEntry } from '@/lib/vault/entry';
import { parseJsonField } from '@/lib/utils';
import type { KnowledgeType } from '@/lib/types/knowledge';
import type { KnowledgeEntryRow } from '@/lib/db/queries-knowledge';
import type { VaultFrontmatter } from '@/lib/vault/types';

const MAX_SYNC_MARKDOWN_BYTES = 128 * 1024;

function validateVaultEntryRelPath(root: string, relPath: string): string[] {
  if (!root || !relPath || path.isAbsolute(relPath) || relPath.includes('\\')) {
    throw new Error('Invalid vault entry path');
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith('../') || normalized === '..' || normalized !== relPath) {
    throw new Error('Invalid vault entry path');
  }
  const parts = normalized.split('/');
  if (parts.length !== 2 || !VAULT_ENTRY_DIRS.has(parts[0]) || !parts[1].endsWith('.md')) {
    throw new Error('Invalid vault entry path');
  }
  return parts;
}

async function safeVaultEntryFile(root: string, relPath: string, createParent: boolean): Promise<string> {
  const parts = validateVaultEntryRelPath(root, relPath);
  const rootAbs = path.resolve(root);
  const rootStat = await lstat(rootAbs);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Invalid vault root');
  }
  const rootReal = await realpath(rootAbs);
  const parentAbs = path.resolve(rootAbs, parts[0]);
  if (!parentAbs.startsWith(rootAbs + path.sep)) {
    throw new Error('Invalid vault entry path');
  }

  // Defense-in-depth: verify whatever already lives at parentAbs is a real
  // directory inside the root BEFORE we mkdir. If the path exists as a
  // symlink (or a regular file masquerading as our dir), bail out without
  // touching the filesystem. If it doesn't exist at all, only then do we
  // create it — the string-level startsWith check above already proves
  // `parts[0]` is a direct child of `rootAbs`, so the mkdir cannot escape.
  let exists = true;
  try {
    const preStat = await lstat(parentAbs);
    if (preStat.isSymbolicLink() || !preStat.isDirectory()) {
      throw new Error('Invalid vault entry parent');
    }
  } catch (error: unknown) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (code === 'ENOENT') {
      exists = false;
    } else {
      throw error;
    }
  }

  if (!exists) {
    if (!createParent) {
      throw new Error('Invalid vault entry parent');
    }
    await mkdir(parentAbs, { recursive: false }).catch((error: unknown) => {
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (code === 'EEXIST') return;
      throw error;
    });
    // After mkdir, re-stat to catch a race (someone replaced the freshly
    // created dir with a symlink between our mkdir and the rest of this
    // function).
    const postStat = await lstat(parentAbs);
    if (postStat.isSymbolicLink() || !postStat.isDirectory()) {
      throw new Error('Invalid vault entry parent');
    }
  }

  const parentReal = await realpath(parentAbs);
  if (!parentReal.startsWith(rootReal + path.sep)) {
    throw new Error('Invalid vault entry parent');
  }
  return path.join(parentReal, parts[1]);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > MAX_SYNC_MARKDOWN_BYTES) {
    throw new Error('Vault markdown is too large');
  }
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;
  try {
    handle = await open(tmp, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, file);
    renamed = true;
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }
}

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

export async function syncKnowledgeEntryToVault(novelId: string, entryId: string): Promise<void> {
  const [vault, row, index] = await Promise.all([
    getNovelVault(novelId),
    getKnowledgeEntryById(entryId),
    getKnowledgeIndexById(entryId),
  ]);
  if (!vault?.vaultPath || !row || row.novel_id !== novelId || !index || index.novelId !== novelId) return;
  const file = await safeVaultEntryFile(vault.vaultPath, index.path, true);
  await writeAtomic(file, await renderKnowledgeEntryMarkdown(row, index.path));
}

export async function deleteKnowledgeEntryFromVault(
  novelId: string,
  entryId: string,
  relPath?: string | null,
): Promise<void> {
  const vault = await getNovelVault(novelId);
  if (!vault?.vaultPath) return;
  const pathToDelete = relPath ?? (await getKnowledgeIndexById(entryId))?.path ?? null;
  if (!pathToDelete) return;
  await rm(await safeVaultEntryFile(vault.vaultPath, pathToDelete, false), { force: true });
}

export const __serverSyncTest = {
  safeVaultEntryFile,
  writeAtomic,
  renderKnowledgeEntryMarkdown,
};
