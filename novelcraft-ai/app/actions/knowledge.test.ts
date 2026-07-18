import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Set INKMARSHAL_DATA_DIR before any module import so the lazy singleton
// opens inside our tmp directory.
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
const PREV_EMBED_BASE_URL = process.env.INKMARSHAL_EMBED_BASE_URL;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-knowledge-test-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
  delete process.env.INKMARSHAL_EMBED_BASE_URL;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  if (PREV_EMBED_BASE_URL === undefined) delete process.env.INKMARSHAL_EMBED_BASE_URL;
  else process.env.INKMARSHAL_EMBED_BASE_URL = PREV_EMBED_BASE_URL;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('knowledge relation ownership helpers', () => {
  it('accepts relation endpoints from the same owned novel', async () => {
    const { knowledgeRelationEndpointsMatch } = await import('@/lib/knowledge-ownership');
    expect(knowledgeRelationEndpointsMatch(
      { novel_id: 'novel-1' },
      { novel_id: 'novel-1' },
    )).toBe(true);
  });

  it('rejects relation endpoints across novels', async () => {
    const { knowledgeRelationEndpointsMatch } = await import('@/lib/knowledge-ownership');
    expect(knowledgeRelationEndpointsMatch(
      { novel_id: 'novel-1' },
      { novel_id: 'novel-2' },
    )).toBe(false);
  });
});

describe('knowledge actions: real SQLite integration', () => {
  const USER_ID = 'local-user';
  let novelId: string;

  beforeAll(async () => {
    const { createNovel } = await import('@/lib/db');
    const novel = await createNovel({ userId: USER_ID, title: 'KE Test Novel', genre: 'thriller', targetWords: 80000 });
    novelId = novel.id;
  });

  afterAll(async () => {
    if (novelId) {
      const { deleteNovelCascade } = await import('@/lib/db');
      await deleteNovelCascade(novelId, USER_ID).catch(() => {});
    }
  });

  it('createKnowledgeEntry → getKnowledgeEntries → getKnowledgeEntry round-trip', async () => {
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntries, getKnowledgeEntry } = await import('@/lib/db');
    const { parseKnowledgeEntry } = await import('@/lib/knowledge');

    const result = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Test Hero',
      data: {
        role: 'protagonist',
        description: 'A brave hero',
        backstory: '',
        motivation: 'Save the world',
        traits: ['brave'],
        arc: 'growth',
      },
      tags: ['main'],
    });

    expect(result.id).toBeTruthy();
    expect(result.novelId).toBe(novelId);
    expect(result.type).toBe('character');
    expect(result.title).toBe('Test Hero');

    const rows = await getKnowledgeEntries(novelId);
    expect(rows.some(r => r.id === result.id)).toBe(true);

    const row = await getKnowledgeEntry(result.id, novelId);
    expect(row).toBeDefined();
    const parsed = parseKnowledgeEntry(row! as unknown as Record<string, unknown>);
    expect(parsed.title).toBe('Test Hero');
    expect(parsed.type).toBe('character');
    expect(parsed.summary).toBeTruthy();
  });

  it('keeps the committed DB entry when best-effort vault markdown sync fails', async () => {
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { createNovel, deleteNovelCascade, getKnowledgeEntries } = await import('@/lib/db');
    const { setNovelVaultPath } = await import('@/lib/db/queries-vault');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const blockedRoot = path.join(tmpDir, 'not-a-vault-directory');
    writeFileSync(blockedRoot, 'file blocks mkdir');
    const novel = await createNovel({
      userId: USER_ID,
      title: 'Vault Sync Failure Novel',
      genre: 'fantasy',
      targetWords: 80_000,
    });

    try {
      await setNovelVaultPath(novel.id, blockedRoot);
      const result = await createKnowledgeEntry(novel.id, {
        type: 'character',
        title: 'Sync Failure Still Commits',
        data: {
          role: 'supporting',
          description: 'The database commit should remain visible.',
          backstory: '',
          motivation: '',
          traits: [],
          arc: '',
        },
        tags: [],
      });

      expect((await getKnowledgeEntries(novel.id)).some(row => row.id === result.id)).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[knowledge] vault markdown sync failed',
        { action: 'createKnowledgeEntry' },
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
      await deleteNovelCascade(novel.id, USER_ID).catch(() => {});
    }
  });

  it('keeps duplicate-title entries indexed with distinct vault paths', async () => {
    const { createKnowledgeEntry, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const first = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Mirror Twin',
      data: {
        role: 'supporting',
        description: 'First duplicate title entry',
        backstory: '',
        motivation: '',
        traits: [],
        arc: '',
      },
      tags: [],
    });
    const second = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Mirror Twin',
      data: {
        role: 'minor',
        description: 'Second duplicate title entry',
        backstory: '',
        motivation: '',
        traits: [],
        arc: '',
      },
      tags: [],
    });

    const firstIndex = await getKnowledgeIndexById(first.id);
    const secondIndex = await getKnowledgeIndexById(second.id);
    expect(firstIndex?.path).toBe('characters/Mirror-Twin.md');
    expect(secondIndex?.path).toContain('characters/Mirror-Twin-');
    expect(secondIndex?.path).not.toBe(firstIndex?.path);

    await updateKnowledgeEntry(second.id, {
      title: 'Mirror Twin',
      data: {
        role: 'minor',
        description: 'Second duplicate title entry after update',
        backstory: '',
        motivation: '',
        traits: [],
        arc: '',
      },
    });
    expect((await getKnowledgeIndexById(second.id))?.title).toBe('Mirror Twin');
    expect((await getKnowledgeIndexById(second.id))?.path).not.toBe(firstIndex?.path);
  });

  it('rolls back createKnowledgeEntry when recall index insertion fails', async () => {
    const { createKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntries } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');

    getDb().prepare(
      `CREATE TEMP TRIGGER fail_create_knowledge_index
        BEFORE INSERT ON knowledge_index
        WHEN NEW.title = 'Index Failure Character'
        BEGIN
          SELECT RAISE(ABORT, 'index insert failed');
        END`,
    ).run();

    try {
      await expect(
        createKnowledgeEntry(novelId, {
          type: 'character',
          title: 'Index Failure Character',
          data: {
            role: 'supporting',
            description: 'Must not persist without recall index',
            backstory: '',
            motivation: '',
            traits: [],
            arc: '',
          },
          tags: [],
        }),
      ).rejects.toThrow('index insert failed');

      expect((await getKnowledgeEntries(novelId)).some(row => row.title === 'Index Failure Character')).toBe(false);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_create_knowledge_index').run();
    }
  });

  it('updateKnowledgeEntry modifies title, data, and recomputes summary', async () => {
    const { createKnowledgeEntry, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntry } = await import('@/lib/db');

    const result = await createKnowledgeEntry(novelId, {
      type: 'world',
      title: 'Old Town',
      data: { category: 'location', description: 'An old town', details: {} },
      tags: [],
    });

    await updateKnowledgeEntry(result.id, {
      title: 'New Town',
      data: { category: 'location', description: 'A shiny new town', details: { population: '5000' } },
    });

    const row = await getKnowledgeEntry(result.id, novelId);
    expect(row).toBeDefined();
    expect(row!.title).toBe('New Town');
    expect(row!.summary).toContain('new town');
  });

  it('rolls back updateKnowledgeEntry when recall index refresh fails', async () => {
    const { createKnowledgeEntry, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntry } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const result = await createKnowledgeEntry(novelId, {
      type: 'world',
      title: 'Atomic Index Town',
      data: { category: 'location', description: 'Original description', details: {} },
      tags: [],
    });

    getDb().prepare(
      `CREATE TEMP TRIGGER fail_update_knowledge_index
        BEFORE UPDATE ON knowledge_index
        WHEN OLD.id = '${result.id}'
        BEGIN
          SELECT RAISE(ABORT, 'index update failed');
        END`,
    ).run();

    try {
      await expect(
        updateKnowledgeEntry(result.id, {
          title: 'Atomic Index Town Updated',
          data: { category: 'location', description: 'Changed description', details: {} },
        }),
      ).rejects.toThrow('index update failed');

      const legacyAfter = await getKnowledgeEntry(result.id, novelId);
      expect(legacyAfter?.title).toBe('Atomic Index Town');
      expect(JSON.parse(legacyAfter!.data).description).toBe('Original description');
      expect((await getKnowledgeIndexById(result.id))?.title).toBe('Atomic Index Town');
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_update_knowledge_index').run();
    }
  });

  it('does not refresh entry or novel recency for empty or same-value updates', async () => {
    const { createKnowledgeEntry, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntry, getNovel } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');

    const data = { category: 'location' as const, description: 'Stable place', details: {} };
    const result = await createKnowledgeEntry(novelId, {
      type: 'world',
      title: 'Stable Town',
      data,
      tags: ['stable'],
    });
    const stale = '2000-01-01T00:00:00.000Z';
    getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novelId);
    getDb().prepare('UPDATE knowledge_entries SET updated_at = ? WHERE id = ?').run(stale, result.id);

    await updateKnowledgeEntry(result.id, {});
    expect((await getNovel(novelId))?.updatedAt).toBe(Date.parse(stale));
    const afterEmpty = await getKnowledgeEntry(result.id, novelId);
    expect(afterEmpty?.updated_at).toBe(stale);
    expect(JSON.parse(afterEmpty!.tags)).toEqual(['stable']);

    await updateKnowledgeEntry(result.id, {
      title: 'Stable Town',
      data,
      tags: ['stable'],
    });
    expect((await getNovel(novelId))?.updatedAt).toBe(Date.parse(stale));
    const afterSame = await getKnowledgeEntry(result.id, novelId);
    expect(afterSame?.updated_at).toBe(stale);
    expect(JSON.parse(afterSame!.tags)).toEqual(['stable']);
  });

  it('updateKnowledgeEntry removes stale semantic embeddings before async rebuild', async () => {
    const { createKnowledgeEntry, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEmbedding, upsertKnowledgeEmbedding } = await import('@/lib/db/queries-knowledge-vault');

    const result = await createKnowledgeEntry(novelId, {
      type: 'world',
      title: 'Vector Town',
      data: { category: 'location', description: 'Old vector text', details: {} },
      tags: [],
    });
    await upsertKnowledgeEmbedding({
      id: result.id,
      novelId,
      modelId: 'test-embedder',
      dim: 2,
      vector: Float32Array.from([1, 0]),
      contentHash: 'old-content',
      updatedAt: new Date().toISOString(),
    });

    await updateKnowledgeEntry(result.id, {
      data: { category: 'location', description: 'New vector text', details: {} },
    });

    expect(await getKnowledgeEmbedding(result.id)).toBeNull();
  });

  it('updateKnowledgeEntry rejects oversized metadata before refreshing summary/index state', async () => {
    const { createKnowledgeEntry, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntry } = await import('@/lib/db');

    const result = await createKnowledgeEntry(novelId, {
      type: 'world',
      title: 'Bounded Town',
      data: { category: 'location', description: 'Small and quiet', details: {} },
      tags: ['ok'],
    });

    await expect(
      updateKnowledgeEntry(result.id, { title: 'x'.repeat(201) }),
    ).rejects.toThrow();
    await expect(
      updateKnowledgeEntry(result.id, {
        data: { category: 'location', description: 'x'.repeat(3001), details: {} },
      }),
    ).rejects.toThrow();

    const row = await getKnowledgeEntry(result.id, novelId);
    expect(row!.title).toBe('Bounded Town');
    expect(JSON.parse(row!.data).description).toBe('Small and quiet');
  });

  it('rejects unbounded structured knowledge lists before DB/index writes', async () => {
    const { createKnowledgeEntry, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntries, getKnowledgeEntry } = await import('@/lib/db');

    await expect(
      createKnowledgeEntry(novelId, {
        type: 'timeline',
        title: 'Oversized Timeline',
        data: {
          date: 'Day 9',
          dateSort: 9,
          eventType: 'plot',
          description: 'Oversized reference payload',
          chapterIds: Array.from({ length: 51 }, (_, i) => `ch-${i}`),
          characterRefs: [],
          importance: 'minor',
        },
        tags: [],
      }),
    ).rejects.toThrow();
    expect((await getKnowledgeEntries(novelId)).some(row => row.title === 'Oversized Timeline')).toBe(false);

    const outline = await createKnowledgeEntry(novelId, {
      type: 'outline',
      title: 'Bounded Outline',
      data: {
        chapterId: '',
        chapterNumber: 1,
        synopsis: 'Small outline',
        keyEvents: [],
        characters: ['Hero'],
        pov: '',
        status: 'planned',
        wordCountTarget: 1200,
        notes: '',
      },
      tags: [],
    });

    await expect(
      updateKnowledgeEntry(outline.id, {
        data: {
          chapterId: '',
          chapterNumber: 1,
          synopsis: 'Small outline',
          keyEvents: ['x'.repeat(201)],
          characters: ['Hero'],
          pov: '',
          status: 'planned',
          wordCountTarget: 1200,
          notes: '',
        },
      }),
    ).rejects.toThrow();

    const row = await getKnowledgeEntry(outline.id, novelId);
    expect(JSON.parse(row!.data).keyEvents).toEqual([]);
  });

  it('deleteKnowledgeEntry removes entry and cascades relations', async () => {
    const { createKnowledgeEntry, deleteKnowledgeEntry, createKnowledgeRelation } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntryById, getKnowledgeRelationById } = await import('@/lib/db');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const e1 = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Source Char',
      data: { role: 'supporting', description: 'source', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const e2 = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Target Char',
      data: { role: 'supporting', description: 'target', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });

    const rel = await createKnowledgeRelation({
      sourceId: e1.id,
      targetId: e2.id,
      relationType: 'ally',
      label: 'allies',
    });
    expect(rel.id).toBeTruthy();

    // Verify relation exists
    const relBefore = await getKnowledgeRelationById(rel.id);
    expect(relBefore).toBeDefined();

    // Delete source entry — relation should cascade
    await deleteKnowledgeEntry(e1.id);
    expect(await getKnowledgeEntryById(e1.id)).toBeUndefined();
    expect(await getKnowledgeIndexById(e1.id)).toBeNull();
    // Relation cascaded via FK ON DELETE CASCADE on source_id
    const relAfter = await getKnowledgeRelationById(rel.id);
    expect(relAfter).toBeUndefined();
  });

  it('deleteKnowledgeEntry clears dangling references from both current rows and recall index', async () => {
    const { createKnowledgeEntry, deleteKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntryById } = await import('@/lib/db');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const character = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Referenced Character',
      data: { role: 'supporting', description: 'referenced', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const timeline = await createKnowledgeEntry(novelId, {
      type: 'timeline',
      title: 'Linked Event',
      data: {
        date: 'Day 1',
        dateSort: 1,
        eventType: 'character',
        description: 'Event tied to a character',
        chapterIds: [],
        characterRefs: [character.id],
        importance: 'major',
      },
      tags: [],
    });

    expect((await getKnowledgeIndexById(timeline.id))?.data.characterRefs).toEqual([character.id]);

    await deleteKnowledgeEntry(character.id);

    const legacyAfter = await getKnowledgeEntryById(timeline.id);
    expect(JSON.parse(legacyAfter!.data).characterRefs).toEqual([]);
    expect((await getKnowledgeIndexById(timeline.id))?.data.characterRefs).toEqual([]);
  });

  it('rolls back dangling reference cleanup when final knowledge delete fails', async () => {
    const { createKnowledgeEntry, deleteKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntryById } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const character = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Rollback Referenced Character',
      data: { role: 'supporting', description: 'referenced', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const timeline = await createKnowledgeEntry(novelId, {
      type: 'timeline',
      title: 'Rollback Linked Event',
      data: {
        date: 'Day 3',
        dateSort: 3,
        eventType: 'character',
        description: 'Event tied to a character whose delete fails',
        chapterIds: [],
        characterRefs: [character.id],
        importance: 'major',
      },
      tags: [],
    });

    getDb().prepare(
      `CREATE TEMP TRIGGER fail_knowledge_delete_after_cleanup
        BEFORE DELETE ON knowledge_entries
        WHEN OLD.id = '${character.id}'
        BEGIN
          SELECT RAISE(ABORT, 'knowledge delete failed');
        END`,
    ).run();

    try {
      await expect(deleteKnowledgeEntry(character.id)).rejects.toThrow('knowledge delete failed');

      expect(await getKnowledgeEntryById(character.id)).toBeDefined();
      const legacyAfter = await getKnowledgeEntryById(timeline.id);
      expect(JSON.parse(legacyAfter!.data).characterRefs).toEqual([character.id]);
      expect((await getKnowledgeIndexById(timeline.id))?.data.characterRefs).toEqual([character.id]);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_knowledge_delete_after_cleanup').run();
    }
  });

  it('deleteKnowledgeEntry clears stale embeddings for deleted and rewritten entries', async () => {
    const { createKnowledgeEntry, deleteKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEmbedding, upsertKnowledgeEmbedding } = await import('@/lib/db/queries-knowledge-vault');

    const character = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Embedded Character',
      data: { role: 'supporting', description: 'embedded', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const timeline = await createKnowledgeEntry(novelId, {
      type: 'timeline',
      title: 'Embedded Linked Event',
      data: {
        date: 'Day 2',
        dateSort: 2,
        eventType: 'character',
        description: 'Event tied to embedded character',
        chapterIds: [],
        characterRefs: [character.id],
        importance: 'major',
      },
      tags: [],
    });
    for (const id of [character.id, timeline.id]) {
      await upsertKnowledgeEmbedding({
        id,
        novelId,
        modelId: 'test-embedder',
        dim: 2,
        vector: Float32Array.from([0.5, 0.5]),
        contentHash: 'old-content',
        updatedAt: new Date().toISOString(),
      });
    }

    await deleteKnowledgeEntry(character.id);

    expect(await getKnowledgeEmbedding(character.id)).toBeNull();
    expect(await getKnowledgeEmbedding(timeline.id)).toBeNull();
  });

  it('deleteKnowledgeRelation removes only the relation', async () => {
    const { createKnowledgeEntry, createKnowledgeRelation, deleteKnowledgeRelation } = await import('@/app/actions/knowledge');
    const { getKnowledgeRelationById } = await import('@/lib/db');

    const e1 = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Char A',
      data: { role: 'minor', description: 'a', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const e2 = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Char B',
      data: { role: 'minor', description: 'b', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });

    const rel = await createKnowledgeRelation({
      sourceId: e1.id,
      targetId: e2.id,
      relationType: 'rival',
      label: '',
    });

    await deleteKnowledgeRelation(rel.id);
    expect(await getKnowledgeRelationById(rel.id)).toBeUndefined();
  });

  it('create/deleteKnowledgeRelation keeps source recall index links in sync', async () => {
    const { createKnowledgeEntry, createKnowledgeRelation, deleteKnowledgeRelation } = await import('@/app/actions/knowledge');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');

    const source = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Indexed Source',
      data: { role: 'supporting', description: 'source', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const target = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Indexed Target',
      data: { role: 'supporting', description: 'target', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });

    const rel = await createKnowledgeRelation({
      sourceId: source.id,
      targetId: target.id,
      relationType: 'ally',
      label: 'trusts',
    });
    expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([
      { raw: 'Indexed Target' },
    ]);
    await upsertKnowledgeEmbedding({
      id: source.id,
      novelId,
      modelId: 'test-embedder',
      dim: 2,
      vector: Float32Array.from([0.25, 0.75]),
      contentHash: 'stale-before-relation-delete',
      updatedAt: new Date().toISOString(),
    });

    await deleteKnowledgeRelation(rel.id);
    expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([]);
    expect(await getKnowledgeEmbedding(source.id)).toBeNull();
  });

  it('rolls back createKnowledgeRelation when source recall index refresh fails', async () => {
    const { createKnowledgeEntry, createKnowledgeRelation } = await import('@/app/actions/knowledge');
    const { getKnowledgeRelationsByEntry } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const source = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Relation Rollback Source',
      data: { role: 'supporting', description: 'source', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const target = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Relation Rollback Target',
      data: { role: 'supporting', description: 'target', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });

    getDb().prepare(
      `CREATE TEMP TRIGGER fail_relation_create_index
        BEFORE UPDATE ON knowledge_index
        WHEN OLD.id = '${source.id}'
        BEGIN
          SELECT RAISE(ABORT, 'relation index create failed');
        END`,
    ).run();

    try {
      await expect(
        createKnowledgeRelation({
          sourceId: source.id,
          targetId: target.id,
          relationType: 'ally',
          label: 'blocked',
        }),
      ).rejects.toThrow('relation index create failed');

      expect(await getKnowledgeRelationsByEntry(source.id)).toEqual([]);
      expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([]);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_relation_create_index').run();
    }
  });

  it('rolls back deleteKnowledgeRelation when source recall index refresh fails', async () => {
    const { createKnowledgeEntry, createKnowledgeRelation, deleteKnowledgeRelation } = await import('@/app/actions/knowledge');
    const { getKnowledgeRelationById } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const source = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Relation Delete Rollback Source',
      data: { role: 'supporting', description: 'source', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const target = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Relation Delete Rollback Target',
      data: { role: 'supporting', description: 'target', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const rel = await createKnowledgeRelation({
      sourceId: source.id,
      targetId: target.id,
      relationType: 'ally',
      label: 'kept',
    });
    expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([
      { raw: 'Relation Delete Rollback Target' },
    ]);

    getDb().prepare(
      `CREATE TEMP TRIGGER fail_relation_delete_index
        BEFORE UPDATE ON knowledge_index
        WHEN OLD.id = '${source.id}'
        BEGIN
          SELECT RAISE(ABORT, 'relation index delete failed');
        END`,
    ).run();

    try {
      await expect(deleteKnowledgeRelation(rel.id)).rejects.toThrow('relation index delete failed');

      expect(await getKnowledgeRelationById(rel.id)).toBeDefined();
      expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([
        { raw: 'Relation Delete Rollback Target' },
      ]);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_relation_delete_index').run();
    }
  });

  it('renaming a relation target refreshes incoming source recall links', async () => {
    const { createKnowledgeEntry, createKnowledgeRelation, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');

    const source = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Incoming Source',
      data: { role: 'supporting', description: 'source', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const target = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Old Target Name',
      data: { role: 'supporting', description: 'target', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    await createKnowledgeRelation({
      sourceId: source.id,
      targetId: target.id,
      relationType: 'ally',
      label: '',
    });
    expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([
      { raw: 'Old Target Name' },
    ]);
    await upsertKnowledgeEmbedding({
      id: source.id,
      novelId,
      modelId: 'test-embedder',
      dim: 2,
      vector: Float32Array.from([0.1, 0.9]),
      contentHash: 'stale-before-target-rename',
      updatedAt: new Date().toISOString(),
    });

    await updateKnowledgeEntry(target.id, { title: 'New Target Name' });

    expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([
      { raw: 'New Target Name' },
    ]);
    expect(await getKnowledgeEmbedding(source.id)).toBeNull();
  });

  it('deleting a relation target refreshes incoming source recall links after cascade', async () => {
    const { createKnowledgeEntry, createKnowledgeRelation, deleteKnowledgeEntry } = await import('@/app/actions/knowledge');
    const {
      getKnowledgeEmbedding,
      getKnowledgeIndexById,
      upsertKnowledgeEmbedding,
    } = await import('@/lib/db/queries-knowledge-vault');

    const source = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Cascade Source',
      data: { role: 'supporting', description: 'source', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const target = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Cascade Target',
      data: { role: 'supporting', description: 'target', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    await createKnowledgeRelation({
      sourceId: source.id,
      targetId: target.id,
      relationType: 'rival',
      label: '',
    });
    expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([
      { raw: 'Cascade Target' },
    ]);
    await upsertKnowledgeEmbedding({
      id: source.id,
      novelId,
      modelId: 'test-embedder',
      dim: 2,
      vector: Float32Array.from([0.6, 0.4]),
      contentHash: 'stale-before-target-delete',
      updatedAt: new Date().toISOString(),
    });

    await deleteKnowledgeEntry(target.id);

    expect((await getKnowledgeIndexById(source.id))?.outgoingLinks).toEqual([]);
    expect(await getKnowledgeEmbedding(source.id)).toBeNull();
  });

  it('rolls back target deletion when incoming source recall-link refresh fails', async () => {
    const { createKnowledgeEntry, createKnowledgeRelation, deleteKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getKnowledgeEntryById, getKnowledgeRelationById } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');

    const source = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Rollback Source',
      data: { role: 'supporting', description: 'source', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const target = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Rollback Target',
      data: { role: 'supporting', description: 'target', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });
    const rel = await createKnowledgeRelation({
      sourceId: source.id,
      targetId: target.id,
      relationType: 'ally',
      label: '',
    });
    const beforeSourceIndex = await getKnowledgeIndexById(source.id);
    expect(beforeSourceIndex?.outgoingLinks).toEqual([{ raw: 'Rollback Target' }]);

    const db = getDb();
    db.prepare(
      `CREATE TEMP TRIGGER fail_source_index_refresh_on_target_delete
        BEFORE UPDATE ON knowledge_index
        WHEN NEW.id = '${source.id}'
        BEGIN
          SELECT RAISE(ABORT, 'source index refresh failed');
        END`,
    ).run();
    try {
      await expect(deleteKnowledgeEntry(target.id)).rejects.toThrow('source index refresh failed');
    } finally {
      db.prepare('DROP TRIGGER IF EXISTS fail_source_index_refresh_on_target_delete').run();
    }

    expect(await getKnowledgeEntryById(target.id)).toBeDefined();
    expect(await getKnowledgeRelationById(rel.id)).toBeDefined();
    expect(await getKnowledgeIndexById(source.id)).toEqual(beforeSourceIndex);
  });

  it('rejects oversized relation endpoint ids before DB lookup', async () => {
    const { createKnowledgeRelation } = await import('@/app/actions/knowledge');

    await expect(
      createKnowledgeRelation({
        sourceId: 'x'.repeat(129),
        targetId: crypto.randomUUID(),
        relationType: 'ally',
        label: '',
      }),
    ).rejects.toThrow();
  });

  it('rejects self-relations before they can pollute recall links', async () => {
    const { createKnowledgeEntry, createKnowledgeRelation } = await import('@/app/actions/knowledge');
    const { getKnowledgeRelationsByEntry } = await import('@/lib/db');

    const entry = await createKnowledgeEntry(novelId, {
      type: 'character',
      title: 'Self Loop Candidate',
      data: { role: 'supporting', description: 'self', backstory: '', motivation: '', traits: [], arc: '' },
      tags: [],
    });

    await expect(
      createKnowledgeRelation({
        sourceId: entry.id,
        targetId: entry.id,
        relationType: 'identity',
        label: 'self',
      }),
    ).rejects.toThrow();

    expect(await getKnowledgeRelationsByEntry(entry.id)).toEqual([]);
  });
});
