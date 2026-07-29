import 'server-only';

import {
  isVaultEntryPath,
  VAULT_RECONCILE_BATCH,
} from '@/lib/vault/entry';
import { listKnowledgeIndexForNovel } from '@/lib/db/queries-knowledge-vault';
import {
  establishNovelVaultPath,
  getNovelVault,
  isVaultRootPending,
} from '@/lib/db/queries-vault';
import { listPendingKnowledgeVaultOutbox } from '@/lib/db/queries-knowledge-vault-outbox';
import { trySyncKnowledgeEntryToVault } from '@/lib/knowledge/apply-write';
import { readAnchoredVaultMarkdown } from '@/lib/vault/anchored-fs';
import type { VaultRootFence } from '@/lib/vault/types';

export interface VaultRootReconcilePrep {
  vaultPath: string | null;
  /** Missing Markdown may delete canonical SQLite rows only for established roots. */
  allowMissingFileDeletes: boolean;
  transitionToken: number | null;
}

function matchesFence(
  vault: { vaultPath: string | null; vaultVersion: number } | null,
  fence: VaultRootFence,
): boolean {
  return Boolean(
    vault?.vaultPath
    && vault.vaultPath === fence.expectedRoot
    && vault.vaultVersion === fence.expectedToken
    && isVaultRootPending(vault.vaultVersion),
  );
}

/**
 * Non-destructive import of Markdown already present on a pending root.
 * Conflict detection (updatedAt / contentHash) lives in reconcileVaultChangedFiles;
 * missing files are never emitted as deletes here.
 */
async function importPresentVaultFilesNonDestructive(
  novelId: string,
  fence: VaultRootFence,
): Promise<Set<string>> {
  const vault = await getNovelVault(novelId);
  if (!matchesFence(vault, fence)) return new Set();

  const present = await readAnchoredVaultMarkdown(fence.expectedRoot);
  const presentPaths = new Set(present.map(file => file.path));
  if (present.length === 0) return presentPaths;

  const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');
  for (let i = 0; i < present.length; i += VAULT_RECONCILE_BATCH) {
    if (!matchesFence(await getNovelVault(novelId), fence)) return presentPaths;
    const changes = present.slice(i, i + VAULT_RECONCILE_BATCH);
    if (!matchesFence(await getNovelVault(novelId), fence)) return presentPaths;
    if (changes.length > 0) {
      // Do not let durable upsert intents force DB→Vault during import — that
      // would recreate the P1 overwrite of a newer existing root.
      await reconcileVaultChangedFiles(novelId, changes, {
        allowUpsertMirrorReplay: false,
        rootFence: fence,
      });
    }
  }
  return presentPaths;
}

/**
 * After a non-destructive import, project missing paths and flush pending
 * upsert mirrors from the post-import canonical DB (never from a stale pre-import
 * snapshot).
 */
async function projectMissingCanonicalEntries(
  novelId: string,
  fence: VaultRootFence,
  presentPaths: ReadonlySet<string>,
): Promise<void> {
  const indexed = await listKnowledgeIndexForNovel(novelId);
  const pendingUpsertIds = new Set(
    listPendingKnowledgeVaultOutbox(novelId)
      .filter(row => row.operation === 'upsert')
      .map(row => row.entryId),
  );
  for (const entry of indexed) {
    if (!isVaultEntryPath(entry.path)) continue;
    if (!matchesFence(await getNovelVault(novelId), fence)) return;
    // Missing files must be projected. Present files with a durable upsert are
    // rewritten from the post-import DB (which already absorbed newer Markdown).
    if (presentPaths.has(entry.path) && !pendingUpsertIds.has(entry.id)) continue;
    await trySyncKnowledgeEntryToVault(
      novelId,
      entry.id,
      'vault.rootBootstrap',
      fence,
    );
  }
}

async function bootstrapNovelVaultRoot(
  novelId: string,
  fence: VaultRootFence,
): Promise<VaultRootReconcilePrep> {
  // Root lock is held inside each mirror write (server-sync) and bind/clear.
  // Bootstrap itself relies on expectedRoot+token fences so a stale generation
  // cannot write or promote after B→C / B→C→B.
  const vault = await getNovelVault(novelId);
  if (!vault?.vaultPath) {
    return { vaultPath: null, allowMissingFileDeletes: false, transitionToken: null };
  }
  if (!isVaultRootPending(vault.vaultVersion)) {
    return {
      vaultPath: vault.vaultPath,
      allowMissingFileDeletes: true,
      transitionToken: vault.vaultVersion,
    };
  }
  if (!matchesFence(vault, fence)) {
    // Stale generation (B→C or B→C→B with a newer token). Never write or promote.
    return {
      vaultPath: vault.vaultPath,
      allowMissingFileDeletes: false,
      transitionToken: vault.vaultVersion,
    };
  }

  // 1) Non-destructive read + conflict resolution into canonical DB.
  const presentPaths = await importPresentVaultFilesNonDestructive(novelId, fence);
  if (!matchesFence(await getNovelVault(novelId), fence)) {
    const current = await getNovelVault(novelId);
    return {
      vaultPath: current?.vaultPath ?? null,
      allowMissingFileDeletes: false,
      transitionToken: current?.vaultVersion ?? null,
    };
  }

  // 2) Project only missing / still-pending upsert mirrors onto the root.
  await projectMissingCanonicalEntries(novelId, fence, presentPaths);
  if (!matchesFence(await getNovelVault(novelId), fence)) {
    const current = await getNovelVault(novelId);
    return {
      vaultPath: current?.vaultPath ?? null,
      allowMissingFileDeletes: false,
      transitionToken: current?.vaultVersion ?? null,
    };
  }

  const pendingUpserts = listPendingKnowledgeVaultOutbox(novelId)
    .filter(row => row.operation === 'upsert');
  if (pendingUpserts.length === 0) {
    const established = await establishNovelVaultPath(
      novelId,
      fence.expectedRoot,
      fence.expectedToken,
    );
    if (established) {
      return {
        vaultPath: fence.expectedRoot,
        allowMissingFileDeletes: true,
        transitionToken: Math.abs(fence.expectedToken),
      };
    }
    const current = await getNovelVault(novelId);
    return {
      vaultPath: current?.vaultPath ?? null,
      allowMissingFileDeletes: false,
      transitionToken: current?.vaultVersion ?? null,
    };
  }

  return {
    vaultPath: fence.expectedRoot,
    allowMissingFileDeletes: false,
    transitionToken: fence.expectedToken,
  };
}

/**
 * Prepare a novel's Vault root for reconcile. Pending roots
 * (`vault_version <= 0`) run non-destructive import → missing-only projection →
 * CAS promotion. Callers must pass the fixed root+token captured for this attempt.
 */
export async function prepareVaultRootForReconcile(
  novelId: string,
  fence?: VaultRootFence,
): Promise<VaultRootReconcilePrep> {
  const vault = await getNovelVault(novelId);
  if (!vault?.vaultPath) {
    return { vaultPath: null, allowMissingFileDeletes: false, transitionToken: null };
  }
  if (!isVaultRootPending(vault.vaultVersion)) {
    return {
      vaultPath: vault.vaultPath,
      allowMissingFileDeletes: true,
      transitionToken: vault.vaultVersion,
    };
  }
  const resolvedFence = fence ?? {
    expectedRoot: vault.vaultPath,
    expectedToken: vault.vaultVersion,
  };
  return bootstrapNovelVaultRoot(novelId, resolvedFence);
}
