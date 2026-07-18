import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-kidx-query-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function insertIndexRow(input: {
  novelId: string;
  type: 'character' | 'timeline' | 'outline';
  title: string;
  aliases?: string;
  data?: string;
}) {
  const { upsertKnowledgeIndexRow } = await import('@/lib/db/queries-vault');
  const id = crypto.randomUUID();
  await upsertKnowledgeIndexRow({
    id,
    novelId: input.novelId,
    type: input.type,
    path: `${input.type}/${id}.md`,
    title: input.title,
    tags: '[]',
    aliases: input.aliases ?? '[]',
    importance: null,
    data: input.data ?? '{}',
    outgoingLinks: '[]',
    contentHash: id,
    updatedAt: new Date().toISOString(),
  });
  return id;
}

describe('knowledge_index query guards', () => {
  it('matches titles and aliases case-insensitively', async () => {
    const {
      createNovel,
      deleteNovelCascade,
    } = await import('@/lib/db');
    const { matchKnowledgeIndexByNames } = await import('@/lib/db/queries-knowledge-vault');
    const novel = await createNovel({ userId: 'local-user', title: 'Case-insensitive recall' });

    try {
      await insertIndexRow({
        novelId: novel.id,
        type: 'character',
        title: 'Captain Vale',
        aliases: JSON.stringify(['The Navigator']),
      });

      expect((await matchKnowledgeIndexByNames(novel.id, ['captain vale'], 'character')).map(row => row.title))
        .toEqual(['Captain Vale']);
      expect((await matchKnowledgeIndexByNames(novel.id, ['the navigator'], 'character')).map(row => row.title))
        .toEqual(['Captain Vale']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rolls back prior vault rows when an id replacement cannot write its new index', async () => {
    const {
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntry,
    } = await import('@/lib/db');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const {
      replaceVaultKnowledgeProjection,
      upsertKnowledgeIndexRow,
    } = await import('@/lib/db/queries-vault');
    const novel = await createNovel({ userId: 'local-user', title: 'Atomic vault replace' });
    const oldId = crypto.randomUUID();
    const newId = crypto.randomUUID();
    const pathName = 'characters/atomic-replace.md';
    const now = new Date().toISOString();

    try {
      await createKnowledgeEntry({
        id: oldId,
        novelId: novel.id,
        type: 'character',
        title: 'Old Keeper',
        summary: 'old',
        data: '{}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      await upsertKnowledgeIndexRow({
        id: oldId,
        novelId: novel.id,
        type: 'character',
        path: pathName,
        title: 'Old Keeper',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: '{}',
        outgoingLinks: '[]',
        contentHash: 'old-hash',
        updatedAt: now,
      });
      await upsertKnowledgeEmbedding({
        id: oldId,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.2, 0.8]),
        contentHash: 'old-hash',
        updatedAt: now,
      });

      await expect(
        replaceVaultKnowledgeProjection({
          previousId: oldId,
          entry: {
            id: newId,
            novelId: novel.id,
            type: 'character',
            title: 'New Keeper',
            summary: 'new',
            data: '{}',
            sortOrder: 0,
            tags: '[]',
            createdAt: now,
            updatedAt: now,
          },
          index: {
            id: newId,
            novelId: novel.id,
            type: 'invalid-type',
            path: pathName,
            title: 'New Keeper',
            tags: '[]',
            aliases: '[]',
            importance: null,
            data: '{}',
            outgoingLinks: '[]',
            contentHash: 'new-hash',
            updatedAt: now,
          } as Parameters<typeof replaceVaultKnowledgeProjection>[0]['index'],
        }),
      ).rejects.toThrow();

      expect((await getKnowledgeEntry(oldId, novel.id))?.title).toBe('Old Keeper');
      expect((await getKnowledgeIndexById(oldId))?.title).toBe('Old Keeper');
      expect(await getKnowledgeEmbedding(oldId)).not.toBeNull();
      expect(await getKnowledgeEntry(newId, novel.id)).toBeUndefined();
      expect(await getKnowledgeIndexById(newId)).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects projecting a knowledge id already owned by another novel', async () => {
    const { createNovel, deleteNovelCascade, createKnowledgeEntry, getKnowledgeEntry } =
      await import('@/lib/db');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    const { replaceVaultKnowledgeProjection, KnowledgeEntryIdCollisionError } =
      await import('@/lib/db/queries-vault');
    const novelA = await createNovel({ userId: 'local-user', title: 'Owner novel A' });
    const novelB = await createNovel({ userId: 'local-user', title: 'Borrower novel B' });
    const sharedId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      // novel A legitimately owns `sharedId`.
      await createKnowledgeEntry({
        id: sharedId,
        novelId: novelA.id,
        type: 'character',
        title: 'A Owner',
        summary: 'a',
        data: '{}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });

      // novel B tries to project the same id — must throw, not silently no-op the
      // entry insert while still writing the index row (projection desync).
      await expect(
        replaceVaultKnowledgeProjection({
          entry: {
            id: sharedId,
            novelId: novelB.id,
            type: 'character',
            title: 'B Borrower',
            summary: 'b',
            data: '{}',
            sortOrder: 0,
            tags: '[]',
            createdAt: now,
            updatedAt: now,
          },
          index: {
            id: sharedId,
            novelId: novelB.id,
            type: 'character',
            path: 'characters/borrow.md',
            title: 'B Borrower',
            tags: '[]',
            aliases: '[]',
            importance: null,
            data: '{}',
            outgoingLinks: '[]',
            contentHash: 'b-hash',
            updatedAt: now,
          },
        }),
      ).rejects.toThrow(KnowledgeEntryIdCollisionError);

      // A's entry untouched; B never persisted an entry or a dangling index row.
      expect((await getKnowledgeEntry(sharedId, novelA.id))?.title).toBe('A Owner');
      expect(await getKnowledgeEntry(sharedId, novelB.id)).toBeUndefined();
      expect(await getKnowledgeIndexById(sharedId)).toBeNull();
    } finally {
      await deleteNovelCascade(novelA.id, 'local-user');
      await deleteNovelCascade(novelB.id, 'local-user');
    }
  });

  it('skips malformed embedding blobs without breaking the whole embedding list', async () => {
    const { createKnowledgeEntry, createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      getKnowledgeEmbedding,
      listKnowledgeEmbeddings,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const { upsertKnowledgeIndexRow } = await import('@/lib/db/queries-vault');
    const novel = await createNovel({ userId: 'local-user', title: 'Malformed embedding rows' });
    const goodId = crypto.randomUUID();
    const badId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await createKnowledgeEntry({
        id: goodId,
        novelId: novel.id,
        type: 'character',
        title: 'Good Vector',
        summary: 'good',
        data: '{}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      await createKnowledgeEntry({
        id: badId,
        novelId: novel.id,
        type: 'character',
        title: 'Bad Vector',
        summary: 'bad',
        data: '{}',
        sortOrder: 1,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      for (const [id, title] of [[goodId, 'Good Vector'], [badId, 'Bad Vector']] as const) {
        await upsertKnowledgeIndexRow({
          id,
          novelId: novel.id,
          type: 'character',
          path: `characters/${id}.md`,
          title,
          tags: '[]',
          aliases: '[]',
          importance: null,
          data: '{}',
          outgoingLinks: '[]',
          contentHash: id,
          updatedAt: now,
        });
      }
      await upsertKnowledgeEmbedding({
        id: goodId,
        novelId: novel.id,
        modelId: 'embedder',
        dim: 2,
        vector: Float32Array.from([0.1, 0.9]),
        contentHash: 'good',
        updatedAt: now,
      });
      getDb().prepare(
        `INSERT INTO knowledge_embeddings (id, novel_id, model_id, dim, vector, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(badId, novel.id, 'embedder', 2, Buffer.from([1, 2, 3]), 'bad', now);

      expect(await getKnowledgeEmbedding(badId)).toBeNull();
      expect((await listKnowledgeEmbeddings(novel.id)).map(row => row.id)).toEqual([goodId]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rolls back index and embedding deletes when knowledge deletion fails', async () => {
    const {
      createKnowledgeEntry,
      createNovel,
      deleteKnowledgeEntry,
      deleteNovelCascade,
      getKnowledgeEntry,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');
    const { upsertKnowledgeIndexRow } = await import('@/lib/db/queries-vault');
    const novel = await createNovel({ userId: 'local-user', title: 'Atomic knowledge delete' });
    const entryId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      await createKnowledgeEntry({
        id: entryId,
        novelId: novel.id,
        type: 'character',
        title: 'Rollback Keeper',
        summary: 'rollback',
        data: '{}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      await upsertKnowledgeIndexRow({
        id: entryId,
        novelId: novel.id,
        type: 'character',
        path: 'characters/rollback-keeper.md',
        title: 'Rollback Keeper',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: '{}',
        outgoingLinks: '[]',
        contentHash: 'rollback-hash',
        updatedAt: now,
      });
      await upsertKnowledgeEmbedding({
        id: entryId,
        novelId: novel.id,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.4, 0.6]),
        contentHash: 'rollback-hash',
        updatedAt: now,
      });

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_legacy_delete
         BEFORE DELETE ON knowledge_entries
         WHEN OLD.id = '${entryId}'
         BEGIN
           SELECT RAISE(ABORT, 'forced legacy delete failure');
         END`,
      ).run();

      await expect(deleteKnowledgeEntry(entryId)).rejects.toThrow('forced legacy delete failure');

      expect((await getKnowledgeEntry(entryId, novel.id))?.title).toBe('Rollback Keeper');
      expect((await getKnowledgeIndexById(entryId))?.title).toBe('Rollback Keeper');
      expect(await getKnowledgeEmbedding(entryId)).not.toBeNull();
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS temp.fail_legacy_delete').run();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('skips malformed alias JSON instead of aborting name recall', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { matchKnowledgeIndexByNames } = await import('@/lib/db/queries-knowledge-vault');
    const novel = await createNovel({ userId: 'local-user', title: 'Malformed aliases' });
    try {
      await insertIndexRow({
        novelId: novel.id,
        type: 'character',
        title: 'Broken Alias Row',
        aliases: '[',
      });
      await insertIndexRow({
        novelId: novel.id,
        type: 'character',
        title: 'Ariadne',
        aliases: '["Thread Keeper"]',
      });

      const rows = await matchKnowledgeIndexByNames(novel.id, ['Thread Keeper'], 'character');
      expect(rows.map(row => row.title)).toEqual(['Ariadne']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('skips malformed timeline data and matches chapter numbers exactly', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const {
      matchTimelineByChapterIds,
      matchTimelineByChapterNumber,
    } = await import('@/lib/db/queries-knowledge-vault');
    const novel = await createNovel({ userId: 'local-user', title: 'Malformed timelines' });
    try {
      await insertIndexRow({
        novelId: novel.id,
        type: 'timeline',
        title: 'Broken Timeline',
        data: '{',
      });
      await insertIndexRow({
        novelId: novel.id,
        type: 'timeline',
        title: 'Chapter Twelve',
        data: JSON.stringify({ chapterNumber: 12, chapterIds: ['ch-12'] }),
      });
      await insertIndexRow({
        novelId: novel.id,
        type: 'timeline',
        title: 'Chapter Two',
        data: JSON.stringify({ chapterNumber: 2, chapterIds: ['ch-2'] }),
      });

      expect((await matchTimelineByChapterIds(novel.id, ['ch-2'])).map(row => row.title)).toEqual(['Chapter Two']);
      expect((await matchTimelineByChapterNumber(novel.id, 2)).map(row => row.title)).toEqual(['Chapter Two']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('matches outline chapter numbers exactly and skips malformed data', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getOutlineIndexForChapter } = await import('@/lib/db/queries-knowledge-vault');
    const novel = await createNovel({ userId: 'local-user', title: 'Malformed outline index' });
    try {
      await insertIndexRow({
        novelId: novel.id,
        type: 'outline',
        title: 'Broken Outline',
        data: '{',
      });
      await insertIndexRow({
        novelId: novel.id,
        type: 'outline',
        title: 'Chapter Twelve Outline',
        data: JSON.stringify({ chapterNumber: 12 }),
      });
      await insertIndexRow({
        novelId: novel.id,
        type: 'outline',
        title: 'Chapter Two Outline',
        data: JSON.stringify({ chapterNumber: 2 }),
      });

      expect((await getOutlineIndexForChapter(novel.id, 2))?.title).toBe('Chapter Two Outline');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
