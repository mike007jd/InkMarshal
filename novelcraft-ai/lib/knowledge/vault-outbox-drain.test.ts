import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const vaultSync = vi.hoisted(() => ({
  sync: vi.fn<() => Promise<'written' | 'skipped_unbound' | 'skipped_missing_entry'>>(),
  remove: vi.fn<() => Promise<'written' | 'skipped_unbound' | 'skipped_missing_entry'>>(),
}));

vi.mock('@/lib/vault/server-sync', () => ({
  syncKnowledgeEntryToVault: vaultSync.sync,
  deleteKnowledgeEntryFromVault: vaultSync.remove,
}));

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-outbox-drain-'));
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

async function createIndexedEntry(options?: { vaultPath?: string | null }) {
  const db = await import('@/lib/db');
  const novel = await db.createNovel({ userId: 'vault-drain-user', title: 'Vault drain' });
  const vaultPath = options?.vaultPath === undefined
    ? mkdtempSync(path.join(tmpdir(), 'inkmarshal-reachable-vault-'))
    : options.vaultPath;
  if (vaultPath) {
    mkdirSync(vaultPath, { recursive: true });
    const { getDb } = await import('@/lib/db/connection');
    getDb().prepare('UPDATE novels SET vault_path = ? WHERE id = ?').run(vaultPath, novel.id);
  }
  const now = new Date().toISOString();
  const entryId = crypto.randomUUID();
  const index = {
    id: entryId,
    novelId: novel.id,
    type: 'character',
    path: `characters/${entryId}.md`,
    title: 'Drain Mirror',
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
  return { db, novel, entryId, index, vaultPath };
}

function outboxRow(entryId: string) {
  return import('@/lib/db/connection').then(({ getDb }) => getDb().prepare(
    'SELECT operation, status, attempt_count, last_error FROM knowledge_vault_outbox WHERE entry_id = ?',
  ).get(entryId) as {
    operation: string;
    status: string;
    attempt_count: number;
    last_error: string | null;
  } | undefined);
}

describe('drainKnowledgeVaultOutbox', () => {
  it('drains a failed startup upsert and reaches a terminal cleared state', async () => {
    const { db, novel, entryId } = await createIndexedEntry();
    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    const { drainKnowledgeVaultOutbox } = await import('@/lib/knowledge/vault-outbox-drain');
    try {
      vaultSync.sync.mockRejectedValueOnce(new Error('offline'));
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'seed.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
        attempt_count: 1,
        last_error: 'offline',
      });

      vaultSync.sync.mockResolvedValue('written');
      const result = await drainKnowledgeVaultOutbox(novel.id);
      expect(result).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
      expect(await outboxRow(entryId)).toBeUndefined();
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-drain-user');
    }
  });

  it('retains offline delete failures and does not replay successful tombstones forever', async () => {
    const { db, novel, entryId, index } = await createIndexedEntry();
    const { tryDeleteKnowledgeEntryFromVault } = await import('@/lib/knowledge/apply-write');
    const {
      drainKnowledgeVaultOutbox,
    } = await import('@/lib/knowledge/vault-outbox-drain');
    const { listPendingKnowledgeVaultOutbox } = await import('@/lib/db/queries-knowledge-vault-outbox');
    try {
      await db.deleteKnowledgeEntry(entryId);
      vaultSync.remove.mockRejectedValueOnce(new Error('offline delete'));
      await tryDeleteKnowledgeEntryFromVault(novel.id, entryId, index.path, 'seed.delete.failure');
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        status: 'pending',
        attempt_count: 1,
        last_error: 'offline delete',
      });

      vaultSync.remove.mockResolvedValue('written');
      const first = await drainKnowledgeVaultOutbox(novel.id);
      expect(first.completed).toBeGreaterThanOrEqual(1);
      expect(await outboxRow(entryId)).toMatchObject({
        operation: 'delete',
        status: 'completed',
        attempt_count: 0,
        last_error: null,
      });
      expect(listPendingKnowledgeVaultOutbox(novel.id).some(row => row.entryId === entryId)).toBe(false);

      vaultSync.remove.mockClear();
      const second = await drainKnowledgeVaultOutbox(novel.id);
      expect(second.attempted).toBe(0);
      expect(vaultSync.remove).not.toHaveBeenCalled();
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-drain-user');
    }
  });

  it('keeps failures pending across many attempts and never misreports attempt ceilings as completed', async () => {
    const { db, novel, entryId } = await createIndexedEntry();
    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    const { drainKnowledgeVaultOutbox } = await import('@/lib/knowledge/vault-outbox-drain');
    const { listPendingKnowledgeVaultOutbox } = await import('@/lib/db/queries-knowledge-vault-outbox');
    try {
      vaultSync.sync.mockRejectedValue(new Error('offline'));
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'seed');
      for (let i = 0; i < 8; i++) {
        const result = await drainKnowledgeVaultOutbox(novel.id);
        expect(result.completed).toBe(0);
        expect(result.failed).toBe(1);
        expect(await outboxRow(entryId)).toMatchObject({ status: 'pending' });
        expect(listPendingKnowledgeVaultOutbox(novel.id).some(row => row.entryId === entryId)).toBe(true);
      }
      expect((await outboxRow(entryId))!.attempt_count).toBeGreaterThanOrEqual(8);

      vaultSync.sync.mockResolvedValue('written');
      const recovered = await drainKnowledgeVaultOutbox(novel.id);
      expect(recovered).toMatchObject({ attempted: 1, completed: 1, failed: 0 });
      expect(await outboxRow(entryId)).toBeUndefined();
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-drain-user');
    }
  });

  it('skips unreachable vaults without consuming attempts', async () => {
    const { db, novel, entryId } = await createIndexedEntry();
    const { drainKnowledgeVaultOutbox } = await import('@/lib/knowledge/vault-outbox-drain');
    const { getDb } = await import('@/lib/db/connection');
    try {
      getDb().prepare('UPDATE novels SET vault_path = ? WHERE id = ?').run('/missing/vault/path', novel.id);
      const before = await outboxRow(entryId);
      expect(before).toMatchObject({ status: 'pending', attempt_count: 0 });
      vaultSync.sync.mockClear();
      const result = await drainKnowledgeVaultOutbox(novel.id);
      expect(result).toMatchObject({ attempted: 0, skipped: 1, completed: 0, failed: 0 });
      expect(vaultSync.sync).not.toHaveBeenCalled();
      expect(await outboxRow(entryId)).toEqual(before);
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-drain-user');
    }
  });

  it('skips pending roots until their non-destructive bootstrap is established', async () => {
    const { db, novel, entryId } = await createIndexedEntry();
    const { drainKnowledgeVaultOutbox } = await import('@/lib/knowledge/vault-outbox-drain');
    const { getDb } = await import('@/lib/db/connection');
    try {
      getDb().prepare('UPDATE novels SET vault_version = ? WHERE id = ?').run(-2, novel.id);
      const before = await outboxRow(entryId);
      vaultSync.sync.mockClear();

      const result = await drainKnowledgeVaultOutbox(novel.id);

      expect(result).toMatchObject({ attempted: 0, skipped: 1, completed: 0, failed: 0 });
      expect(vaultSync.sync).not.toHaveBeenCalled();
      expect(await outboxRow(entryId)).toEqual(before);
    } finally {
      await db.deleteNovelCascade(novel.id, 'vault-drain-user');
    }
  });
});
