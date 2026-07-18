import { beforeEach, describe, expect, it, vi } from 'vitest';

const vaultMock = vi.hoisted(() => ({
  files: [] as { path: string; size: number; content?: string; readError?: Error }[],
  indexedRefs: [] as { id: string; path: string }[],
  batches: [] as { changes: unknown[]; options: unknown }[],
  movedHintPaths: new Set<string>(),
  reconcileError: null as Error | null,
  reconcileSkipped: 0,
}));

vi.mock('@/lib/vault/ipc', () => ({
  vaultWalk: vi.fn(async () => vaultMock.files.map(({ path, size }) => ({
    path,
    size,
    mtimeMs: 1,
    contentHash: 'hash',
  }))),
  vaultReadFile: vi.fn(async (_vaultPath: string, relPath: string) => {
    const file = vaultMock.files.find(f => f.path === relPath);
    if (!file) throw new Error('missing');
    if (file.readError) throw file.readError;
    return {
      path: relPath,
      content: file.content ?? '',
      contentHash: 'hash',
      mtimeMs: 1,
      size: file.size,
    };
  }),
}));

vi.mock('@/app/actions/vault', () => ({
  getVaultIndexedEntryRefsAction: vi.fn(async () => vaultMock.indexedRefs),
  reconcileVaultChangedFiles: vi.fn(async (_novelId: string, changes: unknown[], options?: unknown) => {
    if (vaultMock.reconcileError) throw vaultMock.reconcileError;
    vaultMock.batches.push({ changes, options });
    const hints = (
      options &&
      typeof options === 'object' &&
      Array.isArray((options as { deletedPathsHint?: unknown }).deletedPathsHint)
    )
      ? (options as { deletedPathsHint: string[] }).deletedPathsHint
      : [];
    for (const hint of hints) vaultMock.movedHintPaths.add(hint);
    const deleted = changes.filter(change => (
      Boolean(change) &&
      typeof change === 'object' &&
      (change as { content?: unknown }).content === null &&
      !vaultMock.movedHintPaths.has((change as { path?: string }).path ?? '')
    )).length;
    const present = changes.filter(change => (
      Boolean(change) &&
      typeof change === 'object' &&
      (change as { content?: unknown }).content !== null
    )).length;
    return {
      updated: present - vaultMock.reconcileSkipped,
      deleted,
      skipped: vaultMock.reconcileSkipped,
    };
  }),
}));

describe('reconcileVaultSnapshot', () => {
  beforeEach(() => {
    vaultMock.files = [];
    vaultMock.indexedRefs = [];
    vaultMock.batches = [];
    vaultMock.movedHintPaths.clear();
    vaultMock.reconcileError = null;
    vaultMock.reconcileSkipped = 0;
  });

  it('imports existing markdown snapshot files in bounded reconcile batches', async () => {
    const { reconcileVaultSnapshot } = await import('@/lib/vault/snapshot-reconcile');
    vaultMock.files = Array.from({ length: 70 }, (_, i) => ({
      path: `characters/entry-${i}.md`,
      size: 8,
      content: `# Entry ${i}`,
    }));
    vaultMock.files.push(
      { path: 'characters/note.txt', size: 4, content: 'skip' },
      { path: 'characters/nested/file.md', size: 4, content: 'skip' },
      { path: 'worlds/too-large.md', size: 128 * 1024 + 1, content: 'skip' },
      { path: 'styles/unreadable.md', size: 4, readError: new Error('denied') },
    );

    const result = await reconcileVaultSnapshot('novel-1', '/vault');

    expect(result).toEqual({ updated: 70, deleted: 0, skipped: 2 });
    expect(vaultMock.batches).toHaveLength(2);
    expect(vaultMock.batches[0]?.changes).toHaveLength(64);
    expect(vaultMock.batches[1]?.changes).toHaveLength(6);
  });

  it('deletes indexed rows that are missing from an empty vault snapshot', async () => {
    const { reconcileVaultSnapshot } = await import('@/lib/vault/snapshot-reconcile');
    vaultMock.indexedRefs = [
      { id: 'old', path: 'characters/old.md' },
      { id: 'stale', path: 'worlds/stale.md' },
    ];

    const result = await reconcileVaultSnapshot('novel-1', '/vault');

    expect(result).toEqual({ updated: 0, deleted: 2, skipped: 0 });
    expect(vaultMock.batches).toEqual([{
      changes: [
        { path: 'characters/old.md', content: null },
        { path: 'worlds/stale.md', content: null },
      ],
      options: undefined,
    }]);
  });

  it('passes missing indexed paths as move hints while rebuilding present files', async () => {
    const { reconcileVaultSnapshot } = await import('@/lib/vault/snapshot-reconcile');
    const content = entryMarkdown('entry-1', 'New Entry');
    vaultMock.files = [{ path: 'characters/new.md', size: content.length, content }];
    vaultMock.indexedRefs = [{ id: 'entry-1', path: 'characters/old.md' }];

    const result = await reconcileVaultSnapshot('novel-1', '/vault');

    expect(result).toEqual({ updated: 1, deleted: 0, skipped: 0 });
    expect(vaultMock.batches[0]).toEqual({
      changes: [{ path: 'characters/new.md', content }],
      options: { deletedPathsHint: ['characters/old.md'] },
    });
    expect(vaultMock.batches[1]).toEqual({
      changes: [{ path: 'characters/old.md', content: null }],
      options: undefined,
    });
  });

  it('limits move hints to matching ids when many indexed paths are missing', async () => {
    const { reconcileVaultSnapshot } = await import('@/lib/vault/snapshot-reconcile');
    const content = entryMarkdown('match-id', 'Moved Entry');
    vaultMock.files = [{ path: 'characters/new-match.md', size: content.length, content }];
    vaultMock.indexedRefs = [
      ...Array.from({ length: 4097 }, (_, i) => ({
        id: `stale-${i}`,
        path: `characters/stale-${i}.md`,
      })),
      { id: 'match-id', path: 'characters/old-match.md' },
    ];

    const result = await reconcileVaultSnapshot('novel-1', '/vault');

    expect(result).toEqual({ updated: 1, deleted: 4097, skipped: 0 });
    expect(vaultMock.batches[0]).toEqual({
      changes: [{ path: 'characters/new-match.md', content }],
      options: { deletedPathsHint: ['characters/old-match.md'] },
    });
  });

  it('can fail fast when snapshot projection cannot be rebuilt', async () => {
    const { reconcileVaultSnapshot } = await import('@/lib/vault/snapshot-reconcile');
    vaultMock.files = [{ path: 'characters/entry.md', size: 8, content: '# Entry' }];
    vaultMock.reconcileError = new Error('index unavailable');

    await expect(
      reconcileVaultSnapshot('novel-1', '/vault', { failOnReconcileError: true }),
    ).rejects.toThrow('Vault snapshot reconcile failed for 1 file(s): index unavailable');
    expect(vaultMock.batches).toHaveLength(0);
  });

  it('fails strict snapshot reconcile when a changed file is skipped by projection', async () => {
    const { reconcileVaultSnapshot } = await import('@/lib/vault/snapshot-reconcile');
    vaultMock.files = [{ path: 'characters/entry.md', size: 8, content: '# Entry' }];
    vaultMock.reconcileSkipped = 1;

    await expect(
      reconcileVaultSnapshot('novel-1', '/vault', { failOnReconcileError: true }),
    ).rejects.toThrow('Vault snapshot reconcile failed for 1 file(s): Vault snapshot reconcile skipped 1 changed file(s)');
  });
});

function entryMarkdown(id: string, title: string): string {
  return [
    '---',
    `id: ${id}`,
    'type: character',
    `title: ${title}`,
    '---',
    `${title} body.`,
    '',
  ].join('\n');
}
