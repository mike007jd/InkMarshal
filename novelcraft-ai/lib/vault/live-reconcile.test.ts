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

  it('skips transient read failures but treats missing rename paths as deletes', async () => {
    const readContent = vi.fn(async (relPath: string) => {
      if (relPath.includes('missing')) throw new Error('Cannot stat missing file');
      if (relPath.includes('locked')) throw new Error('not ready');
      return `content for ${relPath}`;
    });

    await expect(
      collectLiveVaultChangedFiles('modify', [
        'characters/ready.md',
        'characters/missing.md',
        'characters/locked.md',
      ], readContent),
    ).resolves.toEqual([
      { path: 'characters/ready.md', content: 'content for characters/ready.md' },
    ]);

    await expect(
      collectLiveVaultChangedFiles('rename', [
        'characters/ready.md',
        'characters/missing.md',
        'characters/locked.md',
      ], readContent),
    ).resolves.toEqual([
      { path: 'characters/ready.md', content: 'content for characters/ready.md' },
      { path: 'characters/missing.md', content: null },
    ]);
  });
});
