import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const vaultSync = vi.hoisted(() => ({
  sync: vi.fn<() => Promise<'written' | 'conflict' | 'skipped_unbound' | 'skipped_missing_entry' | 'skipped_stale_root'>>(),
  remove: vi.fn<() => Promise<'written' | 'conflict' | 'skipped_unbound' | 'skipped_missing_entry' | 'skipped_stale_root'>>(),
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
  vaultSync.sync.mockReset().mockResolvedValue('written');
  vaultSync.remove.mockReset().mockResolvedValue('written');
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
    'SELECT operation, rel_path, status, intent_revision, attempt_count, last_error FROM knowledge_vault_outbox WHERE entry_id = ?',
  ).get(entryId) as {
    operation: string;
    rel_path: string | null;
    status: string;
    intent_revision: number;
    attempt_count: number;
    last_error: string | null;
  } | undefined);
}

describe('knowledge vault durable outbox', () => {
  it('commits the mirror intent with the DB write and retries a failed upsert', async () => {
    const { db, novel, entryId, index, now } = await createIndexedEntry();
    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    try {
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
        rel_path: index.path,
      });

      vaultSync.sync.mockRejectedValueOnce(new Error('injected mirror failure'));
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
        attempt_count: 1,
        last_error: 'injected mirror failure',
      });

      vaultSync.sync.mockRejectedValueOnce(new Error('second injected mirror failure'));
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.second.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
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

  it('keeps the exact upsert revision pending on conditional-write conflict', async () => {
    const { db, novel, entryId } = await createIndexedEntry();
    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    try {
      vaultSync.sync.mockResolvedValueOnce('conflict');
      expect(await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.conflict')).toBe('conflict');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
        attempt_count: 1,
        last_error: expect.stringContaining('external edit since baseline'),
      });
      vaultSync.sync.mockResolvedValueOnce('written');
      expect(await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.conflict.retry')).toBe('completed');
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
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        status: 'pending',
        rel_path: index.path,
      });

      vaultSync.remove.mockRejectedValueOnce(new Error('injected delete failure'));
      await tryDeleteKnowledgeEntryFromVault(novel.id, entryId, index.path, 'test.delete.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        status: 'pending',
        attempt_count: 1,
        last_error: 'injected delete failure',
      });

      vaultSync.remove.mockRejectedValueOnce(new Error('second injected delete failure'));
      await tryDeleteKnowledgeEntryFromVault(novel.id, entryId, index.path, 'test.delete.second.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        status: 'pending',
        attempt_count: 2,
        last_error: 'second injected delete failure',
      });

      await tryDeleteKnowledgeEntryFromVault(novel.id, entryId, index.path, 'test.delete.retry');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        status: 'completed',
        attempt_count: 0,
        last_error: null,
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });

  it('treats same-millisecond enqueue+complete via explicit status, not timestamps', async () => {
    const { db, novel, entryId, index } = await createIndexedEntry();
    const { getDb } = await import('@/lib/db/connection');
    const { listPendingKnowledgeVaultOutbox } = await import('@/lib/db/queries-knowledge-vault-outbox');
    try {
      await db.deleteKnowledgeEntry(entryId);
      const ts = '2026-07-29T00:00:00.000Z';
      getDb().prepare(
        `UPDATE knowledge_vault_outbox
            SET status = 'completed', attempt_count = 0, last_error = NULL,
                created_at = ?, updated_at = ?
          WHERE entry_id = ?`,
      ).run(ts, ts, entryId);
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        status: 'completed',
        rel_path: index.path,
      });
      expect(listPendingKnowledgeVaultOutbox(novel.id).some(row => row.entryId === entryId)).toBe(false);
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
      const replacement = await outboxRow(newEntryId);
      expect(replacement).toMatchObject({ operation: 'upsert', status: 'pending' });
      completeKnowledgeVaultUpsert(newEntryId, replacement!.intent_revision);

      expect(getKnowledgeVaultOutboxIntent(novel.id, newEntryId, index.path)).toBeNull();
      expect(getKnowledgeVaultOutboxIntent(novel.id, null, index.path)).toMatchObject({
        entryId,
        operation: 'delete',
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });

  it('CAS-ignores a stale upsert completion after a newer upsert supersedes it', async () => {
    const { db, novel, entryId, index } = await createIndexedEntry();
    const { getDb } = await import('@/lib/db/connection');
    const {
      enqueueKnowledgeVaultUpsert,
      enqueueKnowledgeVaultUpsertForCurrentEntry,
    } = await import('@/lib/db/queries-knowledge-vault-outbox');
    const { attemptKnowledgeVaultUpsert } = await import('@/lib/knowledge/apply-write');
    try {
      const staleRevision = enqueueKnowledgeVaultUpsertForCurrentEntry(entryId)!;
      expect(staleRevision).toBeGreaterThanOrEqual(1);

      let releaseStale!: () => void;
      vaultSync.sync.mockImplementationOnce(() => new Promise(resolve => {
        releaseStale = () => resolve('written');
      }));
      const staleAttempt = attemptKnowledgeVaultUpsert(
        novel.id,
        entryId,
        staleRevision,
        'test.stale.upsert',
      );
      await vi.waitFor(() => expect(vaultSync.sync).toHaveBeenCalledTimes(1));

      const newerRevision = enqueueKnowledgeVaultUpsert(getDb(), {
        entryId,
        novelId: novel.id,
        relPath: index.path,
        updatedAt: new Date().toISOString(),
      });
      expect(newerRevision).toBe(staleRevision + 1);

      releaseStale!();
      await staleAttempt;

      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
        intent_revision: newerRevision,
        attempt_count: 0,
        last_error: null,
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });

  it('serializes file writes so a newer upsert finishes after an in-flight older write', async () => {
    const { db, novel, entryId, index } = await createIndexedEntry();
    const { getDb } = await import('@/lib/db/connection');
    const {
      enqueueKnowledgeVaultUpsert,
      enqueueKnowledgeVaultUpsertForCurrentEntry,
    } = await import('@/lib/db/queries-knowledge-vault-outbox');
    const { attemptKnowledgeVaultUpsert } = await import('@/lib/knowledge/apply-write');
    try {
      const staleRevision = enqueueKnowledgeVaultUpsertForCurrentEntry(entryId)!;
      let releaseStale!: () => void;
      vaultSync.sync.mockImplementationOnce(() => new Promise(resolve => {
        releaseStale = () => resolve('written');
      }));

      const staleAttempt = attemptKnowledgeVaultUpsert(
        novel.id,
        entryId,
        staleRevision,
        'test.serialized.stale',
      );
      await vi.waitFor(() => expect(vaultSync.sync).toHaveBeenCalledTimes(1));

      const newerRevision = enqueueKnowledgeVaultUpsert(getDb(), {
        entryId,
        novelId: novel.id,
        relPath: index.path,
        updatedAt: new Date().toISOString(),
      });
      const newerAttempt = attemptKnowledgeVaultUpsert(
        novel.id,
        entryId,
        newerRevision,
        'test.serialized.newer',
      );

      await Promise.resolve();
      expect(vaultSync.sync).toHaveBeenCalledTimes(1);
      releaseStale!();
      await Promise.all([staleAttempt, newerAttempt]);

      expect(vaultSync.sync).toHaveBeenCalledTimes(2);
      expect(await outboxRow(entryId)).toBeUndefined();
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });

  it('CAS-ignores a stale delete failure after a newer upsert supersedes it', async () => {
    const { db, novel, entryId, index } = await createIndexedEntry();
    const { getKnowledgeVaultOutboxRow } = await import('@/lib/db/queries-knowledge-vault-outbox');
    const { attemptKnowledgeVaultDelete } = await import('@/lib/knowledge/apply-write');
    try {
      await db.deleteKnowledgeEntry(entryId);
      const deleteRevision = getKnowledgeVaultOutboxRow(entryId)!.intentRevision;

      let releaseStale!: (error: Error) => void;
      vaultSync.remove.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        releaseStale = (error: Error) => reject(error);
      }));
      const staleAttempt = attemptKnowledgeVaultDelete(
        novel.id,
        entryId,
        index.path,
        deleteRevision,
        'test.stale.delete.failure',
      );
      await vi.waitFor(() => expect(vaultSync.remove).toHaveBeenCalledTimes(1));

      const now = new Date().toISOString();
      await db.createKnowledgeEntryWithIndex({
        id: entryId,
        novelId: novel.id,
        type: 'character',
        title: 'Resurrected',
        summary: '',
        data: '{}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      }, {
        ...index,
        title: 'Resurrected',
        updatedAt: now,
      });
      const upsertRow = getKnowledgeVaultOutboxRow(entryId)!;
      expect(upsertRow.operation).toBe('upsert');
      expect(upsertRow.intentRevision).toBeGreaterThan(deleteRevision);

      releaseStale!(new Error('stale delete offline'));
      await staleAttempt;

      expect(getKnowledgeVaultOutboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
        intentRevision: upsertRow.intentRevision,
        attemptCount: 0,
        lastError: null,
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });

  it('CAS-ignores a stale upsert failure after a newer delete supersedes it', async () => {
    const { db, novel, entryId } = await createIndexedEntry();
    const {
      enqueueKnowledgeVaultUpsertForCurrentEntry,
      getKnowledgeVaultOutboxRow,
    } = await import('@/lib/db/queries-knowledge-vault-outbox');
    const { attemptKnowledgeVaultUpsert } = await import('@/lib/knowledge/apply-write');
    try {
      const upsertRevision = enqueueKnowledgeVaultUpsertForCurrentEntry(entryId)!;

      let releaseStale!: (error: Error) => void;
      vaultSync.sync.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        releaseStale = (error: Error) => reject(error);
      }));
      const staleAttempt = attemptKnowledgeVaultUpsert(
        novel.id,
        entryId,
        upsertRevision,
        'test.stale.upsert.failure',
      );
      await vi.waitFor(() => expect(vaultSync.sync).toHaveBeenCalledTimes(1));

      await db.deleteKnowledgeEntry(entryId);
      const deleteRow = getKnowledgeVaultOutboxRow(entryId)!;
      expect(deleteRow.operation).toBe('delete');
      expect(deleteRow.intentRevision).toBeGreaterThan(upsertRevision);

      releaseStale!(new Error('stale upsert offline'));
      await staleAttempt;

      expect(getKnowledgeVaultOutboxRow(entryId)).toMatchObject({
        operation: 'delete',
        status: 'pending',
        intentRevision: deleteRow.intentRevision,
        attemptCount: 0,
        lastError: null,
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-outbox-user');
    }
  });
});
