'use server';

// Wave 2 commit B — Server Actions for the FS-backed Knowledge Vault.
//
// These run on the Node side of Tauri (or the Web build, where vault calls
// no-op gracefully). The Rust-side commands are reachable only from the
// client; here we own the SQLite state + verification that the user can act
// on the novel they're addressing.

import { createHash } from 'node:crypto';
import { getUser } from '@/lib/local-auth';
import {
  deleteKnowledgeEntry as dbDeleteKnowledgeEntry,
  getKnowledgeEntryById,
  getKnowledgeEntriesByNovel,
  verifyNovelOwnership,
} from '@/lib/db';
import {
  getNovelVault,
  bindNovelVaultRoot,
  clearNovelVaultPath,
  getKnowledgeIndexRowByPath,
  isVaultRootPending,
  replaceVaultKnowledgeProjection,
  setKnowledgeIndexMirrorContentHash,
} from '@/lib/db/queries-vault';
import { withNovelVaultRootLock } from '@/lib/vault/root-lock';
import type { VaultRootFence } from '@/lib/vault/types';
import {
  listKnowledgeIndexForNovel,
  getKnowledgeIndexById,
} from '@/lib/db/queries-knowledge-vault';
import {
  invalidateEmbeddingCache,
  upsertEntryEmbedding,
} from '@/lib/knowledge/embedding';
import {
  outgoingLinksFor,
  isVaultEntryPath,
  parseMarkdownToEntry,
  projectEntryForLegacy,
  vaultTypeForDir,
  vaultTypeForPath,
} from '@/lib/vault/entry';
import { removeDanglingRefs } from '@/lib/knowledge';
import { normalizeKnowledgeAliases, normalizeKnowledgeTags } from '@/lib/knowledge/field-normalizers';
import { buildKnowledgeIndexInsert } from '@/lib/knowledge/index-sync';
import { hashContent } from '@/lib/vault/content-hash';
import type { KnowledgeType } from '@/lib/types/knowledge';
import {
  CONTROL_CHARS,
  MAX_VAULT_PATH_LENGTH,
  validateVaultPathInput,
} from '@/lib/vault/path-validation';
import { isUuid, nowIso, parseJsonField } from '@/lib/utils';
import type { VaultEntry } from '@/lib/vault/entry';
import type { KnowledgeEntryRow } from '@/lib/db/queries-knowledge';
import {
  enqueueKnowledgeVaultUpsertForCurrentEntry,
  getKnowledgeVaultOutboxIntent,
} from '@/lib/db/queries-knowledge-vault-outbox';
import {
  tryDeleteKnowledgeEntryFromVault,
  trySyncKnowledgeEntryToVault,
} from '@/lib/knowledge/apply-write';

const MAX_VAULT_CHANGED_FILES = 64;
const MAX_VAULT_FILE_CONTENT_LENGTH = 128 * 1024;
const MAX_VAULT_ENTRY_ID_LENGTH = 256;
const MAX_VAULT_ENTRY_DATA_JSON_LENGTH = 32 * 1024;
const MAX_VAULT_DELETED_PATH_HINTS = 4096;

export interface VaultChangedFileInput {
  path: string;
  content: string | null;
}

export interface VaultReconcileOptions {
  deletedPathsHint?: string[];
  /**
   * When false, pending outbox upserts do not force DB→Vault replay. Used by
   * pending-root non-destructive import so newer Markdown can win by updatedAt.
   */
  allowUpsertMirrorReplay?: boolean;
  /** Fixed pending-root generation captured before reading this batch. */
  rootFence?: VaultRootFence;
}

export interface VaultIndexedEntryRef {
  id: string;
  path: string;
}

export interface NovelVaultStatus {
  vaultPath: string | null;
  vaultVersion: number;
}

export async function getNovelVaultStatus(novelId: string): Promise<NovelVaultStatus> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  await verifyNovelOwnership(novelId, user.id);

  const v = await getNovelVault(novelId);
  return {
    vaultPath: v?.vaultPath ?? null,
    vaultVersion: v?.vaultVersion ?? 1,
  };
}

export async function getVaultIndexedEntryRefsAction(novelId: string): Promise<VaultIndexedEntryRef[]> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  await verifyNovelOwnership(novelId, user.id);

  const refs = new Map<string, VaultIndexedEntryRef>();
  for (const row of await listKnowledgeIndexForNovel(novelId)) {
    if (isVaultEntryPath(row.path)) refs.set(row.path, { id: row.id, path: row.path });
  }
  return Array.from(refs.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export async function setNovelVaultPathAction(novelId: string, vaultPath: string): Promise<void> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  await verifyNovelOwnership(novelId, user.id);
  const validated = validateVaultPathInput(vaultPath);
  await withNovelVaultRootLock(novelId, async () => {
    await bindNovelVaultRoot(novelId, validated);
  });
}

/**
 * Pending-root transition: non-destructive import → missing-only projection →
 * CAS promote. Callers should pass the fixed root+token for this attempt.
 */
export async function bootstrapNovelVaultRootAction(
  novelId: string,
  fence?: VaultRootFence,
): Promise<{
  vaultPath: string | null;
  allowMissingFileDeletes: boolean;
  transitionToken: number | null;
}> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  await verifyNovelOwnership(novelId, user.id);
  const { prepareVaultRootForReconcile } = await import('@/lib/vault/root-bootstrap');
  return prepareVaultRootForReconcile(novelId, fence);
}

export async function clearNovelVaultPathAction(novelId: string): Promise<void> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  await verifyNovelOwnership(novelId, user.id);
  await withNovelVaultRootLock(novelId, async () => {
    await clearNovelVaultPath(novelId);
  });
}

export async function reconcileVaultChangedFiles(
  novelId: string,
  files: unknown,
  options?: unknown,
): Promise<{ updated: number; deleted: number; skipped: number }> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  await verifyNovelOwnership(novelId, user.id);

  const changes = normalizeVaultChangedFiles(files);
  const reconcileOptions = normalizeVaultReconcileOptions(options);
  if (reconcileOptions.rootFence) {
    return withNovelVaultRootLock(novelId, async () => {
      const current = await getNovelVault(novelId);
      if (
        !current?.vaultPath
        || current.vaultPath !== reconcileOptions.rootFence!.expectedRoot
        || current.vaultVersion !== reconcileOptions.rootFence!.expectedToken
        || !isVaultRootPending(current.vaultVersion)
      ) {
        throw new Error('Vault root changed during pending reconcile');
      }
      return reconcileNormalizedVaultChanges(novelId, changes, reconcileOptions, true);
    });
  }
  return reconcileNormalizedVaultChanges(novelId, changes, reconcileOptions, false);
}

async function reconcileNormalizedVaultChanges(
  novelId: string,
  changes: VaultChangedFileInput[],
  reconcileOptions: VaultReconcileOptions,
  fencedPendingImport: boolean,
): Promise<{ updated: number; deleted: number; skipped: number }> {
  const allowUpsertMirrorReplay = reconcileOptions.allowUpsertMirrorReplay !== false;
  const vault = await getNovelVault(novelId);
  const deleteEligible = !vault || !isVaultRootPending(vault.vaultVersion);
  const deletedPaths = new Set(
    deleteEligible
      ? [
          ...changes
            .filter(change => change.content === null)
            .map(change => change.path),
          ...(reconcileOptions.deletedPathsHint ?? []),
        ]
      : [],
  );
  const incoming = collectIncomingVaultEntries(novelId, changes);
  const incomingIdsByPath = incoming.idsByPath;
  let nextSortOrder: number | null = null;
  const takeNextSortOrder = async () => {
    if (nextSortOrder === null) {
      nextSortOrder = (await getKnowledgeEntriesByNovel(novelId)).length;
    }
    return nextSortOrder++;
  };
  let updated = 0;
  let deleted = 0;
  let skipped = 0;

  for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
    const change = changes[changeIndex]!;
    try {
      const previousIndex = await getKnowledgeIndexRowByPath(novelId, change.path);
      if (change.content === null) {
        // Pending roots are never delete-eligible — retain DB rows until
        // promotion; runtime will replay remove/rename after establish.
        if (!deleteEligible) {
          skipped++;
          continue;
        }
        const intent = getKnowledgeVaultOutboxIntent(
          novelId,
          previousIndex?.id ?? null,
          change.path,
        );
        if (intent?.operation === 'upsert') {
          const restore = await trySyncKnowledgeEntryToVault(
            novelId,
            intent.entryId,
            'reconcileVaultChangedFiles.restoreMirror',
          );
          if (restore === 'conflict') skipped++;
          else updated++;
          continue;
        }
        if (intent?.operation === 'delete') {
          await tryDeleteKnowledgeEntryFromVault(
            novelId,
            intent.entryId,
            intent.relPath,
            'reconcileVaultChangedFiles.confirmDelete',
          );
          deleted++;
          continue;
        }
        if (previousIndex) {
          const movedInSameBatch = Array.from(incomingIdsByPath.entries())
            .some(([path, id]) => path !== change.path && id === previousIndex.id);
          if (movedInSameBatch) {
            continue;
          }
          const danglingRefCleanup = await collectDanglingRefCleanup(novelId, previousIndex.id);
          await dbDeleteKnowledgeEntry(previousIndex.id, await buildDanglingRefCleanupUpdates(danglingRefCleanup));
          invalidateEmbeddingCache(novelId);
          scheduleCleanedDanglingRefRefreshes(novelId, danglingRefCleanup);
          deleted++;
        }
        continue;
      }

      const parsed = incoming.byChangeIndex.get(changeIndex);
      if (!parsed) {
        skipped++;
        continue;
      }
      const { entry, projection } = parsed;
      const intent = getKnowledgeVaultOutboxIntent(novelId, entry.id, change.path);
      if (intent?.operation === 'delete') {
        if (fencedPendingImport) {
          // The durable tombstone wins, but pending-root import is read-only
          // toward the filesystem. Established drain removes it afterward.
          updated++;
          continue;
        }
        await tryDeleteKnowledgeEntryFromVault(
          novelId,
          intent.entryId,
          intent.relPath ?? change.path,
          'reconcileVaultChangedFiles.rejectResurrection',
        );
        deleted++;
        continue;
      }
      if (allowUpsertMirrorReplay && intent?.operation === 'upsert') {
        const replay = await trySyncKnowledgeEntryToVault(
          novelId,
          intent.entryId,
          'reconcileVaultChangedFiles.replayMirror',
        );
        if (replay === 'conflict') {
          // Preserve both sides: external Markdown stays on disk; the pending
          // App DB version and exact outbox revision stay intact. Outbox has no
          // payload snapshot, so absorbing external into SQLite would destroy
          // the canonical App intent without a durable recovery copy.
          skipped++;
          continue;
        }
        updated++;
        continue;
      }
      const existing = await getKnowledgeEntryById(entry.id);
      if (existing && existing.novel_id !== novelId) {
        skipped++;
        continue;
      }
      const existingIndexForId = await getKnowledgeIndexById(entry.id);
      if (existingIndexForId && existingIndexForId.novelId !== novelId) {
        skipped++;
        continue;
      }
      if (
        existingIndexForId &&
        existingIndexForId.path !== change.path &&
        !deletedPaths.has(existingIndexForId.path)
      ) {
        skipped++;
        continue;
      }

      const proposedUpdatedAt = normalizeIsoTimestamp(projection.updatedAt) ?? nowIso();
      const proposedUpdatedAtMs = Date.parse(proposedUpdatedAt);
      const createdAt = normalizeIsoTimestamp(projection.createdAt) ?? proposedUpdatedAt;
      const dataJson = JSON.stringify(projection.data);
      if (dataJson.length > MAX_VAULT_ENTRY_DATA_JSON_LENGTH) {
        skipped++;
        continue;
      }
      const contentHash = await hashContent(change.content);
      if (existingIndexForId?.contentHash === contentHash) {
        setKnowledgeIndexMirrorContentHash(entry.id, contentHash);
        continue;
      }
      if (
        existing &&
        !(
          existingIndexForId &&
          existingIndexForId.path !== change.path &&
          deletedPaths.has(existingIndexForId.path)
        ) &&
        Number.isFinite(Date.parse(existing.updated_at)) &&
        Number.isFinite(proposedUpdatedAtMs) &&
        proposedUpdatedAtMs < Date.parse(existing.updated_at)
      ) {
        if (fencedPendingImport) {
          // Bootstrap applies this DB-newer mirror after releasing the root
          // lock, using the same expected root and generation.
          enqueueKnowledgeVaultUpsertForCurrentEntry(entry.id);
          updated++;
          continue;
        }
        const staleReplay = await trySyncKnowledgeEntryToVault(
          novelId,
          entry.id,
          'reconcileVaultChangedFiles.rejectStaleMirror',
        );
        if (staleReplay === 'conflict') {
          skipped++;
          continue;
        }
        updated++;
        continue;
      }
      const previousEntry = previousIndex && previousIndex.id !== entry.id
        ? await getKnowledgeEntryById(previousIndex.id)
        : undefined;

      let sortOrder: number;
      if (existing) {
        sortOrder = existing.sort_order;
      } else if (previousEntry?.novel_id === novelId) {
        sortOrder = previousEntry.sort_order;
      } else {
        sortOrder = await takeNextSortOrder();
      }
      const replacedPreviousId = previousIndex?.id !== entry.id ? previousIndex?.id : undefined;
      const danglingRefCleanup = replacedPreviousId
        ? await collectDanglingRefCleanup(novelId, replacedPreviousId)
        : [];
      await replaceVaultKnowledgeProjection({
        previousId: replacedPreviousId,
        entry: {
          id: entry.id,
          novelId,
          type: entry.type,
          title: projection.title,
          summary: projection.summary.slice(0, 500),
          data: dataJson,
          sortOrder,
          tags: JSON.stringify(projection.tags),
          createdAt,
          updatedAt: proposedUpdatedAt,
        },
        index: {
          id: entry.id,
          novelId,
          type: entry.type,
          path: change.path,
          title: projection.title,
          tags: JSON.stringify(projection.tags),
          aliases: JSON.stringify(normalizeKnowledgeAliases(entry.frontmatter.aliases)),
          importance: normalizeImportance(entry.frontmatter.importance),
          data: dataJson,
          outgoingLinks: JSON.stringify(outgoingLinksFor(entry)),
          contentHash,
          updatedAt: proposedUpdatedAt,
        },
        cleanupUpdates: await buildDanglingRefCleanupUpdates(danglingRefCleanup),
      });
      setKnowledgeIndexMirrorContentHash(entry.id, contentHash);
      if (replacedPreviousId) {
        invalidateEmbeddingCache(novelId);
        scheduleCleanedDanglingRefRefreshes(novelId, danglingRefCleanup);
      }
      if (!previousIndex || previousIndex.id !== entry.id || previousIndex.contentHash !== contentHash) {
        invalidateEmbeddingCache(novelId);
        queueMicrotask(() => {
          void upsertEntryEmbedding(entry.id);
        });
      }
      updated++;
    } catch (err) {
      skipped++;
      console.warn('[vault/reconcile] skipped changed file', change.path, err);
    }
  }

  return { updated, deleted, skipped };
}

type ParsedVaultChange = {
  entry: VaultEntry;
  projection: ReturnType<typeof projectEntryForLegacy>;
};

function collectIncomingVaultEntries(
  novelId: string,
  changes: VaultChangedFileInput[],
): { byChangeIndex: Map<number, ParsedVaultChange>; idsByPath: Map<string, string> } {
  const byChangeIndex = new Map<number, ParsedVaultChange>();
  const idsByPath = new Map<string, string>();
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    if (change.content === null) continue;
    try {
      const parsed = parseMarkdownToEntry(novelId, change.path, change.content);
      const entry = normalizeVaultEntryForPersistence(parsed.entry, change.path);
      byChangeIndex.set(index, {
        entry,
        projection: projectEntryForLegacy(entry),
      });
      idsByPath.set(change.path, entry.id);
    } catch {
      // The main reconcile loop will count malformed content as skipped.
    }
  }
  return { byChangeIndex, idsByPath };
}

type DanglingRefCleanup = {
  row: KnowledgeEntryRow;
  data: string;
  updatedAt: string;
};

async function collectDanglingRefCleanup(
  novelId: string,
  deletedEntryId: string,
): Promise<DanglingRefCleanup[]> {
  const siblings = (await getKnowledgeEntriesByNovel(novelId)).filter(row => row.id !== deletedEntryId);
  const updatedAt = nowIso();
  return siblings.flatMap(row => {
    const data = parseJsonField<Record<string, unknown>>(row.data, {});
    const cleaned = removeDanglingRefs(data, deletedEntryId);
    const originalJson = JSON.stringify(data);
    const cleanedJson = JSON.stringify(cleaned);
    return cleanedJson === originalJson ? [] : [{ row, data: cleanedJson, updatedAt }];
  });
}

async function buildDanglingRefCleanupUpdates(dirty: DanglingRefCleanup[]) {
  return Promise.all(dirty.map(async item => {
    const data = parseJsonField<Record<string, unknown>>(item.data, {});
    return {
      id: item.row.id,
      data: item.data,
      updatedAt: item.updatedAt,
      index: await buildKnowledgeIndexInsert({
        id: item.row.id,
        novelId: item.row.novel_id,
        type: item.row.type as KnowledgeType,
        title: item.row.title,
        summary: item.row.summary,
        data,
        tags: parseJsonField<string[]>(item.row.tags, []),
        updatedAt: item.updatedAt,
      }),
    };
  }));
}

function scheduleCleanedDanglingRefRefreshes(
  novelId: string,
  dirty: DanglingRefCleanup[],
): void {
  if (dirty.length === 0) return;

  // The transaction already removed every stale vector. A crash can now leave
  // a safe missing vector to rebuild, never a vector for relations that no
  // longer exist.
  invalidateEmbeddingCache(novelId);
  for (const item of dirty) {
    queueMicrotask(() => {
      void upsertEntryEmbedding(item.row.id);
    });
  }
}

function normalizeVaultChangedFiles(files: unknown): VaultChangedFileInput[] {
  if (!Array.isArray(files)) throw new Error('Invalid vault change payload');
  if (files.length > MAX_VAULT_CHANGED_FILES) {
    throw new Error('Vault change payload is too large');
  }
  return files.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid vault change payload');
    const record = item as Record<string, unknown>;
    const path = validateVaultRelativeMarkdownPath(record.path);
    const content = record.content;
    if (content !== null && typeof content !== 'string') {
      throw new Error('Invalid vault file content');
    }
    if (typeof content === 'string' && Buffer.byteLength(content, 'utf8') > MAX_VAULT_FILE_CONTENT_LENGTH) {
      throw new Error('Vault file is too large');
    }
    return { path, content };
  });
}

function normalizeVaultReconcileOptions(options: unknown): VaultReconcileOptions {
  if (!options || typeof options !== 'object') return {};
  const record = options as Record<string, unknown>;
  const allowUpsertMirrorReplay = record.allowUpsertMirrorReplay === false
    ? false
    : record.allowUpsertMirrorReplay === true
      ? true
      : undefined;
  const rootFence = normalizeVaultRootFence(record.rootFence);
  const effectiveAllowUpsertMirrorReplay = rootFence
    ? false
    : allowUpsertMirrorReplay;
  const rawHints = record.deletedPathsHint;
  if (rawHints === undefined) {
    return {
      ...(effectiveAllowUpsertMirrorReplay === undefined
        ? {}
        : { allowUpsertMirrorReplay: effectiveAllowUpsertMirrorReplay }),
      ...(rootFence ? { rootFence } : {}),
    };
  }
  if (!Array.isArray(rawHints) || rawHints.length > MAX_VAULT_DELETED_PATH_HINTS) {
    throw new Error('Invalid vault reconcile options');
  }
  const deletedPathsHint = Array.from(new Set(
    rawHints.map(path => validateVaultRelativeMarkdownPath(path)),
  ));
  return {
    deletedPathsHint,
    ...(effectiveAllowUpsertMirrorReplay === undefined
      ? {}
      : { allowUpsertMirrorReplay: effectiveAllowUpsertMirrorReplay }),
    ...(rootFence ? { rootFence } : {}),
  };
}

function normalizeVaultRootFence(value: unknown): VaultRootFence | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid Vault root fence');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.expectedRoot !== 'string'
    || !Number.isSafeInteger(record.expectedToken)
    || (record.expectedToken as number) >= 0
  ) {
    throw new Error('Invalid Vault root fence');
  }
  return {
    expectedRoot: validateVaultPathInput(record.expectedRoot),
    expectedToken: record.expectedToken as number,
  };
}

function validateVaultRelativeMarkdownPath(path: unknown): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_VAULT_PATH_LENGTH) {
    throw new Error('Invalid vault file path');
  }
  if (CONTROL_CHARS.test(path) || path.startsWith('/') || path.includes('\\')) {
    throw new Error('Invalid vault file path');
  }
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid vault file path');
  }
  if (parts.length !== 2 || !path.endsWith('.md') || !vaultTypeForDir(parts[0])) {
    throw new Error('Invalid vault file path');
  }
  return path;
}

function normalizeVaultEntryForPersistence(entry: VaultEntry, path: string): VaultEntry {
  const type = vaultTypeForPath(path);
  if (!type) throw new Error('Invalid vault file path');
  const fallbackTitle = path.split('/').pop()?.replace(/\.md$/i, '') || 'Untitled';
  const rawId = typeof entry.frontmatter.id === 'string' ? entry.frontmatter.id : entry.id;
  const id = normalizeEntryId(rawId, entry.novelId, path);
  const title = normalizeTitle(entry.frontmatter.title, fallbackTitle);
  return {
    ...entry,
    id,
    type,
    frontmatter: {
      ...entry.frontmatter,
      id,
      type,
      title,
      tags: normalizeKnowledgeTags(entry.frontmatter.tags),
    },
  };
}

function normalizeEntryId(id: unknown, novelId: string, path: string): string {
  if (typeof id === 'string') {
    const clean = id.trim();
    if (
      clean.length > 0 &&
      clean.length <= MAX_VAULT_ENTRY_ID_LENGTH &&
      !CONTROL_CHARS.test(clean) &&
      isUuid(clean)
    ) {
      return clean;
    }
  }
  return deterministicVaultEntryId(novelId, path);
}

function deterministicVaultEntryId(novelId: string, path: string): string {
  const bytes = Buffer.from(createHash('sha256').update(`vault-entry:${novelId}:${path}`).digest('hex'), 'hex').subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeTitle(title: unknown, fallback: string): string {
  const clean = typeof title === 'string' ? title.trim() : '';
  return (clean || fallback).slice(0, 200);
}

function normalizeImportance(value: unknown): 'low' | 'normal' | 'high' | null {
  if (value === 'low' || value === 'normal' || value === 'high') return value;
  if (value === 'major') return 'high';
  if (value === 'minor') return 'normal';
  return null;
}

function normalizeIsoTimestamp(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}
