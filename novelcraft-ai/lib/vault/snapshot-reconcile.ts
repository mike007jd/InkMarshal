'use client';

import {
  getVaultIndexedEntryRefsAction,
  reconcileVaultChangedFiles,
  type VaultIndexedEntryRef,
} from '@/app/actions/vault';
import { isVaultEntryPath, parseMarkdownToEntry, VAULT_RECONCILE_BATCH } from '@/lib/vault/entry';
import { vaultReadFile, vaultWalk } from '@/lib/vault/ipc';

const MAX_RECONCILE_FILE_SIZE = 128 * 1024;

export interface VaultSnapshotReconcileResult {
  updated: number;
  deleted: number;
  skipped: number;
}

export interface VaultSnapshotReconcileOptions {
  failOnReconcileError?: boolean;
}

export async function reconcileVaultSnapshot(
  novelId: string,
  vaultPath: string,
  options: VaultSnapshotReconcileOptions = {},
): Promise<VaultSnapshotReconcileResult> {
  const totals: VaultSnapshotReconcileResult = { updated: 0, deleted: 0, skipped: 0 };
  const files = (await vaultWalk(vaultPath)).filter(meta => isVaultEntryPath(meta.path));
  const presentPaths = new Set(files.map(meta => meta.path));
  const indexedRefs = await getIndexedEntryRefs(novelId, options);
  const missingIndexedRefs = indexedRefs.filter(ref => !presentPaths.has(ref.path));
  const missingPathById = new Map(missingIndexedRefs.map(ref => [ref.id, ref.path]));
  for (let i = 0; i < files.length; i += VAULT_RECONCILE_BATCH) {
    const chunk = files.slice(i, i + VAULT_RECONCILE_BATCH);
    const changes: { path: string; content: string | null }[] = [];
    for (const meta of chunk) {
      if (meta.size > MAX_RECONCILE_FILE_SIZE) {
        if (options.failOnReconcileError) {
          throw new Error(`Vault snapshot reconcile skipped oversized file: ${meta.path}`);
        }
        totals.skipped++;
        continue;
      }
      try {
        const { content } = await vaultReadFile(vaultPath, meta.path);
        changes.push({ path: meta.path, content });
      } catch (err) {
        if (options.failOnReconcileError) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Vault snapshot reconcile skipped unreadable file ${meta.path}: ${reason}`);
        }
        totals.skipped++;
        console.warn('[vault/snapshot] skipped unreadable file', meta.path, err);
      }
    }
    await reconcileSnapshotChanges(
      novelId,
      changes,
      totals,
      options,
      getDeletedPathsHintForChanges(novelId, changes, missingPathById),
    );
  }
  const missingIndexedPaths = missingIndexedRefs.map(ref => ref.path);
  for (let i = 0; i < missingIndexedPaths.length; i += VAULT_RECONCILE_BATCH) {
    const changes = missingIndexedPaths
      .slice(i, i + VAULT_RECONCILE_BATCH)
      .map(path => ({ path, content: null }));
    await reconcileSnapshotChanges(novelId, changes, totals, options);
  }
  return totals;
}

async function getIndexedEntryRefs(
  novelId: string,
  options: VaultSnapshotReconcileOptions,
): Promise<VaultIndexedEntryRef[]> {
  try {
    return await getVaultIndexedEntryRefsAction(novelId);
  } catch (err) {
    if (options.failOnReconcileError) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Vault snapshot reconcile failed to list indexed entries: ${reason}`);
    }
    console.warn('[vault/snapshot] failed to list indexed entries', err);
    return [];
  }
}

function getDeletedPathsHintForChanges(
  novelId: string,
  changes: { path: string; content: string | null }[],
  missingPathById: Map<string, string>,
): string[] {
  const hints = new Set<string>();
  for (const change of changes) {
    if (change.content === null) continue;
    try {
      const { entry } = parseMarkdownToEntry(novelId, change.path, change.content);
      const missingPath = missingPathById.get(entry.id);
      if (missingPath && missingPath !== change.path) hints.add(missingPath);
    } catch {
      // The server reconcile path will count malformed content as skipped.
    }
  }
  return Array.from(hints);
}

async function reconcileSnapshotChanges(
  novelId: string,
  changes: { path: string; content: string | null }[],
  totals: VaultSnapshotReconcileResult,
  options: VaultSnapshotReconcileOptions,
  deletedPathsHint: string[] = [],
): Promise<void> {
  if (changes.length === 0) return;
  try {
    const result = await reconcileVaultChangedFiles(
      novelId,
      changes,
      deletedPathsHint.length > 0 ? { deletedPathsHint } : undefined,
    );
    if (options.failOnReconcileError && result.skipped > 0) {
      throw new Error(`Vault snapshot reconcile skipped ${result.skipped} changed file(s)`);
    }
    totals.updated += result.updated;
    totals.deleted += result.deleted;
    totals.skipped += result.skipped;
  } catch (err) {
    if (options.failOnReconcileError) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Vault snapshot reconcile failed for ${changes.length} file(s): ${reason}`);
    }
    totals.skipped += changes.length;
    console.warn('[vault/snapshot] reconcile batch failed', err);
  }
}
