import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { __serverSyncTest } from '@/lib/vault/server-sync';
import {
  __anchoredFsTest,
  deleteAnchoredVaultEntry,
  readAnchoredVaultMarkdown,
  writeAnchoredVaultEntry,
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
