import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { __serverSyncTest } from '@/lib/vault/server-sync';

let tmpRoot: string | null = null;

function tempDir(): string {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'inkmarshal-server-sync-'));
  return tmpRoot;
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe('vault server sync filesystem guard', () => {
  it('resolves only canonical top-level vault entry files', async () => {
    const root = tempDir();

    const file = await __serverSyncTest.safeVaultEntryFile(root, 'characters/mira.md', true);

    expect(file).toBe(path.join(realpathSync(root), 'characters', 'mira.md'));
    expect(existsSync(path.join(root, 'characters'))).toBe(true);
    await expect(
      __serverSyncTest.safeVaultEntryFile(root, '../mira.md', true),
    ).rejects.toThrow('Invalid vault entry path');
    await expect(
      __serverSyncTest.safeVaultEntryFile(root, 'characters/nested/mira.md', true),
    ).rejects.toThrow('Invalid vault entry path');
    await expect(
      __serverSyncTest.safeVaultEntryFile(root, 'characters/../outline/mira.md', true),
    ).rejects.toThrow('Invalid vault entry path');
  });

  it('rejects symlinked vault roots and entry parents', async () => {
    const workspace = tempDir();
    const realRoot = path.join(workspace, 'real-root');
    const linkedRoot = path.join(workspace, 'linked-root');
    const outside = path.join(workspace, 'outside');
    mkdirSync(realRoot);
    mkdirSync(outside);
    symlinkSync(realRoot, linkedRoot, 'dir');

    await expect(
      __serverSyncTest.safeVaultEntryFile(linkedRoot, 'characters/mira.md', true),
    ).rejects.toThrow('Invalid vault root');

    const vaultRoot = path.join(workspace, 'vault-root');
    mkdirSync(vaultRoot);
    symlinkSync(outside, path.join(vaultRoot, 'characters'), 'dir');

    await expect(
      __serverSyncTest.safeVaultEntryFile(vaultRoot, 'characters/mira.md', true),
    ).rejects.toThrow('Invalid vault entry parent');
    expect(existsSync(path.join(outside, 'mira.md'))).toBe(false);
  });

  it('writes atomically and rejects oversized markdown', async () => {
    const root = tempDir();
    const file = await __serverSyncTest.safeVaultEntryFile(root, 'characters/mira.md', true);

    await __serverSyncTest.writeAtomic(file, 'small markdown');
    expect(await readFile(file, 'utf8')).toBe('small markdown');
    await expect(
      __serverSyncTest.writeAtomic(file, 'x'.repeat(128 * 1024 + 1)),
    ).rejects.toThrow('Vault markdown is too large');
    expect(await readFile(file, 'utf8')).toBe('small markdown');
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
