import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { __serverSyncTest } from '@/lib/vault/server-sync';
import {
  __anchoredFsTest,
  deleteAnchoredVaultEntry,
  readAnchoredVaultMarkdown,
  writeAnchoredVaultEntry,
  VaultMarkdownConflictError,
} from '@/lib/vault/anchored-fs';

let tmpRoot: string | null = null;

function tempDir(): string {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'inkmarshal-server-sync-'));
  return tmpRoot;
}

afterEach(() => {
  __anchoredFsTest.afterDirectoryValidated = null;
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe('vault server sync filesystem guard', () => {
  it('resolves only canonical top-level vault entry files', async () => {
    const root = tempDir();

    await writeAnchoredVaultEntry(root, 'characters/mira.md', 'Mira');

    const file = path.join(root, 'characters', 'mira.md');
    expect(await readFile(file, 'utf8')).toBe('Mira');
    expect(existsSync(path.join(root, 'characters'))).toBe(true);
    await expect(
      writeAnchoredVaultEntry(root, '../mira.md', 'bad'),
    ).rejects.toThrow('Invalid vault entry path');
    await expect(
      writeAnchoredVaultEntry(root, 'characters/nested/mira.md', 'bad'),
    ).rejects.toThrow('Invalid vault entry path');
    await expect(
      writeAnchoredVaultEntry(root, 'characters/../outline/mira.md', 'bad'),
    ).rejects.toThrow('Invalid vault entry path');
  });

  it('rejects symlinked vault roots and invalid entry parents', async () => {
    const workspace = tempDir();
    const realRoot = path.join(workspace, 'real-root');
    const linkedRoot = path.join(workspace, 'linked-root');
    const outside = path.join(workspace, 'outside');
    mkdirSync(realRoot);
    mkdirSync(outside);
    symlinkSync(realRoot, linkedRoot, 'dir');

    await expect(
      writeAnchoredVaultEntry(linkedRoot, 'characters/mira.md', 'bad'),
    ).rejects.toThrow('Invalid Vault root');

    const vaultRoot = path.join(workspace, 'vault-root');
    mkdirSync(vaultRoot);
    symlinkSync(outside, path.join(vaultRoot, 'characters'), 'dir');

    await expect(
      writeAnchoredVaultEntry(vaultRoot, 'characters/mira.md', 'bad'),
    ).rejects.toThrow('Invalid Vault entry directory');
    expect(existsSync(path.join(outside, 'mira.md'))).toBe(false);

    const fileParentRoot = path.join(workspace, 'file-parent-root');
    mkdirSync(fileParentRoot);
    await writeFile(path.join(fileParentRoot, 'characters'), 'not-a-directory');
    await expect(
      writeAnchoredVaultEntry(fileParentRoot, 'characters/mira.md', 'bad'),
    ).rejects.toThrow('Invalid Vault entry directory');
    expect(await readFile(path.join(fileParentRoot, 'characters'), 'utf8')).toBe(
      'not-a-directory',
    );
  });

  it('writes atomically and rejects oversized markdown', async () => {
    const root = tempDir();
    const file = path.join(root, 'characters', 'mira.md');

    await writeAnchoredVaultEntry(root, 'characters/mira.md', 'small markdown');
    expect(await readFile(file, 'utf8')).toBe('small markdown');
    await expect(
      writeAnchoredVaultEntry(root, 'characters/mira.md', 'x'.repeat(128 * 1024 + 1)),
    ).rejects.toThrow('Vault markdown is too large');
    expect(await readFile(file, 'utf8')).toBe('small markdown');
  });

  it('rejects a parent symlink swap before anchored traversal without writing outside', async () => {
    const workspace = tempDir();
    const root = path.join(workspace, 'vault');
    const outside = path.join(workspace, 'outside');
    const displaced = path.join(workspace, 'characters-original');
    mkdirSync(path.join(root, 'characters'), { recursive: true });
    mkdirSync(outside);
    let swapped = false;
    __anchoredFsTest.afterDirectoryValidated = () => {
      if (swapped) return;
      swapped = true;
      renameSync(path.join(root, 'characters'), displaced);
      symlinkSync(outside, path.join(root, 'characters'), 'dir');
    };

    await expect(
      writeAnchoredVaultEntry(root, 'characters/escaped.md', 'x'.repeat(128 * 1024)),
    ).rejects.toThrow('Invalid Vault entry directory');
    expect(existsSync(path.join(outside, 'escaped.md'))).toBe(false);
  });

  it('rejects a vault root ancestor swap without writing or deleting outside', async () => {
    const workspace = tempDir();
    const writeRoot = path.join(workspace, 'write-vault');
    const displacedWriteRoot = path.join(workspace, 'write-vault-original');
    const outsideWrite = path.join(workspace, 'outside-write');
    mkdirSync(path.join(writeRoot, 'characters'), { recursive: true });
    mkdirSync(path.join(outsideWrite, 'characters'), { recursive: true });
    __anchoredFsTest.afterDirectoryValidated = () => {
      renameSync(writeRoot, displacedWriteRoot);
      symlinkSync(outsideWrite, writeRoot, 'dir');
    };

    await expect(
      writeAnchoredVaultEntry(writeRoot, 'characters/escaped.md', 'outside write'),
    ).rejects.toThrow('Anchored Vault root identity changed');
    expect(existsSync(path.join(outsideWrite, 'characters', 'escaped.md'))).toBe(false);

    const deleteRoot = path.join(workspace, 'delete-vault');
    const displacedDeleteRoot = path.join(workspace, 'delete-vault-original');
    const outsideDelete = path.join(workspace, 'outside-delete');
    mkdirSync(path.join(deleteRoot, 'characters'), { recursive: true });
    mkdirSync(path.join(outsideDelete, 'characters'), { recursive: true });
    await writeFile(path.join(outsideDelete, 'characters', 'keep.md'), 'keep');
    __anchoredFsTest.afterDirectoryValidated = () => {
      renameSync(deleteRoot, displacedDeleteRoot);
      symlinkSync(outsideDelete, deleteRoot, 'dir');
    };

    await expect(
      deleteAnchoredVaultEntry(deleteRoot, 'characters/keep.md'),
    ).rejects.toThrow('Anchored Vault root identity changed');
    expect(await readFile(path.join(outsideDelete, 'characters', 'keep.md'), 'utf8')).toBe('keep');
  });

  it.runIf(process.platform !== 'win32')('rejects Markdown FIFOs without blocking bootstrap', async () => {
    const root = tempDir();
    const characters = path.join(root, 'characters');
    mkdirSync(characters);
    execFileSync('mkfifo', [path.join(characters, 'blocked.md')]);

    await expect(readAnchoredVaultMarkdown(root)).rejects.toThrow(
      'Invalid Vault bootstrap file: blocked.md',
    );
  });
});

// S5a: a data blob carrying reserved frontmatter keys (id/type/title/...) must
// NOT overwrite the canonical identity fields when folded into frontmatter.
// Before the fix the spread `...data` came AFTER the core fields, so a data
// payload with { id: 'X', type: 'world', title: 'Y' } corrupted the vault file's
// identity on the next round-trip (parseMarkdownToEntry trusts fm.id).
describe('vault server sync frontmatter identity (S5a)', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (tmpDir) {
      const { closeDbForTest } = await import('@/lib/db/connection');
      closeDbForTest();
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  async function renderWithData(data: Record<string, unknown>): Promise<string> {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const nodePath = await import('node:path');
    const prev = process.env.INKMARSHAL_DATA_DIR;
    tmpDir = mkdtempSync(nodePath.join(tmpdir(), 'inkmarshal-fm-'));
    process.env.INKMARSHAL_DATA_DIR = tmpDir;
    const { __serverSyncTest } = await import('@/lib/vault/server-sync');

    const row = {
      id: 'canonical-id',
      novel_id: 'novel-1',
      type: 'character' as const,
      title: 'Canonical Title',
      summary: '',
      data: JSON.stringify(data),
      sort_order: 0,
      tags: JSON.stringify(['protagonist']),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    };
    const md = await __serverSyncTest.renderKnowledgeEntryMarkdown(row, 'characters/canonical.md');
    process.env.INKMARSHAL_DATA_DIR = prev;
    return md;
  }

  it('does not let data keys overwrite canonical id/type/title', async () => {
    const md = await renderWithData({
      id: 'EVIL-ID',
      type: 'world',
      title: 'Evil Title',
      createdAt: '1999-01-01T00:00:00.000Z',
      description: 'a real data field that should survive',
    });

    // The canonical identity fields must win.
    expect(md).toContain('id: canonical-id');
    expect(md).toContain('type: character');
    expect(md).toContain('title: Canonical Title');
    expect(md).toContain('createdAt: "2026-01-01T00:00:00.000Z"');
    // The non-reserved data field survives.
    expect(md).toContain('a real data field that should survive');
    // The attacker values do NOT appear as identity.
    expect(md).not.toContain('EVIL-ID');
    expect(md).not.toContain('Evil Title');
    expect(md).not.toContain('1999-01-01');
  });
});

describe('established-root conditional Vault replace (external edit race)', () => {
  let dataDir: string | null = null;
  let vaultRoot: string | null = null;
  const previousDataDir = process.env.INKMARSHAL_DATA_DIR;

  afterEach(async () => {
    __anchoredFsTest.afterDirectoryValidated = null;
    __anchoredFsTest.mutateTargetBeforeInstallFile = null;
    __anchoredFsTest.recreateTargetAfterDisplaceFile = null;
    __anchoredFsTest.mutateOpenTargetAfterInstallFile = null;
    __anchoredFsTest.exitAfterDisplace = false;
    __anchoredFsTest.exitAfterInstall = false;
    __anchoredFsTest.exitAfterRecoveryLink = false;
    const { closeDbForTest } = await import('@/lib/db/connection');
    closeDbForTest();
    if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
    else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (vaultRoot) rmSync(vaultRoot, { recursive: true, force: true });
    dataDir = null;
    vaultRoot = null;
  });

  async function seedMirroredEntry(options?: { clearMirrorBaseline?: boolean }) {
    dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-conditional-db-'));
    vaultRoot = mkdtempSync(path.join(tmpdir(), 'inkmarshal-conditional-vault-'));
    process.env.INKMARSHAL_DATA_DIR = dataDir;
    const db = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const novel = await db.createNovel({
      userId: 'local-user',
      title: 'Conditional replace',
    });
    getDb().prepare(
      'UPDATE novels SET vault_path = ?, vault_version = 1 WHERE id = ?',
    ).run(vaultRoot, novel.id);
    const now = new Date().toISOString();
    const entryId = crypto.randomUUID();
    const relPath = `characters/${entryId}.md`;
    await db.createKnowledgeEntryWithIndex({
      id: entryId,
      novelId: novel.id,
      type: 'character',
      title: 'Baseline Hero',
      summary: 'original summary',
      data: JSON.stringify({ description: 'original description' }),
      sortOrder: 0,
      tags: '[]',
      createdAt: now,
      updatedAt: now,
    }, {
      id: entryId,
      novelId: novel.id,
      type: 'character',
      path: relPath,
      title: 'Baseline Hero',
      tags: '[]',
      aliases: '[]',
      importance: null,
      data: JSON.stringify({ description: 'original description' }),
      outgoingLinks: '[]',
      contentHash: 'seed',
      updatedAt: now,
    });
    const { syncKnowledgeEntryToVault } = await import('@/lib/vault/server-sync');
    const { completeKnowledgeVaultUpsert, getKnowledgeVaultOutboxRow } = await import(
      '@/lib/db/queries-knowledge-vault-outbox'
    );
    expect(await syncKnowledgeEntryToVault(novel.id, entryId)).toBe('written');
    const seedIntent = getKnowledgeVaultOutboxRow(entryId);
    if (seedIntent) completeKnowledgeVaultUpsert(entryId, seedIntent.intentRevision);
    const filePath = path.join(vaultRoot!, ...relPath.split('/'));
    const baseline = await readFile(filePath, 'utf8');
    const baselineHash = createHash('sha256').update(baseline, 'utf8').digest('hex');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    expect((await getKnowledgeIndexById(entryId))?.mirrorContentHash).toBe(baselineHash);
    if (options?.clearMirrorBaseline) {
      // Schema-21→22 upgrade leaves mirror_content_hash NULL on established roots.
      getDb().prepare(
        'UPDATE knowledge_index SET mirror_content_hash = NULL WHERE id = ?',
      ).run(entryId);
      expect((await getKnowledgeIndexById(entryId))?.mirrorContentHash).toBeNull();
    }
    return { db, novel, entryId, relPath, filePath, baseline, baselineHash, now };
  }

  it('refuses NULL-baseline replace on an upgraded established root with divergent Markdown', async () => {
    const { db, novel, entryId, filePath, baseline, now } = await seedMirroredEntry({
      clearMirrorBaseline: true,
    });
    const external = `${baseline}\n\n## External edit after schema-21 upgrade\n`;
    await writeFile(filePath, external, 'utf8');

    await db.updateKnowledgeEntryWithIndex(
      entryId,
      {
        summary: 'app update with unknown mirror baseline',
        updatedAt: new Date(Date.parse(now) + 5_000).toISOString(),
      },
      {
        id: entryId,
        novelId: novel.id,
        type: 'character',
        path: `characters/${entryId}.md`,
        title: 'Baseline Hero',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: JSON.stringify({ description: 'original description' }),
        outgoingLinks: '[]',
        contentHash: 'updated-null-baseline',
        updatedAt: new Date(Date.parse(now) + 5_000).toISOString(),
      },
    );

    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    const { getKnowledgeVaultOutboxRow } = await import('@/lib/db/queries-knowledge-vault-outbox');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    expect(await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.null.baseline')).toBe('conflict');
    expect(await readFile(filePath, 'utf8')).toBe(external);
    expect((await getKnowledgeIndexById(entryId))?.mirrorContentHash).toBeNull();
    expect(getKnowledgeVaultOutboxRow(entryId)).toMatchObject({
      operation: 'upsert',
      status: 'pending',
      lastError: expect.stringContaining('external edit since baseline'),
    });
  });

  it('learns a schema-21 NULL baseline from established-root snapshot reconcile', async () => {
    const { db, novel, entryId, relPath, filePath, baseline, baselineHash, now } =
      await seedMirroredEntry({ clearMirrorBaseline: true });
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    expect(await reconcileVaultChangedFiles(novel.id, [{ path: relPath, content: baseline }]))
      .toMatchObject({ skipped: 0 });
    expect((await getKnowledgeIndexById(entryId))?.mirrorContentHash).toBe(baselineHash);

    const appUpdatedAt = new Date(Date.parse(now) + 5_000).toISOString();
    await db.updateKnowledgeEntryWithIndex(
      entryId,
      { summary: 'first app edit after schema-22 observation', updatedAt: appUpdatedAt },
      {
        id: entryId,
        novelId: novel.id,
        type: 'character',
        path: relPath,
        title: 'Baseline Hero',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: JSON.stringify({ description: 'original description' }),
        outgoingLinks: '[]',
        contentHash: 'post-observation-app-edit',
        updatedAt: appUpdatedAt,
      },
    );
    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    expect(await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.post-observe.write'))
      .toBe('completed');
    expect(await readFile(filePath, 'utf8')).toContain('first app edit after schema-22 observation');
  });

  it('preserves external bytes when the target mutates after final validation before install', async () => {
    const { relPath, filePath, baseline, baselineHash } = await seedMirroredEntry();
    const mutationFile = path.join(dataDir!, 'final-boundary-mutation.md');
    const external = `${baseline}\n\n## Mutated at final install boundary\n`;
    await writeFile(mutationFile, external, 'utf8');
    __anchoredFsTest.mutateTargetBeforeInstallFile = mutationFile;

    await expect(
      writeAnchoredVaultEntry(vaultRoot!, relPath, 'app replacement body', baselineHash),
    ).rejects.toBeInstanceOf(VaultMarkdownConflictError);
    expect(await readFile(filePath, 'utf8')).toBe(external);
  });

  it('never overwrites a target recreated after displacement', async () => {
    const { relPath, filePath, baseline, baselineHash } = await seedMirroredEntry();
    const beforeDisplaceFile = path.join(dataDir!, 'before-displace-mutation.md');
    const afterDisplaceFile = path.join(dataDir!, 'after-displace-recreation.md');
    const displacedExternal = `${baseline}\n\n## External version displaced by App\n`;
    const recreatedExternal = `${baseline}\n\n## External version recreated at canonical path\n`;
    await writeFile(beforeDisplaceFile, displacedExternal, 'utf8');
    await writeFile(afterDisplaceFile, recreatedExternal, 'utf8');
    __anchoredFsTest.mutateTargetBeforeInstallFile = beforeDisplaceFile;
    __anchoredFsTest.recreateTargetAfterDisplaceFile = afterDisplaceFile;

    await expect(
      writeAnchoredVaultEntry(vaultRoot!, relPath, 'app replacement body', baselineHash),
    ).rejects.toBeInstanceOf(VaultMarkdownConflictError);

    expect(await readFile(filePath, 'utf8')).toBe(recreatedExternal);
    const recoveryFiles = readdirSync(path.dirname(filePath))
      .filter(name => name.endsWith('.displaced'));
    expect(recoveryFiles).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(filePath), recoveryFiles[0]!), 'utf8'))
      .toBe(displacedExternal);
  });

  it('never overwrites a missing target recreated at the install boundary', async () => {
    const root = tempDir();
    const recreationFile = path.join(dataDir ?? root, 'missing-target-recreation.md');
    const external = '# External creation won the race\n';
    await writeFile(recreationFile, external, 'utf8');
    __anchoredFsTest.recreateTargetAfterDisplaceFile = recreationFile;

    await expect(
      writeAnchoredVaultEntry(root, 'characters/new.md', '# App creation\n'),
    ).rejects.toBeInstanceOf(VaultMarkdownConflictError);
    expect(await readFile(path.join(root, 'characters', 'new.md'), 'utf8')).toBe(external);
  });

  it('detects a late external write through an fd opened before displacement', async () => {
    const { relPath, filePath, baseline, baselineHash } = await seedMirroredEntry();
    const mutationFile = path.join(dataDir!, 'open-fd-mutation.md');
    const external = `${baseline}\n\n## Written through the pre-displace file descriptor\n`;
    await writeFile(mutationFile, external, 'utf8');
    __anchoredFsTest.mutateOpenTargetAfterInstallFile = mutationFile;

    await expect(
      writeAnchoredVaultEntry(vaultRoot!, relPath, 'app replacement body', baselineHash),
    ).rejects.toBeInstanceOf(VaultMarkdownConflictError);

    expect(await readFile(filePath, 'utf8')).toBe('app replacement body');
    const recoveryFiles = readdirSync(path.dirname(filePath))
      .filter(name => name.endsWith('.displaced'));
    expect(recoveryFiles).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(filePath), recoveryFiles[0]!), 'utf8'))
      .toBe(external);
  });

  it('recovers a known baseline left by a crash after displacement', async () => {
    const { relPath, filePath, baselineHash } = await seedMirroredEntry();
    __anchoredFsTest.exitAfterDisplace = true;
    await expect(
      writeAnchoredVaultEntry(vaultRoot!, relPath, 'app replacement body', baselineHash),
    ).rejects.toThrow('Anchored Vault helper failed');
    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(path.dirname(filePath)).filter(name => name.endsWith('.displaced')))
      .toHaveLength(1);

    __anchoredFsTest.exitAfterDisplace = false;
    await expect(writeAnchoredVaultEntry(
      vaultRoot!,
      relPath,
      'app replacement body',
      baselineHash,
    )).resolves.toMatchObject({ result: 'written' });
    expect(await readFile(filePath, 'utf8')).toBe('app replacement body');
    expect(readdirSync(path.dirname(filePath)).filter(name => name.endsWith('.displaced')))
      .toHaveLength(0);
  });

  it('restores external bytes left by a crash instead of treating canonical as missing', async () => {
    const { relPath, filePath, baseline, baselineHash } = await seedMirroredEntry();
    const mutationFile = path.join(dataDir!, 'pre-crash-external.md');
    const external = `${baseline}\n\n## External bytes displaced before crash\n`;
    await writeFile(mutationFile, external, 'utf8');
    __anchoredFsTest.mutateTargetBeforeInstallFile = mutationFile;
    __anchoredFsTest.exitAfterDisplace = true;
    await expect(
      writeAnchoredVaultEntry(vaultRoot!, relPath, 'app replacement body', baselineHash),
    ).rejects.toThrow('Anchored Vault helper failed');
    expect(existsSync(filePath)).toBe(false);

    __anchoredFsTest.mutateTargetBeforeInstallFile = null;
    __anchoredFsTest.exitAfterDisplace = false;
    await expect(
      writeAnchoredVaultEntry(vaultRoot!, relPath, 'app replacement body', baselineHash),
    ).rejects.toBeInstanceOf(VaultMarkdownConflictError);
    expect(await readFile(filePath, 'utf8')).toBe(external);
    expect(readdirSync(path.dirname(filePath)).filter(name => name.endsWith('.displaced')))
      .toHaveLength(0);
  });

  it('cleans a known baseline sidecar left by a crash after install', async () => {
    const { relPath, filePath, baselineHash } = await seedMirroredEntry();
    __anchoredFsTest.exitAfterInstall = true;
    await expect(
      writeAnchoredVaultEntry(vaultRoot!, relPath, 'app replacement body', baselineHash),
    ).rejects.toThrow('Anchored Vault helper failed');
    expect(await readFile(filePath, 'utf8')).toBe('app replacement body');
    expect(readdirSync(path.dirname(filePath)).filter(name => name.endsWith('.displaced')))
      .toHaveLength(1);

    __anchoredFsTest.exitAfterInstall = false;
    await expect(writeAnchoredVaultEntry(
      vaultRoot!,
      relPath,
      'app replacement body',
      baselineHash,
    )).resolves.toMatchObject({ result: 'unchanged' });
    expect(readdirSync(path.dirname(filePath)).filter(name => name.endsWith('.displaced')))
      .toHaveLength(0);
  });

  it('deduplicates the same inode after a crash between recovery link and unlink', async () => {
    const { relPath, filePath, baselineHash } = await seedMirroredEntry();
    const desiredFile = path.join(dataDir!, 'desired-before-displace.md');
    await writeFile(desiredFile, 'app replacement body', 'utf8');
    __anchoredFsTest.mutateTargetBeforeInstallFile = desiredFile;
    __anchoredFsTest.exitAfterRecoveryLink = true;
    await expect(
      writeAnchoredVaultEntry(vaultRoot!, relPath, 'app replacement body', baselineHash),
    ).rejects.toThrow('Anchored Vault helper failed');
    expect(await readFile(filePath, 'utf8')).toBe('app replacement body');
    expect(readdirSync(path.dirname(filePath)).filter(name => name.endsWith('.displaced')))
      .toHaveLength(1);

    __anchoredFsTest.mutateTargetBeforeInstallFile = null;
    __anchoredFsTest.exitAfterRecoveryLink = false;
    await expect(writeAnchoredVaultEntry(
      vaultRoot!,
      relPath,
      'app replacement body',
      baselineHash,
    )).resolves.toMatchObject({ result: 'unchanged' });
    expect(readdirSync(path.dirname(filePath)).filter(name => name.endsWith('.displaced')))
      .toHaveLength(0);
  });

  it('preserves both external Markdown and pending App DB version on reconcile conflict', async () => {
    const { db, novel, entryId, relPath, filePath, baseline, now } = await seedMirroredEntry();
    const external = `${baseline}\n\n## External reconcile conflict body\n`;
    await writeFile(filePath, external, 'utf8');
    const appUpdatedAt = new Date(Date.parse(now) + 10_000).toISOString();
    await db.updateKnowledgeEntryWithIndex(
      entryId,
      {
        summary: 'canonical app summary that must survive',
        updatedAt: appUpdatedAt,
      },
      {
        id: entryId,
        novelId: novel.id,
        type: 'character',
        path: relPath,
        title: 'Baseline Hero',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: JSON.stringify({ description: 'original description' }),
        outgoingLinks: '[]',
        contentHash: 'app-pending',
        updatedAt: appUpdatedAt,
      },
    );

    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    const { getKnowledgeVaultOutboxRow } = await import('@/lib/db/queries-knowledge-vault-outbox');
    expect(await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.reconcile.seed')).toBe('conflict');
    const pending = getKnowledgeVaultOutboxRow(entryId);
    expect(pending).toMatchObject({ operation: 'upsert', status: 'pending' });

    const externalUpdatedAt = new Date(Date.parse(now) + 1_000).toISOString();
    const externalMarkdown = [
      '---',
      `id: ${entryId}`,
      'type: character',
      'title: Baseline Hero',
      `createdAt: "${now}"`,
      `updatedAt: "${externalUpdatedAt}"`,
      'description: original description',
      '---',
      '',
      'External reconcile conflict body',
      '',
    ].join('\n');
    await writeFile(filePath, externalMarkdown, 'utf8');

    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');
    const result = await reconcileVaultChangedFiles(novel.id, [{
      path: relPath,
      content: externalMarkdown,
    }]);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(await readFile(filePath, 'utf8')).toBe(externalMarkdown);
    expect(await db.getKnowledgeEntry(entryId, novel.id)).toMatchObject({
      summary: 'canonical app summary that must survive',
      updated_at: appUpdatedAt,
    });
    expect(getKnowledgeVaultOutboxRow(entryId)).toMatchObject({
      operation: 'upsert',
      status: 'pending',
      intentRevision: pending!.intentRevision,
    });
  });

  it('still applies normal app-only updates when the file matches the baseline', async () => {
    const { db, novel, entryId, filePath, now } = await seedMirroredEntry();
    await db.updateKnowledgeEntryWithIndex(
      entryId,
      {
        summary: 'normal app update',
        updatedAt: new Date(Date.parse(now) + 1_000).toISOString(),
      },
      {
        id: entryId,
        novelId: novel.id,
        type: 'character',
        path: `characters/${entryId}.md`,
        title: 'Baseline Hero',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: JSON.stringify({ description: 'original description' }),
        outgoingLinks: '[]',
        contentHash: 'normal',
        updatedAt: new Date(Date.parse(now) + 1_000).toISOString(),
      },
    );
    const { trySyncKnowledgeEntryToVault } = await import('@/lib/knowledge/apply-write');
    const { getKnowledgeVaultOutboxRow } = await import('@/lib/db/queries-knowledge-vault-outbox');
    expect(await trySyncKnowledgeEntryToVault(novel.id, entryId, 'test.normal.write')).toBe('completed');
    expect(getKnowledgeVaultOutboxRow(entryId)).toBeNull();
    const written = await readFile(filePath, 'utf8');
    expect(written).toContain('normal app update');
  });

  it('creates missing files and refuses known-baseline mismatch without clobber', async () => {
    const root = tempDir();
    await writeAnchoredVaultEntry(root, 'characters/new.md', 'first');
    expect(await readFile(path.join(root, 'characters', 'new.md'), 'utf8')).toBe('first');

    await expect(
      writeAnchoredVaultEntry(root, 'characters/new.md', 'second', 'deadbeef'),
    ).rejects.toBeInstanceOf(VaultMarkdownConflictError);
    expect(await readFile(path.join(root, 'characters', 'new.md'), 'utf8')).toBe('first');

    await expect(
      writeAnchoredVaultEntry(root, 'characters/new.md', 'second', null),
    ).rejects.toBeInstanceOf(VaultMarkdownConflictError);
    expect(await readFile(path.join(root, 'characters', 'new.md'), 'utf8')).toBe('first');
  });
});
