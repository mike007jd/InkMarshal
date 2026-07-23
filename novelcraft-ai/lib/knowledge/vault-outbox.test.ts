import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const vaultSync = vi.hoisted(() => ({
  sync: vi.fn<() => Promise<void>>(),
  remove: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/lib/vault/server-sync', () => ({
  syncKnowledgeEntryToVault: vaultSync.sync,
  deleteKnowledgeEntryFromVault: vaultSync.remove,
}));

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-outbox-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

beforeEach(() => {
  vaultSync.sync.mockReset().mockResolvedValue();
  vaultSync.remove.mockReset().mockResolvedValue();
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function createIndexedEntry() {
  const db = await import('@/lib/db');
  const novel = await db.createNovel({ userId: 'vault-outbox-user', title: 'Vault outbox' });
  const now = new Date().toISOString();
  const entryId = crypto.randomUUID();
  const index = {
    id: entryId,
    novelId: novel.id,
    type: 'character',
    path: `characters/${entryId}.md`,
    title: 'Durable Mirror',
    tags: '[]',
    aliases: '[]',
    importance: null,
    data: '{}',
    outgoingLinks: '[]',
    contentHash: 'initial',
    updatedAt: now,
  };
  await db.createKnowledgeEntryWithIndex({
    id: entryId,
    novelId: novel.id,
    type: 'character',
    title: index.title,
    summary: '',
    data: '{}',
    sortOrder: 0,
    tags: '[]',
    createdAt: now,
    updatedAt: now,
  }, index);
  return { db, novel, entryId, index, now };
}

function outboxRow(entryId: string) {
  return import('@/lib/db/connection').then(({ getDb }) => getDb().prepare(
    'SELECT operation, rel_path, attempt_count, last_error FROM knowledge_vault_outbox WHERE entry_id = ?',
  ).get(entryId) as {
    operation: string;
    rel_path: string | null;
    attempt_count: number;
    last_error: string | null;
  } | undefined);
}

describe('knowledge vault durable outbox', () => {
  it('commits the mirror intent with the DB write and retries a failed upsert', async () => {
    const { db, novel, entryId, index, now } = await createIndexedEntry();
    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    try {
      expect(await outboxRow(entryId)).toMatchObject({ operation: 'upsert', rel_path: index.path });

      vaultSync.sync.mockRejectedValueOnce(new Error('injected mirror failure'));
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        attempt_count: 1,
        last_error: 'injected mirror failure',
      });

      vaultSync.sync.mockRejectedValueOnce(new Error('second injected mirror failure'));
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.second.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        attempt_count: 2,
        last_error: 'second injected mirror failure',
      });

      await db.updateKnowledgeEntryWithIndex(
        entryId,
        { summary: 'new canonical summary', updatedAt: new Date(Date.parse(now) + 1_000).toISOString() },
        { ...index, contentHash: 'updated', updatedAt: new Date(Date.parse(now) + 1_000).toISOString() },
      );
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.retry');
      expect(await outboxRow(entryId)).toBeUndefined();
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });

  it('retains a delete tombstone after mirror failure and success', async () => {
    const { db, novel, entryId, index } = await createIndexedEntry();
    const { tryDeleteKnowledgeEntryFromVault } = await import('@/lib/knowledge/apply-write');
    try {
      await db.deleteKnowledgeEntry(entryId);
      expect(await outboxRow(entryId)).toMatchObject({ operation: 'delete', rel_path: index.path });

      vaultSync.remove.mockRejectedValueOnce(new Error('injected delete failure'));
      await tryDeleteKnowledgeEntryFromVault(novel.id, entryId, index.path, 'test.delete.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        attempt_count: 1,
        last_error: 'injected delete failure',
      });

      vaultSync.remove.mockRejectedValueOnce(new Error('second injected delete failure'));
      await tryDeleteKnowledgeEntryFromVault(novel.id, entryId, index.path, 'test.delete.second.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        attempt_count: 2,
        last_error: 'second injected delete failure',
      });

      await tryDeleteKnowledgeEntryFromVault(novel.id, entryId, index.path, 'test.delete.retry');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        attempt_count: 0,
        last_error: null,
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });

  it('does not apply an old path tombstone to a new entry with a different id', async () => {
    const { db, novel, entryId, index } = await createIndexedEntry();
    const newEntryId = crypto.randomUUID();
    const now = new Date().toISOString();
    const {
      completeKnowledgeVaultUpsert,
      getKnowledgeVaultOutboxIntent,
    } = await import('@/lib/db/queries-knowledge-vault-outbox');
    try {
      await db.deleteKnowledgeEntry(entryId);
      await db.createKnowledgeEntryWithIndex({
        id: newEntryId,
        novelId: novel.id,
        type: 'character',
        title: 'Replacement entry',
        summary: '',
        data: '{}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      }, {
        ...index,
        id: newEntryId,
        title: 'Replacement entry',
        updatedAt: now,
      });
      completeKnowledgeVaultUpsert(newEntryId);

      expect(getKnowledgeVaultOutboxIntent(novel.id, newEntryId, index.path)).toBeNull();
      expect(getKnowledgeVaultOutboxIntent(novel.id, null, index.path)).toMatchObject({
        entryId,
        operation: 'delete',
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });
});
