import { describe, expect, it, vi } from 'vitest';
import {
  chunkLiveVaultMarkdownPaths,
  collectLiveVaultChangedFiles,
} from '@/lib/vault/live-reconcile';

describe('live vault reconcile event helpers', () => {
  it('chunks every markdown path instead of truncating large watcher bursts', () => {
    const chunks = chunkLiveVaultMarkdownPaths([
      ...Array.from({ length: 65 }, (_, i) => `characters/entry-${i}.md`),
      'characters/skip.txt',
      'characters/nested/file.md',
      '.ainovel/internal.md',
      'root.md',
      'characters\\windows.md',
    ]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(64);
    expect(chunks[1]).toEqual(['characters/entry-64.md']);
  });

  it('deletes only on explicit missing-file results for rename/remove/other', async () => {
    const readContent = vi.fn(async (relPath: string) => {
      if (relPath.includes('missing')) {
        throw new Error(
          "VAULT_ENTRY_NOT_FOUND: Cannot stat '/vault/missing.md': No such file or directory",
        );
      }
      return `content for ${relPath}`;
    });

    await expect(
      collectLiveVaultChangedFiles('modify', [
        'characters/ready.md',
        'characters/missing.md',
      ], readContent),
    ).resolves.toEqual({
      files: [
        { path: 'characters/ready.md', content: 'content for characters/ready.md' },
      ],
      deferredDeletePaths: [],
    });

    await expect(
      collectLiveVaultChangedFiles('rename', [
        'characters/ready.md',
        'characters/missing.md',
      ], readContent),
    ).resolves.toEqual({
      files: [
        { path: 'characters/ready.md', content: 'content for characters/ready.md' },
        { path: 'characters/missing.md', content: null },
      ],
      deferredDeletePaths: [],
    });

    // A still-readable path must never become content:null merely because the
    // event kind is remove (e.g. sibling B removed in the same debounce window).
    await expect(
      collectLiveVaultChangedFiles('remove', [
        'characters/a.md',
        'characters/missing-b.md',
      ], readContent),
    ).resolves.toEqual({
      files: [
        { path: 'characters/a.md', content: 'content for characters/a.md' },
        { path: 'characters/missing-b.md', content: null },
      ],
      deferredDeletePaths: [],
    });
  });

  it('defers missing remove/rename/other while deletes are ineligible', async () => {
    const readContent = vi.fn(async (relPath: string) => {
      if (relPath.includes('missing')) {
        throw new Error(
          "VAULT_ENTRY_NOT_FOUND: Cannot stat '/vault/missing.md': No such file or directory",
        );
      }
      return `content for ${relPath}`;
    });

    await expect(
      collectLiveVaultChangedFiles(
        'remove',
        ['characters/a.md', 'characters/missing-b.md'],
        readContent,
        { allowMissingFileDeletes: false },
      ),
    ).resolves.toEqual({
      files: [
        { path: 'characters/a.md', content: 'content for characters/a.md' },
      ],
      deferredDeletePaths: ['characters/missing-b.md'],
    });
  });

  it.each(['modify', 'rename', 'remove', 'other'] as const)(
    'rejects %s batches on non-missing read failures so the runtime can retry',
    async kind => {
      await expect(
        collectLiveVaultChangedFiles(
          kind,
          ['characters/locked.md'],
          async () => {
            throw new Error(
              "Cannot stat '/vault/locked.md': Permission denied (os error 13)",
            );
          },
        ),
      ).rejects.toThrow('Permission denied');
    },
  );

  it('never treats an unreachable vault root as an entry deletion', async () => {
    await expect(
      collectLiveVaultChangedFiles(
        'remove',
        ['characters/a.md'],
        async () => {
          throw new Error(
            "VAULT_ROOT_UNREACHABLE: Cannot resolve vault path '/Volumes/offline'",
          );
        },
      ),
    ).rejects.toThrow('VAULT_ROOT_UNREACHABLE');
  });
});
