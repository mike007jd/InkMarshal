import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-root-bootstrap-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function createUnboundNovelWithEntry(options?: {
  title?: string;
  updatedAt?: string;
}) {
  const db = await import('@/lib/db');
  const novel = await db.createNovel({ userId: 'local-user', title: 'Root bootstrap' });
  const now = options?.updatedAt ?? new Date().toISOString();
  const entryId = crypto.randomUUID();
  const relPath = `characters/${entryId}.md`;
  const title = options?.title ?? 'Canonical Character';
  await db.createKnowledgeEntryWithIndex({
    id: entryId,
    novelId: novel.id,
    type: 'character',
    title,
    summary: 'Survives empty vault bind',
    data: '{}',
    sortOrder: 0,
    tags: '[]',
    createdAt: now,
    updatedAt: now,
  }, {
    id: entryId,
    novelId: novel.id,
    type: 'character',
    path: relPath,
    title,
    tags: '[]',
    aliases: '[]',
    importance: null,
    data: '{}',
    outgoingLinks: '[]',
    contentHash: 'bootstrap-hash',
    updatedAt: now,
  });
  return { db, novel, entryId, relPath };
}

function writeVaultMarkdown(
  root: string,
  relPath: string,
  entryId: string,
  title: string,
  updatedAtMs: number,
): void {
  mkdirSync(path.join(root, 'characters'), { recursive: true });
  // projectEntryForLegacy only parses string timestamps; numeric YAML scalars
  // fall back to Date.now() and can lose to the canonical DB row.
  const iso = new Date(updatedAtMs).toISOString();
  writeFileSync(path.join(root, relPath), [
    '---',
    `id: ${entryId}`,
    'type: character',
    `title: ${title}`,
    `createdAt: "${iso}"`,
    `updatedAt: "${iso}"`,
    '---',
    `${title} body from vault`,
    '',
  ].join('\n'), 'utf8');
}

describe('vault root bootstrap / transition', () => {
  it('projects unbound canonical entries onto a newly bound empty root without deleting them', async () => {
    const { db, novel, entryId, relPath } = await createUnboundNovelWithEntry();
    const vaultRoot = mkdtempSync(path.join(tmpdir(), 'inkmarshal-empty-vault-'));
    mkdirSync(path.join(vaultRoot, 'characters'), { recursive: true });
    try {
      const { setNovelVaultPathAction } = await import('@/app/actions/vault');
      const { prepareVaultRootForReconcile } = await import('@/lib/vault/root-bootstrap');
      const { getKnowledgeEntry } = await import('@/lib/db');
      const { getNovelVault } = await import('@/lib/db/queries-vault');

      const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
      const { getKnowledgeVaultOutboxRow } = await import('@/lib/db/queries-knowledge-vault-outbox');
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.unbound');
      expect(getKnowledgeVaultOutboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
      });

      await setNovelVaultPathAction(novel.id, vaultRoot);
      const pending = await getNovelVault(novel.id);
      expect(pending).toMatchObject({
        vaultPath: vaultRoot,
      });
      expect(pending!.vaultVersion).toBeLessThanOrEqual(0);
      await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.pending.unfenced');
      expect(existsSync(path.join(vaultRoot, relPath))).toBe(false);
      expect(getKnowledgeVaultOutboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
      });

      const prep = await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultRoot,
        expectedToken: pending!.vaultVersion,
      });
      expect(prep).toEqual({
        vaultPath: vaultRoot,
        allowMissingFileDeletes: true,
        transitionToken: Math.abs(pending!.vaultVersion),
      });
      expect(await getNovelVault(novel.id)).toMatchObject({
        vaultVersion: Math.abs(pending!.vaultVersion),
      });
      expect(existsSync(path.join(vaultRoot, relPath))).toBe(true);
      expect(readFileSync(path.join(vaultRoot, relPath), 'utf8')).toContain('Canonical Character');
      expect(await getKnowledgeEntry(entryId, novel.id)).toMatchObject({
        title: 'Canonical Character',
      });
      expect(getKnowledgeVaultOutboxRow(entryId)).toBeNull();
    } finally {
      await db.deleteNovelCascade(novel.id, 'local-user');
      rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  it('projects canonical entries when switching from vault A to an empty vault B', async () => {
    const { db, novel, entryId, relPath } = await createUnboundNovelWithEntry();
    const vaultA = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-a-'));
    const vaultB = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-b-'));
    mkdirSync(path.join(vaultA, 'characters'), { recursive: true });
    mkdirSync(path.join(vaultB, 'characters'), { recursive: true });
    try {
      const { setNovelVaultPathAction } = await import('@/app/actions/vault');
      const { prepareVaultRootForReconcile } = await import('@/lib/vault/root-bootstrap');
      const { getKnowledgeEntry } = await import('@/lib/db');
      const { getNovelVault } = await import('@/lib/db/queries-vault');

      await setNovelVaultPathAction(novel.id, vaultA);
      const pendingA = await getNovelVault(novel.id);
      await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultA,
        expectedToken: pendingA!.vaultVersion,
      });
      expect(existsSync(path.join(vaultA, relPath))).toBe(true);
      expect(await getNovelVault(novel.id)).toMatchObject({
        vaultVersion: Math.abs(pendingA!.vaultVersion),
      });

      await setNovelVaultPathAction(novel.id, vaultB);
      const pendingB = await getNovelVault(novel.id);
      expect(pendingB).toMatchObject({ vaultPath: vaultB });
      expect(pendingB!.vaultVersion).toBeLessThanOrEqual(0);

      const prep = await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultB,
        expectedToken: pendingB!.vaultVersion,
      });
      expect(prep.allowMissingFileDeletes).toBe(true);
      expect(existsSync(path.join(vaultB, relPath))).toBe(true);
      expect(readFileSync(path.join(vaultB, relPath), 'utf8')).toContain('Canonical Character');
      expect(await getKnowledgeEntry(entryId, novel.id)).toMatchObject({
        title: 'Canonical Character',
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'local-user');
      rmSync(vaultA, { recursive: true, force: true });
      rmSync(vaultB, { recursive: true, force: true });
    }
  });

  it('imports newer Markdown from non-empty B before projecting and does not overwrite B', async () => {
    const olderAt = new Date('2020-01-01T00:00:00.000Z').toISOString();
    const newerMs = Date.parse('2024-06-01T12:00:00.000Z');
    const { db, novel, entryId, relPath } = await createUnboundNovelWithEntry({
      title: 'From Database A',
      updatedAt: olderAt,
    });
    const vaultA = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-a-newer-'));
    const vaultB = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-b-newer-'));
    mkdirSync(path.join(vaultA, 'characters'), { recursive: true });
    try {
      const { setNovelVaultPathAction } = await import('@/app/actions/vault');
      const { prepareVaultRootForReconcile } = await import('@/lib/vault/root-bootstrap');
      const { getKnowledgeEntry } = await import('@/lib/db');
      const { getNovelVault } = await import('@/lib/db/queries-vault');

      await setNovelVaultPathAction(novel.id, vaultA);
      const pendingA = await getNovelVault(novel.id);
      await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultA,
        expectedToken: pendingA!.vaultVersion,
      });

      writeVaultMarkdown(vaultB, relPath, entryId, 'From Vault B', newerMs);
      const bBefore = readFileSync(path.join(vaultB, relPath), 'utf8');

      await setNovelVaultPathAction(novel.id, vaultB);
      const pendingB = await getNovelVault(novel.id);
      expect(pendingB!.vaultVersion).toBeLessThanOrEqual(0);

      const prep = await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultB,
        expectedToken: pendingB!.vaultVersion,
      });
      expect(prep.allowMissingFileDeletes).toBe(true);
      expect(readFileSync(path.join(vaultB, relPath), 'utf8')).toBe(bBefore);
      expect(await getKnowledgeEntry(entryId, novel.id)).toMatchObject({
        title: 'From Vault B',
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'local-user');
      rmSync(vaultA, { recursive: true, force: true });
      rmSync(vaultB, { recursive: true, force: true });
    }
  });

  it('keeps DB rows when a pending-root remove arrives while projection is still incomplete', async () => {
    const { db, novel, entryId, relPath } = await createUnboundNovelWithEntry();
    const vaultRoot = mkdtempSync(path.join(tmpdir(), 'inkmarshal-pending-remove-'));
    // Block mirror projection: `characters` must be a directory for writes.
    writeFileSync(path.join(vaultRoot, 'characters'), 'not-a-directory');
    try {
      const { setNovelVaultPathAction, reconcileVaultChangedFiles } = await import('@/app/actions/vault');
      const { prepareVaultRootForReconcile } = await import('@/lib/vault/root-bootstrap');
      const { getKnowledgeEntry } = await import('@/lib/db');
      const { getNovelVault } = await import('@/lib/db/queries-vault');
      const { getKnowledgeVaultOutboxRow } = await import('@/lib/db/queries-knowledge-vault-outbox');

      await setNovelVaultPathAction(novel.id, vaultRoot);
      const pending = await getNovelVault(novel.id);

      const failed = await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultRoot,
        expectedToken: pending!.vaultVersion,
      });
      expect(failed.allowMissingFileDeletes).toBe(false);
      expect(await getNovelVault(novel.id)).toMatchObject({
        vaultPath: vaultRoot,
        vaultVersion: pending!.vaultVersion,
      });
      expect(getKnowledgeVaultOutboxRow(entryId)).toMatchObject({
        operation: 'upsert',
        status: 'pending',
      });

      const removed = await reconcileVaultChangedFiles(novel.id, [
        { path: relPath, content: null },
      ]);
      expect(removed.deleted).toBe(0);
      expect(await getKnowledgeEntry(entryId, novel.id)).toMatchObject({
        title: 'Canonical Character',
      });

      rmSync(path.join(vaultRoot, 'characters'), { force: true });
      mkdirSync(path.join(vaultRoot, 'characters'), { recursive: true });
      const prep = await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultRoot,
        expectedToken: pending!.vaultVersion,
      });
      expect(prep.allowMissingFileDeletes).toBe(true);
      expect(existsSync(path.join(vaultRoot, relPath))).toBe(true);
      expect(await getKnowledgeEntry(entryId, novel.id)).toBeTruthy();
    } finally {
      await db.deleteNovelCascade(novel.id, 'local-user');
      rmSync(vaultRoot, { recursive: true, force: true });
    }
  });

  it('CAS-promotes only the matching path+token and rejects B→C stale establish', async () => {
    const { db, novel } = await createUnboundNovelWithEntry();
    const vaultB = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-stale-b-'));
    const vaultC = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-current-c-'));
    try {
      const {
        bindNovelVaultRoot,
        establishNovelVaultPath,
        getNovelVault,
      } = await import('@/lib/db/queries-vault');

      const boundB = await bindNovelVaultRoot(novel.id, vaultB);
      const boundC = await bindNovelVaultRoot(novel.id, vaultC);
      expect(boundC.vaultVersion).toBeLessThan(boundB.vaultVersion);
      expect(boundC.vaultVersion).toBeLessThanOrEqual(0);

      expect(await establishNovelVaultPath(novel.id, vaultB, boundB.vaultVersion)).toBe(false);
      expect(await getNovelVault(novel.id)).toEqual({
        vaultPath: vaultC,
        vaultVersion: boundC.vaultVersion,
      });
      expect(await establishNovelVaultPath(novel.id, vaultC, boundC.vaultVersion)).toBe(true);
      expect(await getNovelVault(novel.id)).toEqual({
        vaultPath: vaultC,
        vaultVersion: Math.abs(boundC.vaultVersion),
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'local-user');
      rmSync(vaultB, { recursive: true, force: true });
      rmSync(vaultC, { recursive: true, force: true });
    }
  });

  it('keeps transition generations monotonic across establish and clear', async () => {
    const { db, novel } = await createUnboundNovelWithEntry();
    const vaultB = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-clear-b-'));
    try {
      const {
        bindNovelVaultRoot,
        clearNovelVaultPath,
        establishNovelVaultPath,
        getNovelVault,
      } = await import('@/lib/db/queries-vault');

      const first = await bindNovelVaultRoot(novel.id, vaultB);
      expect(await establishNovelVaultPath(novel.id, vaultB, first.vaultVersion)).toBe(true);
      const established = (await getNovelVault(novel.id))!;
      expect(established.vaultVersion).toBe(Math.abs(first.vaultVersion));

      await clearNovelVaultPath(novel.id);
      const cleared = (await getNovelVault(novel.id))!;
      expect(cleared.vaultPath).toBeNull();
      expect(cleared.vaultVersion).toBeGreaterThan(established.vaultVersion);

      const rebound = await bindNovelVaultRoot(novel.id, vaultB);
      expect(Math.abs(rebound.vaultVersion)).toBeGreaterThan(cleared.vaultVersion);
      expect(await establishNovelVaultPath(novel.id, vaultB, first.vaultVersion)).toBe(false);
    } finally {
      await db.deleteNovelCascade(novel.id, 'local-user');
      rmSync(vaultB, { recursive: true, force: true });
    }
  });

  it('rejects a stale B→C→B bootstrap token so an old generation cannot overwrite the new B', async () => {
    const { db, novel, entryId, relPath } = await createUnboundNovelWithEntry({
      title: 'Canonical',
      updatedAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    });
    const vaultB = mkdtempSync(path.join(tmpdir(), 'inkmarshal-aba-b-'));
    const vaultC = mkdtempSync(path.join(tmpdir(), 'inkmarshal-aba-c-'));
    mkdirSync(path.join(vaultB, 'characters'), { recursive: true });
    mkdirSync(path.join(vaultC, 'characters'), { recursive: true });
    try {
      const { setNovelVaultPathAction } = await import('@/app/actions/vault');
      const { prepareVaultRootForReconcile } = await import('@/lib/vault/root-bootstrap');
      const {
        establishNovelVaultPath,
        getNovelVault,
      } = await import('@/lib/db/queries-vault');
      const { getKnowledgeEntry } = await import('@/lib/db');
      const { syncKnowledgeEntryToVault } = await import('@/lib/vault/server-sync');

      await setNovelVaultPathAction(novel.id, vaultB);
      const tokenB1 = (await getNovelVault(novel.id))!.vaultVersion;
      await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultB,
        expectedToken: tokenB1,
      });

      await setNovelVaultPathAction(novel.id, vaultC);
      const tokenC = (await getNovelVault(novel.id))!.vaultVersion;
      expect(Math.abs(tokenC)).toBeGreaterThan(Math.abs(tokenB1));
      await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultC,
        expectedToken: tokenC,
      });

      // Rebind the exact same B path (ABA) with a newer generation.
      writeVaultMarkdown(
        vaultB,
        relPath,
        entryId,
        'Protected New B',
        Date.parse('2024-06-01T00:00:00.000Z'),
      );
      const protectedBefore = readFileSync(path.join(vaultB, relPath), 'utf8');
      await setNovelVaultPathAction(novel.id, vaultB);
      const tokenB2 = (await getNovelVault(novel.id))!.vaultVersion;
      expect(Math.abs(tokenB2)).toBeGreaterThan(Math.abs(tokenC));

      const stale = await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultB,
        expectedToken: tokenB1,
      });
      expect(stale.allowMissingFileDeletes).toBe(false);
      expect(stale.vaultPath).toBe(vaultB);
      expect(await establishNovelVaultPath(novel.id, vaultB, tokenB1)).toBe(false);

      const skipped = await syncKnowledgeEntryToVault(novel.id, entryId, {
        expectedRoot: vaultB,
        expectedToken: tokenB1,
      });
      expect(skipped).toBe('skipped_stale_root');
      expect(readFileSync(path.join(vaultB, relPath), 'utf8')).toBe(protectedBefore);

      const current = await prepareVaultRootForReconcile(novel.id, {
        expectedRoot: vaultB,
        expectedToken: tokenB2,
      });
      expect(current.allowMissingFileDeletes).toBe(true);
      expect(readFileSync(path.join(vaultB, relPath), 'utf8')).toContain('Protected New B');
      expect(await getKnowledgeEntry(entryId, novel.id)).toMatchObject({
        title: 'Protected New B',
      });
    } finally {
      await db.deleteNovelCascade(novel.id, 'local-user');
      rmSync(vaultB, { recursive: true, force: true });
      rmSync(vaultC, { recursive: true, force: true });
    }
  });
});
