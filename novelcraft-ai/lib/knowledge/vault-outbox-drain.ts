import 'server-only';

import { existsSync, statSync } from 'node:fs';

import {
  completeKnowledgeVaultUpsert,
  getKnowledgeVaultOutboxRow,
  listPendingKnowledgeVaultOutbox,
  type KnowledgeVaultOutboxRow,
} from '@/lib/db/queries-knowledge-vault-outbox';
import {
  attemptKnowledgeVaultDelete,
  attemptKnowledgeVaultUpsert,
} from '@/lib/knowledge/apply-write';
import { getDb } from '@/lib/db/connection';
import { getNovelVault, isVaultRootPending } from '@/lib/db/queries-vault';

export interface VaultOutboxDrainResult {
  attempted: number;
  completed: number;
  failed: number;
  skipped: number;
}

function entryStillExists(entryId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS present FROM knowledge_entries WHERE id = ?')
    .get(entryId) as { present: number } | undefined;
  return Boolean(row);
}

function vaultRootReachable(vaultPath: string | null | undefined): boolean {
  if (!vaultPath) return false;
  try {
    return existsSync(vaultPath) && statSync(vaultPath).isDirectory();
  } catch {
    return false;
  }
}

async function drainOne(row: KnowledgeVaultOutboxRow): Promise<'completed' | 'failed' | 'skipped'> {
  const vault = await getNovelVault(row.novelId);
  // Known-unreachable vaults must not consume a file-operation attempt.
  if (!vaultRootReachable(vault?.vaultPath) || isVaultRootPending(vault!.vaultVersion)) {
    return 'skipped';
  }

  if (row.operation === 'upsert') {
    if (!entryStillExists(row.entryId)) {
      // Stale mirror intent after a hard delete of the DB row — clear it only
      // when this exact revision is still current.
      completeKnowledgeVaultUpsert(row.entryId, row.intentRevision);
      return 'completed';
    }
    await attemptKnowledgeVaultUpsert(
      row.novelId,
      row.entryId,
      row.intentRevision,
      'outbox.drain.upsert',
    );
    const after = getKnowledgeVaultOutboxRow(row.entryId);
    if (!after) return 'completed';
    // A superseding enqueue during the attempt is not a failure of this drain.
    if (after.intentRevision !== row.intentRevision) return 'completed';
    return 'failed';
  }

  await attemptKnowledgeVaultDelete(
    row.novelId,
    row.entryId,
    row.relPath,
    row.intentRevision,
    'outbox.drain.delete',
  );
  const after = getKnowledgeVaultOutboxRow(row.entryId);
  if (!after) return 'failed';
  if (after.intentRevision !== row.intentRevision) return 'completed';
  if (after.status === 'completed') return 'completed';
  if (after.status === 'pending') return 'failed';
  // Unexpected disappearance of a delete tombstone — treat as failed to avoid
  // reporting completed without an explicit terminal state.
  return 'failed';
}

/** Retry pending vault mirror intents. Failures stay durable with attempt accounting. */
export async function drainKnowledgeVaultOutbox(novelId?: string): Promise<VaultOutboxDrainResult> {
  const pending = listPendingKnowledgeVaultOutbox(novelId);
  const result: VaultOutboxDrainResult = {
    attempted: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of pending) {
    try {
      const outcome = await drainOne(row);
      if (outcome === 'skipped') {
        result.skipped++;
        continue;
      }
      result.attempted++;
      if (outcome === 'completed') result.completed++;
      else result.failed++;
    } catch {
      result.attempted++;
      result.failed++;
    }
  }

  return result;
}
