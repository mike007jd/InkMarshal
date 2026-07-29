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
  getKnowledgeVaultOutboxRow,
  recordKnowledgeVaultFailure,
} from '@/lib/db/queries-knowledge-vault-outbox';
import type { VaultRootFence } from '@/lib/vault/types';

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

const vaultEntryWriteTails = new Map<string, Promise<void>>();

/**
 * File I/O cannot participate in the SQLite transaction. Serialize attempts
 * for one entry so an older write can never finish after a newer upsert/delete
 * and leave Markdown stale even though revision CAS protected the outbox row.
 */
async function withVaultEntryWriteLock(
  entryId: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = vaultEntryWriteTails.get(entryId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(() => undefined, () => undefined);
  vaultEntryWriteTails.set(entryId, tail);
  try {
    await run;
  } finally {
    if (vaultEntryWriteTails.get(entryId) === tail) {
      vaultEntryWriteTails.delete(entryId);
    }
  }
}

/**
 * Attempt a vault upsert for an already-enqueued intent revision without
 * re-enqueueing (drain / deferred-I/O CAS path).
 */
export async function attemptKnowledgeVaultUpsert(
  novelId: string,
  entryId: string,
  intentRevision: number,
  action: string,
  fence?: VaultRootFence,
): Promise<void> {
  await withVaultEntryWriteLock(entryId, async () => {
    const current = getKnowledgeVaultOutboxRow(entryId);
    if (
      current?.operation !== 'upsert'
      || current.status !== 'pending'
      || current.intentRevision !== intentRevision
    ) {
      return;
    }
    try {
      const result = await syncKnowledgeEntryToVault(novelId, entryId, fence);
      if (result === 'skipped_unbound' || result === 'skipped_stale_root') {
        // Leave the durable intent pending until a root is configured /
        // the active transition generation matches.
        return;
      }
      // written or skipped_missing_entry (stale intent after hard DB delete)
      completeKnowledgeVaultUpsert(entryId, intentRevision);
    } catch (error) {
      recordKnowledgeVaultFailure(entryId, intentRevision, error);
      warnVaultSyncFailure(action, error);
    }
  });
}

/**
 * Attempt a vault delete for an already-enqueued intent revision without
 * re-enqueueing (drain / deferred-I/O CAS path).
 */
export async function attemptKnowledgeVaultDelete(
  novelId: string,
  entryId: string,
  relPath: string | null,
  intentRevision: number,
  action: string,
  fence?: VaultRootFence,
): Promise<void> {
  await withVaultEntryWriteLock(entryId, async () => {
    const current = getKnowledgeVaultOutboxRow(entryId);
    if (
      current?.operation !== 'delete'
      || current.status !== 'pending'
      || current.intentRevision !== intentRevision
    ) {
      return;
    }
    try {
      const result = await deleteKnowledgeEntryFromVault(novelId, entryId, relPath, fence);
      if (result === 'skipped_unbound' || result === 'skipped_stale_root') {
        return;
      }
      completeKnowledgeVaultDelete(entryId, intentRevision);
    } catch (error) {
      recordKnowledgeVaultFailure(entryId, intentRevision, error);
      warnVaultSyncFailure(action, error);
    }
  });
}

/** Attempt the durable mirror intent without making Vault the source of truth. */
export async function trySyncKnowledgeEntryToVault(
  novelId: string,
  entryId: string,
  action: string,
  fence?: VaultRootFence,
): Promise<void> {
  const intentRevision = enqueueKnowledgeVaultUpsertForCurrentEntry(entryId);
  if (intentRevision == null) return;
  await attemptKnowledgeVaultUpsert(novelId, entryId, intentRevision, action, fence);
}

/** Attempt the durable delete intent while retaining its tombstone. */
export async function tryDeleteKnowledgeEntryFromVault(
  novelId: string,
  entryId: string,
  relPath: string | null,
  action: string,
): Promise<void> {
  const intentRevision = enqueueKnowledgeVaultDeleteIntent({ entryId, novelId, relPath });
  await attemptKnowledgeVaultDelete(novelId, entryId, relPath, intentRevision, action);
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
