'use server';

import { getUser } from '@/lib/local-auth';
import { verifyNovelOwnership } from '@/lib/db';
import {
  drainKnowledgeVaultOutbox,
  type VaultOutboxDrainResult,
} from '@/lib/knowledge/vault-outbox-drain';

/** Drain pending vault outbox intents, optionally scoped to one owned novel. */
export async function drainKnowledgeVaultOutboxAction(
  novelId?: string,
): Promise<VaultOutboxDrainResult> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  if (novelId) {
    await verifyNovelOwnership(novelId, user.id);
  }
  return drainKnowledgeVaultOutbox(novelId);
}
