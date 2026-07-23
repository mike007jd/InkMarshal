// Shared side effects for a knowledge-entry write. Centralised so the update
// server action and the AI-summarize route (the one justified route write path —
// it streams a model call + honours AbortSignal, see docs/adr/0001) apply the
// SAME sequence: DB row + index + mirror intent in one transaction, then a
// retryable vault `.md` projection, embedding invalidation, and a scheduled
// re-embed.

import { updateKnowledgeEntryWithIndex } from '@/lib/db';
import { deleteKnowledgeEmbedding } from '@/lib/db/queries-knowledge-vault';
import { invalidateEmbeddingCache, upsertEntryEmbedding } from '@/lib/knowledge/embedding';
import {
  deleteKnowledgeEntryFromVault,
  syncKnowledgeEntryToVault,
} from '@/lib/vault/server-sync';
import type { KnowledgeIndexInsert } from '@/lib/db/queries-vault';
import {
  completeKnowledgeVaultDelete,
  completeKnowledgeVaultUpsert,
  enqueueKnowledgeVaultDeleteIntent,
  enqueueKnowledgeVaultUpsertForCurrentEntry,
  recordKnowledgeVaultFailure,
} from '@/lib/db/queries-knowledge-vault-outbox';

export interface KnowledgeEntryWriteFields {
  title?: string;
  type?: string;
  summary?: string;
  data?: string;
  tags?: string;
  updatedAt: string;
}

/**
 * Fire-and-forget embedding refresh. Schedules via `queueMicrotask` so the
 * caller returns immediately; failures are logged inside `upsertEntryEmbedding`.
 */
export function scheduleEmbeddingRefresh(entryId: string): void {
  queueMicrotask(() => {
    upsertEntryEmbedding(entryId).catch(err => {
      console.warn('[knowledge] embedding refresh failed', err);
    });
  });
}

/** Drop the stale embedding row + invalidate the per-novel cache after a write. */
export async function clearStaleEmbedding(entryId: string, novelId: string): Promise<void> {
  await deleteKnowledgeEmbedding(entryId);
  invalidateEmbeddingCache(novelId);
}

function warnVaultSyncFailure(action: string, error: unknown): void {
  console.warn('[knowledge] vault markdown sync failed', { action }, error);
}

/** Attempt the durable mirror intent without making Vault the source of truth. */
export async function trySyncKnowledgeEntryToVault(
  novelId: string,
  entryId: string,
  action: string,
): Promise<void> {
  enqueueKnowledgeVaultUpsertForCurrentEntry(entryId);
  try {
    await syncKnowledgeEntryToVault(novelId, entryId);
    completeKnowledgeVaultUpsert(entryId);
  } catch (error) {
    recordKnowledgeVaultFailure(entryId, error);
    warnVaultSyncFailure(action, error);
  }
}

/** Attempt the durable delete intent while retaining its tombstone. */
export async function tryDeleteKnowledgeEntryFromVault(
  novelId: string,
  entryId: string,
  relPath: string | null,
  action: string,
): Promise<void> {
  enqueueKnowledgeVaultDeleteIntent({ entryId, novelId, relPath });
  try {
    await deleteKnowledgeEntryFromVault(novelId, entryId, relPath);
    completeKnowledgeVaultDelete(entryId);
  } catch (error) {
    recordKnowledgeVaultFailure(entryId, error);
    warnVaultSyncFailure(action, error);
  }
}

/**
 * Apply a knowledge-entry update everywhere it must land: the DB row + recall
 * index + mirror intent (one transaction), then the retryable vault `.md`
 * projection, embedding invalidation, and scheduled re-embed. Shared by
 * `updateKnowledgeEntry` and the
 * summarize route so a new write path (or a change to the side-effect order)
 * lives in exactly one place.
 */
export async function applyKnowledgeEntryWrite(args: {
  entryId: string;
  novelId: string;
  fields: KnowledgeEntryWriteFields;
  index: KnowledgeIndexInsert;
  /** Label used in vault-sync failure logs. */
  context: string;
}): Promise<void> {
  const { entryId, novelId, fields, index, context } = args;
  await updateKnowledgeEntryWithIndex(entryId, fields, index);
  await trySyncKnowledgeEntryToVault(novelId, entryId, context);
  await clearStaleEmbedding(entryId, novelId);
  scheduleEmbeddingRefresh(entryId);
}
