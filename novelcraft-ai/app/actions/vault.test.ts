import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
const PREV_EMBED_BASE_URL = process.env.INKMARSHAL_EMBED_BASE_URL;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-action-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
  delete process.env.INKMARSHAL_EMBED_BASE_URL;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  if (PREV_EMBED_BASE_URL === undefined) delete process.env.INKMARSHAL_EMBED_BASE_URL;
  else process.env.INKMARSHAL_EMBED_BASE_URL = PREV_EMBED_BASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('vault server actions', () => {
  it('persists only bounded absolute vault paths', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getNovelVault } = await import('@/lib/db/queries-vault');
    const { setNovelVaultPathAction } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault path action' });
    try {
      await setNovelVaultPathAction(novel.id, '/Users/local/InkMarshal Vault');
      await expect(setNovelVaultPathAction(novel.id, 'relative/path')).rejects.toThrow(
        'Vault path must be absolute',
      );
      await expect(setNovelVaultPathAction(novel.id, `/tmp/vault\nbad`)).rejects.toThrow(
        'Vault path is invalid',
      );
      await expect(setNovelVaultPathAction(novel.id, `/tmp/${'x'.repeat(4_100)}`)).rejects.toThrow(
        'Vault path is invalid',
      );
      await expect(
        setNovelVaultPathAction(novel.id, 123 as unknown as string),
      ).rejects.toThrow('Vault path must be absolute');

      const saved = await getNovelVault(novel.id);
      expect(saved).toEqual({
        vaultPath: '/Users/local/InkMarshal Vault',
        vaultVersion: 1,
      });

    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('reconciles changed vault markdown into knowledge rows and knowledge index', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault watcher reconcile' });
    const entryId = randomUUID();
    try {
      const content = [
        '---',
        `id: ${entryId}`,
        'type: character',
        'title: Mira Vale',
        'tags:',
        '  - pilot',
        'description: Keeps the skyship ledger',
        'motivation: Find the missing route',
        '---',
        'Mira tracks [[North Gate]] from the bridge.',
        '',
      ].join('\n');

      await expect(
        reconcileVaultChangedFiles(novel.id, [{ path: '../bad.md', content }]),
      ).rejects.toThrow('Invalid vault file path');
      await expect(
        reconcileVaultChangedFiles(novel.id, [{ path: 'characters/nested/hidden.md', content }]),
      ).rejects.toThrow('Invalid vault file path');
      await expect(
        reconcileVaultChangedFiles(
          novel.id,
          Array.from({ length: 65 }, (_, i) => ({
            path: `characters/bulk-${i}.md`,
            content,
          })),
        ),
      ).rejects.toThrow('Vault change payload is too large');
      await expect(
        reconcileVaultChangedFiles(novel.id, [{
          path: 'characters/oversized-cjk.md',
          content: [
            '---',
            `id: ${randomUUID()}`,
            'type: character',
            'title: Oversized CJK',
            '---',
            '界'.repeat(50_000),
          ].join('\n'),
        }]),
      ).rejects.toThrow('Vault file is too large');

      const first = await reconcileVaultChangedFiles(novel.id, [
        { path: 'characters/mira-vale.md', content },
      ]);
      expect(first).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const legacy = await getKnowledgeEntry(entryId, novel.id);
      expect(legacy?.title).toBe('Mira Vale');
      expect(legacy?.type).toBe('character');

      const indexRows = await listKnowledgeIndexForNovel(novel.id);
      expect(indexRows).toHaveLength(1);
      expect(indexRows[0]).toMatchObject({
        id: entryId,
        path: 'characters/mira-vale.md',
        title: 'Mira Vale',
        aliases: [],
      });
      expect(indexRows[0].outgoingLinks).toEqual([{ raw: 'North Gate' }]);

      const removed = await reconcileVaultChangedFiles(novel.id, [
        { path: 'characters/mira-vale.md', content: null },
      ]);
      expect(removed).toEqual({ updated: 0, deleted: 1, skipped: 0 });
      expect(await getKnowledgeEntry(entryId, novel.id)).toBeUndefined();
      expect(await listKnowledgeIndexForNovel(novel.id)).toHaveLength(0);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('uses the vault directory as the canonical entry type when frontmatter disagrees', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault type boundary' });
    const entryId = randomUUID();
    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [{
          path: 'characters/misfiled-outline.md',
          content: [
            '---',
            `id: ${entryId}`,
            'type: outline',
            'title: Misfiled Outline',
            'chapterNumber: 12',
            '---',
            'This file lives in characters and must not become blueprint context.',
            '',
          ].join('\n'),
        }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      expect((await getKnowledgeEntry(entryId, novel.id))?.type).toBe('character');
      expect((await getKnowledgeIndexById(entryId))?.type).toBe('character');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('treats a missing old path as a same-id vault move during snapshot rebuild', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
    const { getVaultIndexedEntryRefsAction, reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault snapshot move' });
    const entryId = randomUUID();
    const contentFor = (title: string) => [
      '---',
      `id: ${entryId}`,
      'type: character',
      `title: ${title}`,
      '---',
      `${title} body.`,
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [{
          path: 'characters/old-name.md',
          content: contentFor('Old Name'),
        }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });
      expect(await getVaultIndexedEntryRefsAction(novel.id)).toEqual([{
        id: entryId,
        path: 'characters/old-name.md',
      }]);

      expect(
        await reconcileVaultChangedFiles(
          novel.id,
          [{
            path: 'characters/new-name.md',
            content: contentFor('New Name'),
          }],
          { deletedPathsHint: ['characters/old-name.md'] },
        ),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });
      expect(
        await reconcileVaultChangedFiles(novel.id, [{
          path: 'characters/old-name.md',
          content: null,
        }]),
      ).toEqual({ updated: 0, deleted: 0, skipped: 0 });

      const rows = await listKnowledgeIndexForNovel(novel.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: entryId,
        path: 'characters/new-name.md',
        title: 'New Name',
      });
      expect((await getKnowledgeEntry(entryId, novel.id))?.title).toBe('New Name');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('removes stale embeddings when vault files update or disappear', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const {
      getKnowledgeEmbedding,
      listKnowledgeIndexForNovel,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault embedding cleanup' });
    const entryId = randomUUID();
    const pathName = 'characters/sol-arya.md';
    try {
      const original = [
        '---',
        `id: ${entryId}`,
        'type: character',
        'title: Sol Arya',
        'summary: Runs the west archive',
        '---',
        'Sol keeps records near the blue tower.',
        '',
      ].join('\n');
      const changed = original.replace('blue tower', 'red harbor');

      expect(
        await reconcileVaultChangedFiles(novel.id, [{ path: pathName, content: original }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      await upsertKnowledgeEmbedding({
        id: entryId,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.25, 0.75]),
        contentHash: 'stale-content',
        updatedAt: new Date().toISOString(),
      });
      expect(await getKnowledgeEmbedding(entryId)).not.toBeNull();

      expect(
        await reconcileVaultChangedFiles(novel.id, [{ path: pathName, content: changed }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });
      expect(await getKnowledgeEmbedding(entryId)).toBeNull();
      expect(await listKnowledgeIndexForNovel(novel.id)).toHaveLength(1);

      await upsertKnowledgeEmbedding({
        id: entryId,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.5, 0.5]),
        contentHash: 'stale-before-delete',
        updatedAt: new Date().toISOString(),
      });
      expect(await getKnowledgeEmbedding(entryId)).not.toBeNull();

      expect(
        await reconcileVaultChangedFiles(novel.id, [{ path: pathName, content: null }]),
      ).toEqual({ updated: 0, deleted: 1, skipped: 0 });
      expect(await getKnowledgeEmbedding(entryId)).toBeNull();
      expect(await listKnowledgeIndexForNovel(novel.id)).toHaveLength(0);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('cleans sibling dangling refs when a vault file deletion removes an entry', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { getKnowledgeEmbedding, upsertKnowledgeEmbedding } = await import('@/lib/db/queries-knowledge-vault');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault ref cleanup' });
    const deletedId = randomUUID();
    const pathName = 'characters/deleted-ref.md';
    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [{
          path: pathName,
          content: [
            '---',
            `id: ${deletedId}`,
            'type: character',
            'title: Deleted Ref',
            'role: supporting',
            '---',
            'Deleted Ref is referenced by timeline data.',
            '',
          ].join('\n'),
        }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const sibling = await createKnowledgeEntry(novel.id, {
        type: 'timeline',
        title: 'Referenced Event',
        data: {
          date: '',
          dateSort: 1,
          eventType: 'character',
          description: 'Uses a character ref',
          chapterIds: [],
          characterRefs: [deletedId],
          importance: 'minor',
        },
        tags: [],
      });
      await upsertKnowledgeEmbedding({
        id: sibling.id,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.8, 0.2]),
        contentHash: 'stale-sibling-ref',
        updatedAt: new Date().toISOString(),
      });
      expect(await getKnowledgeEmbedding(sibling.id)).not.toBeNull();

      expect(
        await reconcileVaultChangedFiles(novel.id, [{ path: pathName, content: null }]),
      ).toEqual({ updated: 0, deleted: 1, skipped: 0 });

      const updatedSibling = await getKnowledgeEntry(sibling.id, novel.id);
      expect(JSON.parse(updatedSibling!.data).characterRefs).toEqual([]);
      expect(await getKnowledgeEmbedding(sibling.id)).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not report a committed vault delete as skipped when sibling embedding cleanup fails', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault post commit cleanup' });
    const deletedId = randomUUID();
    const pathName = 'characters/post-commit-cleanup.md';
    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [{
          path: pathName,
          content: [
            '---',
            `id: ${deletedId}`,
            'type: character',
            'title: Post Commit Ref',
            'role: supporting',
            '---',
            'Post Commit Ref is referenced by timeline data.',
            '',
          ].join('\n'),
        }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const sibling = await createKnowledgeEntry(novel.id, {
        type: 'timeline',
        title: 'Post Commit Referenced Event',
        data: {
          date: '',
          dateSort: 1,
          eventType: 'character',
          description: 'Uses a character ref whose embedding cleanup fails',
          chapterIds: [],
          characterRefs: [deletedId],
          importance: 'minor',
        },
        tags: [],
      });
      await upsertKnowledgeEmbedding({
        id: sibling.id,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.7, 0.3]),
        contentHash: 'stale-sibling-cleanup',
        updatedAt: new Date().toISOString(),
      });

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_sibling_embedding_cleanup
          BEFORE DELETE ON knowledge_embeddings
          WHEN OLD.id = '${sibling.id}'
          BEGIN
            SELECT RAISE(ABORT, 'embedding cleanup failed');
          END`,
      ).run();

      expect(
        await reconcileVaultChangedFiles(novel.id, [{ path: pathName, content: null }]),
      ).toEqual({ updated: 0, deleted: 1, skipped: 0 });

      expect(await getKnowledgeEntry(deletedId, novel.id)).toBeUndefined();
      const siblingAfter = await getKnowledgeEntry(sibling.id, novel.id);
      expect(JSON.parse(siblingAfter!.data).characterRefs).toEqual([]);
      expect((await getKnowledgeIndexById(sibling.id))?.data.characterRefs).toEqual([]);
      expect(await getKnowledgeEmbedding(sibling.id)).not.toBeNull();
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_sibling_embedding_cleanup').run();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rolls back vault dangling ref and embedding cleanup when final delete fails', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault delete rollback' });
    const deletedId = randomUUID();
    const pathName = 'characters/rollback-ref.md';
    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [{
          path: pathName,
          content: [
            '---',
            `id: ${deletedId}`,
            'type: character',
            'title: Rollback Ref',
            'role: supporting',
            '---',
            'Rollback Ref is referenced by timeline data.',
            '',
          ].join('\n'),
        }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const sibling = await createKnowledgeEntry(novel.id, {
        type: 'timeline',
        title: 'Rollback Referenced Event',
        data: {
          date: '',
          dateSort: 1,
          eventType: 'character',
          description: 'Uses a character ref whose vault delete fails',
          chapterIds: [],
          characterRefs: [deletedId],
          importance: 'minor',
        },
        tags: [],
      });
      await upsertKnowledgeEmbedding({
        id: deletedId,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.4, 0.6]),
        contentHash: 'target-before-failed-delete',
        updatedAt: new Date().toISOString(),
      });
      expect(await getKnowledgeEmbedding(deletedId)).not.toBeNull();
      expect((await getKnowledgeIndexById(sibling.id))?.data.characterRefs).toEqual([deletedId]);

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_vault_delete_after_cleanup
          BEFORE DELETE ON knowledge_entries
          WHEN OLD.id = '${deletedId}'
          BEGIN
            SELECT RAISE(ABORT, 'vault delete failed');
          END`,
      ).run();

      expect(
        await reconcileVaultChangedFiles(novel.id, [{ path: pathName, content: null }]),
      ).toEqual({ updated: 0, deleted: 0, skipped: 1 });

      expect(await getKnowledgeEntry(deletedId, novel.id)).toBeDefined();
      expect(await getKnowledgeEmbedding(deletedId)).not.toBeNull();
      const siblingAfter = await getKnowledgeEntry(sibling.id, novel.id);
      expect(JSON.parse(siblingAfter!.data).characterRefs).toEqual([deletedId]);
      expect((await getKnowledgeIndexById(sibling.id))?.data.characterRefs).toEqual([deletedId]);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_vault_delete_after_cleanup').run();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('indexes structured frontmatter relations as outgoing links during reconcile', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault structured relations' });
    const entryId = randomUUID();
    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [{
          path: 'characters/relation-source.md',
          content: [
            '---',
            `id: ${entryId}`,
            'type: character',
            'title: Relation Source',
            'role: supporting',
            'relations:',
            '  - {target: Relation Target, type: ally}',
            '---',
            'No body wikilink is present here.',
            '',
          ].join('\n'),
        }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      expect((await getKnowledgeIndexById(entryId))?.outgoingLinks).toEqual([
        { raw: 'Relation Target' },
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('replaces stale legacy/index rows when a vault file changes id at the same path', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const {
      getKnowledgeEmbedding,
      listKnowledgeIndexForNovel,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault id rewrite' });
    const oldId = randomUUID();
    const newId = randomUUID();
    const pathName = 'characters/renamed-id.md';
    const contentFor = (id: string, title: string) => [
      '---',
      `id: ${id}`,
      'type: character',
      `title: ${title}`,
      '---',
      `${title} keeps the archive.`,
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: pathName, content: contentFor(oldId, 'Old Keeper') },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      await upsertKnowledgeEmbedding({
        id: oldId,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.1, 0.9]),
        contentHash: 'old-content',
        updatedAt: new Date().toISOString(),
      });

      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: pathName, content: contentFor(newId, 'New Keeper') },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      expect(await getKnowledgeEntry(oldId, novel.id)).toBeUndefined();
      expect(await getKnowledgeEmbedding(oldId)).toBeNull();
      expect((await getKnowledgeEntry(newId, novel.id))?.title).toBe('New Keeper');
      expect(await listKnowledgeIndexForNovel(novel.id)).toMatchObject([
        { id: newId, path: pathName, title: 'New Keeper' },
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rolls back same-path vault id replacement when dangling ref cleanup fails', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      listKnowledgeIndexForNovel,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault id rewrite rollback' });
    const oldId = randomUUID();
    const newId = randomUUID();
    const pathName = 'characters/rewrite-rollback.md';
    const contentFor = (id: string, title: string) => [
      '---',
      `id: ${id}`,
      'type: character',
      `title: ${title}`,
      '---',
      `${title} keeps the archive.`,
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: pathName, content: contentFor(oldId, 'Rollback Old Keeper') },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const sibling = await createKnowledgeEntry(novel.id, {
        type: 'timeline',
        title: 'Rollback Rewrite Event',
        data: {
          date: '',
          dateSort: 1,
          eventType: 'character',
          description: 'Uses the old character id',
          chapterIds: [],
          characterRefs: [oldId],
          importance: 'minor',
        },
        tags: [],
      });
      await upsertKnowledgeEmbedding({
        id: oldId,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.3, 0.7]),
        contentHash: 'old-before-failed-rewrite',
        updatedAt: new Date().toISOString(),
      });

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_vault_id_rewrite_ref_cleanup
          BEFORE UPDATE OF data ON knowledge_entries
          WHEN OLD.id = '${sibling.id}'
          BEGIN
            SELECT RAISE(ABORT, 'vault rewrite cleanup failed');
          END`,
      ).run();

      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: pathName, content: contentFor(newId, 'Rollback New Keeper') },
        ]),
      ).toEqual({ updated: 0, deleted: 0, skipped: 1 });

      expect((await getKnowledgeEntry(oldId, novel.id))?.title).toBe('Rollback Old Keeper');
      expect(await getKnowledgeEntry(newId, novel.id)).toBeUndefined();
      expect(await getKnowledgeEmbedding(oldId)).not.toBeNull();
      expect(await listKnowledgeIndexForNovel(novel.id)).toMatchObject([
        { id: oldId, path: pathName, title: 'Rollback Old Keeper' },
        { id: sibling.id, title: 'Rollback Rewrite Event' },
      ]);
      const siblingAfter = await getKnowledgeEntry(sibling.id, novel.id);
      expect(JSON.parse(siblingAfter!.data).characterRefs).toEqual([oldId]);
      expect((await getKnowledgeIndexById(sibling.id))?.data.characterRefs).toEqual([oldId]);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_vault_id_rewrite_ref_cleanup').run();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rolls back same-path vault id replacement when dangling ref index cleanup fails', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      listKnowledgeIndexForNovel,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault id rewrite index rollback' });
    const oldId = randomUUID();
    const newId = randomUUID();
    const pathName = 'characters/rewrite-index-rollback.md';
    const contentFor = (id: string, title: string) => [
      '---',
      `id: ${id}`,
      'type: character',
      `title: ${title}`,
      '---',
      `${title} keeps the archive.`,
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: pathName, content: contentFor(oldId, 'Index Rollback Old Keeper') },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const sibling = await createKnowledgeEntry(novel.id, {
        type: 'timeline',
        title: 'Index Rollback Rewrite Event',
        data: {
          date: '',
          dateSort: 1,
          eventType: 'character',
          description: 'Uses the old character id',
          chapterIds: [],
          characterRefs: [oldId],
          importance: 'minor',
        },
        tags: [],
      });
      await upsertKnowledgeEmbedding({
        id: oldId,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.35, 0.65]),
        contentHash: 'old-before-failed-index-rewrite',
        updatedAt: new Date().toISOString(),
      });

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_vault_id_rewrite_index_cleanup
          BEFORE UPDATE OF data ON knowledge_index
          WHEN OLD.id = '${sibling.id}'
          BEGIN
            SELECT RAISE(ABORT, 'vault rewrite index cleanup failed');
          END`,
      ).run();

      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: pathName, content: contentFor(newId, 'Index Rollback New Keeper') },
        ]),
      ).toEqual({ updated: 0, deleted: 0, skipped: 1 });

      expect((await getKnowledgeEntry(oldId, novel.id))?.title).toBe('Index Rollback Old Keeper');
      expect(await getKnowledgeEntry(newId, novel.id)).toBeUndefined();
      expect(await getKnowledgeEmbedding(oldId)).not.toBeNull();
      expect(await listKnowledgeIndexForNovel(novel.id)).toMatchObject([
        { id: oldId, path: pathName, title: 'Index Rollback Old Keeper' },
        { id: sibling.id, title: 'Index Rollback Rewrite Event' },
      ]);
      const siblingAfter = await getKnowledgeEntry(sibling.id, novel.id);
      expect(JSON.parse(siblingAfter!.data).characterRefs).toEqual([oldId]);
      expect((await getKnowledgeIndexById(sibling.id))?.data.characterRefs).toEqual([oldId]);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_vault_id_rewrite_index_cleanup').run();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('skips duplicate frontmatter ids from a different live vault path', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault duplicate id' });
    const entryId = randomUUID();
    const contentFor = (title: string) => [
      '---',
      `id: ${entryId}`,
      'type: character',
      `title: ${title}`,
      '---',
      `${title} keeps the archive.`,
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: 'characters/first.md', content: contentFor('First Keeper') },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: 'characters/second.md', content: contentFor('Second Keeper') },
        ]),
      ).toEqual({ updated: 0, deleted: 0, skipped: 1 });

      expect((await getKnowledgeEntry(entryId, novel.id))?.title).toBe('First Keeper');
      expect(await listKnowledgeIndexForNovel(novel.id)).toMatchObject([
        { id: entryId, path: 'characters/first.md', title: 'First Keeper' },
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('allows a same-id vault path move when the old path is deleted in the same batch', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault same id move' });
    const entryId = randomUUID();
    const contentFor = (title: string) => [
      '---',
      `id: ${entryId}`,
      'type: character',
      `title: ${title}`,
      '---',
      `${title} keeps the archive.`,
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: 'characters/old.md', content: contentFor('Old Path Keeper') },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: 'characters/new.md', content: contentFor('New Path Keeper') },
          { path: 'characters/old.md', content: null },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      expect((await getKnowledgeEntry(entryId, novel.id))?.title).toBe('New Path Keeper');
      expect(await listKnowledgeIndexForNovel(novel.id)).toMatchObject([
        { id: entryId, path: 'characters/new.md', title: 'New Path Keeper' },
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('preserves sibling refs when a same-id vault move reports delete before create', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { getKnowledgeIndexById, listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault same id move order' });
    const entryId = randomUUID();
    const contentFor = (title: string) => [
      '---',
      `id: ${entryId}`,
      'type: character',
      `title: ${title}`,
      '---',
      `${title} keeps the archive.`,
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: 'characters/old-order.md', content: contentFor('Old Order Keeper') },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const sibling = await createKnowledgeEntry(novel.id, {
        type: 'timeline',
        title: 'Move Ordered Event',
        data: {
          date: '',
          dateSort: 1,
          eventType: 'character',
          description: 'References an entry that moves paths',
          chapterIds: [],
          characterRefs: [entryId],
          importance: 'minor',
        },
        tags: [],
      });

      expect(
        await reconcileVaultChangedFiles(novel.id, [
          { path: 'characters/old-order.md', content: null },
          { path: 'characters/new-order.md', content: contentFor('New Order Keeper') },
        ]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      expect((await getKnowledgeEntry(entryId, novel.id))?.title).toBe('New Order Keeper');
      expect(await listKnowledgeIndexForNovel(novel.id)).toHaveLength(2);
      expect(await getKnowledgeIndexById(entryId)).toMatchObject({
        id: entryId,
        path: 'characters/new-order.md',
        title: 'New Order Keeper',
      });
      const siblingAfter = await getKnowledgeEntry(sibling.id, novel.id);
      expect(JSON.parse(siblingAfter!.data).characterRefs).toEqual([entryId]);
      expect((await getKnowledgeIndexById(sibling.id))?.data.characterRefs).toEqual([entryId]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('assigns stable UUID fallback ids for hand-written vault files without frontmatter ids', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');
    const { updateKnowledgeEntry } = await import('@/app/actions/knowledge');

    const novel = await createNovel({ userId: 'local-user', title: 'Vault handwritten id' });
    const pathName = 'characters/handwritten.md';
    const content = [
      '---',
      'type: character',
      'title: Hand Written',
      'role: supporting',
      'description: Added directly in the vault',
      '---',
      'Hand Written appears in [[North Gate]].',
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(novel.id, [{ path: pathName, content }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const [indexRow] = await listKnowledgeIndexForNovel(novel.id);
      expect(indexRow.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(indexRow.id).not.toContain('/');
      expect((await getKnowledgeEntry(indexRow.id, novel.id))?.title).toBe('Hand Written');

      await updateKnowledgeEntry(indexRow.id, { title: 'Editable Hand Written' });
      expect((await getKnowledgeEntry(indexRow.id, novel.id))?.title).toBe('Editable Hand Written');

      expect(
        await reconcileVaultChangedFiles(novel.id, [{ path: pathName, content }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });
      expect((await listKnowledgeIndexForNovel(novel.id))[0].id).toBe(indexRow.id);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('scopes fallback vault ids by novel so common handwritten paths do not collide', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntry } = await import('@/lib/db');
    const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
    const { reconcileVaultChangedFiles } = await import('@/app/actions/vault');

    const firstNovel = await createNovel({ userId: 'local-user', title: 'Vault shared path A' });
    const secondNovel = await createNovel({ userId: 'local-user', title: 'Vault shared path B' });
    const pathName = 'characters/handwritten.md';
    const content = [
      '---',
      'type: character',
      'title: Hand Written',
      'role: supporting',
      '---',
      'Hand Written appears in both projects.',
      '',
    ].join('\n');

    try {
      expect(
        await reconcileVaultChangedFiles(firstNovel.id, [{ path: pathName, content }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });
      expect(
        await reconcileVaultChangedFiles(secondNovel.id, [{ path: pathName, content }]),
      ).toEqual({ updated: 1, deleted: 0, skipped: 0 });

      const [firstIndex] = await listKnowledgeIndexForNovel(firstNovel.id);
      const [secondIndex] = await listKnowledgeIndexForNovel(secondNovel.id);
      expect(firstIndex.path).toBe(pathName);
      expect(secondIndex.path).toBe(pathName);
      expect(firstIndex.id).not.toBe(secondIndex.id);
      expect((await getKnowledgeEntry(firstIndex.id, firstNovel.id))?.title).toBe('Hand Written');
      expect((await getKnowledgeEntry(secondIndex.id, secondNovel.id))?.title).toBe('Hand Written');
    } finally {
      await deleteNovelCascade(firstNovel.id, 'local-user');
      await deleteNovelCascade(secondNovel.id, 'local-user');
    }
  });

});
