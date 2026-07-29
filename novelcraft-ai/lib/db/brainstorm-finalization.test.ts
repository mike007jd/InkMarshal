import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-brainstorm-finalization-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedCompleteDeck(novelId: string) {
  const { createKnowledgeEntry, updateNovel } = await import('@/lib/db');
  await updateNovel(novelId, {
    genre: 'Mystery',
    storySummary: 'An investigator finds a self-rewriting index.',
    characterSummary: 'Lin Che stays rational under erasure pressure.',
    arcSummary: 'Chapter one traps him inside the rewrite rule.',
  });
  const now = '2026-07-29T00:00:00.000Z';
  for (const card of [
    {
      id: crypto.randomUUID(),
      type: 'character' as const,
      title: 'Lin Che',
      summary: 'Investigator.',
      data: JSON.stringify({ description: 'Investigator.' }),
    },
    {
      id: crypto.randomUUID(),
      type: 'world' as const,
      title: 'Fog Harbor Archive',
      summary: 'Indexes rewrite themselves.',
      data: JSON.stringify({ description: 'Indexes rewrite themselves.' }),
    },
    {
      id: crypto.randomUUID(),
      type: 'outline' as const,
      title: 'Chapter 1',
      summary: 'The index deletes a living person.',
      data: JSON.stringify({ chapterNumber: 1, synopsis: 'The index deletes a living person.' }),
    },
  ]) {
    await createKnowledgeEntry({
      ...card,
      novelId,
      tags: JSON.stringify(['brainstorm']),
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
}

describe('approveExistingBrainstormAtomic', () => {
  it('atomically advances when existing profile and Story Deck coverage are complete', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntries, getNovel } = await import('@/lib/db');
    const { getInterviewState } = await import('@/lib/interview-state-server');
    const { approveExistingBrainstormAtomic } = await import('@/lib/db/brainstorm-finalization');
    const novel = await createNovel({ userId: 'local-user', title: 'Strict Approve Complete' });

    try {
      await seedCompleteDeck(novel.id);
      const beforeEntries = await getKnowledgeEntries(novel.id);
      const result = await approveExistingBrainstormAtomic(novel.id);

      expect(result).toMatchObject({ ok: true, alreadyReady: false });
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect((await getInterviewState(novel.id))?.mode).toBe('proposal_review');
      expect(await getKnowledgeEntries(novel.id)).toEqual(beforeEntries);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects empty profile without title fallback or card writes', async () => {
    const { createKnowledgeEntry, createNovel, deleteNovelCascade, getKnowledgeEntries, getNovel } = await import('@/lib/db');
    const { approveExistingBrainstormAtomic } = await import('@/lib/db/brainstorm-finalization');
    const novel = await createNovel({ userId: 'local-user', title: 'Strict Empty Profile' });

    try {
      const now = '2026-07-29T00:00:00.000Z';
      for (const type of ['character', 'world', 'outline'] as const) {
        await createKnowledgeEntry({
          id: crypto.randomUUID(),
          novelId: novel.id,
          type,
          title: type,
          summary: `${type} summary`,
          data: JSON.stringify({ description: `${type} summary` }),
          tags: JSON.stringify(['brainstorm']),
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        });
      }

      const beforeEntries = await getKnowledgeEntries(novel.id);
      expect(await approveExistingBrainstormAtomic(novel.id)).toEqual({
        ok: false,
        reason: 'incomplete',
      });
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect((await getNovel(novel.id))?.storySummary).toBe('');
      expect(await getKnowledgeEntries(novel.id)).toEqual(beforeEntries);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects incomplete Story Deck without generating missing cards', async () => {
    const {
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getNovel,
      updateNovel,
    } = await import('@/lib/db');
    const { approveExistingBrainstormAtomic } = await import('@/lib/db/brainstorm-finalization');
    const novel = await createNovel({ userId: 'local-user', title: 'Strict Incomplete Deck' });

    try {
      await updateNovel(novel.id, {
        storySummary: 'Profile is filled.',
        characterSummary: 'Cast is filled.',
        arcSummary: 'Arc is filled.',
      });
      const now = '2026-07-29T00:00:00.000Z';
      await createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'character',
        title: 'Only Character',
        summary: 'A lone card.',
        data: JSON.stringify({ description: 'A lone card.' }),
        tags: JSON.stringify(['brainstorm']),
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });

      expect(await approveExistingBrainstormAtomic(novel.id)).toEqual({
        ok: false,
        reason: 'incomplete',
      });
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect((await getKnowledgeEntries(novel.id)).map(entry => entry.type)).toEqual(['character']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('proves transactional coverage: missing card after an external complete check does not repair or advance', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getNovel,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { approveExistingBrainstormAtomic } = await import('@/lib/db/brainstorm-finalization');
    const novel = await createNovel({ userId: 'local-user', title: 'Strict TOCTOU' });

    try {
      await seedCompleteDeck(novel.id);
      const outline = (await getKnowledgeEntries(novel.id, { type: 'outline' }))[0]!;
      // Simulate the race after an external "complete" observation: the card is
      // gone before the transactional primitive reads coverage.
      getDb().prepare('DELETE FROM knowledge_entries WHERE id = ? AND novel_id = ?')
        .run(outline.id, novel.id);
      const beforeUpdatedAt = (await getNovel(novel.id))!.updatedAt;

      expect(await approveExistingBrainstormAtomic(novel.id)).toEqual({
        ok: false,
        reason: 'incomplete',
      });

      const after = await getNovel(novel.id);
      expect(after?.stage).toBe('discovery_interview');
      expect(after?.updatedAt).toBe(beforeUpdatedAt);
      expect((await getKnowledgeEntries(novel.id)).map(entry => entry.type).sort()).toEqual([
        'character',
        'world',
      ]);
      // No repair helper ran inside the primitive.
      expect(getDb().prepare(
        `SELECT COUNT(*) AS count FROM knowledge_entries WHERE novel_id = ? AND type = 'outline'`,
      ).get(novel.id)).toEqual({ count: 0 });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('leaves no half-state when the stage write aborts', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntries, getNovel } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { approveExistingBrainstormAtomic } = await import('@/lib/db/brainstorm-finalization');
    const novel = await createNovel({ userId: 'local-user', title: 'Strict Atomic Fail' });
    const db = getDb();

    try {
      await seedCompleteDeck(novel.id);
      const beforeEntries = await getKnowledgeEntries(novel.id);
      db.prepare(
        `CREATE TEMP TRIGGER fail_strict_approve
         BEFORE UPDATE ON novels
         WHEN NEW.stage = 'ready_for_greenlight'
         BEGIN
           SELECT RAISE(ABORT, 'forced strict approve failure');
         END`,
      ).run();

      await expect(approveExistingBrainstormAtomic(novel.id)).rejects.toThrow(
        'forced strict approve failure',
      );

      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect(await getKnowledgeEntries(novel.id)).toEqual(beforeEntries);
    } finally {
      db.prepare('DROP TRIGGER IF EXISTS temp.fail_strict_approve').run();
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('returns alreadyReady without touching the novel when stage is ready', async () => {
    const { createNovel, deleteNovelCascade, getNovel, updateNovel } = await import('@/lib/db');
    const { approveExistingBrainstormAtomic } = await import('@/lib/db/brainstorm-finalization');
    const novel = await createNovel({ userId: 'local-user', title: 'Strict Already Ready' });

    try {
      await seedCompleteDeck(novel.id);
      await updateNovel(novel.id, { stage: 'ready_for_greenlight', progress: 0 });
      const before = await getNovel(novel.id);

      const result = await approveExistingBrainstormAtomic(novel.id);
      expect(result).toMatchObject({ ok: true, alreadyReady: true });
      expect(await getNovel(novel.id)).toEqual(before);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects a ready novel whose profile or Story Deck became incomplete', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getNovel,
      updateNovel,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { approveExistingBrainstormAtomic } = await import('@/lib/db/brainstorm-finalization');
    const novel = await createNovel({ userId: 'local-user', title: 'Strict Ready Incomplete' });

    try {
      await seedCompleteDeck(novel.id);
      await updateNovel(novel.id, { stage: 'ready_for_greenlight', progress: 0 });
      const outline = (await getKnowledgeEntries(novel.id, { type: 'outline' }))[0]!;
      getDb().prepare('DELETE FROM knowledge_entries WHERE id = ? AND novel_id = ?')
        .run(outline.id, novel.id);
      const before = await getNovel(novel.id);

      expect(await approveExistingBrainstormAtomic(novel.id)).toEqual({
        ok: false,
        reason: 'incomplete',
      });
      expect(await getNovel(novel.id)).toEqual(before);

      await updateNovel(novel.id, { storySummary: '' });
      expect(await approveExistingBrainstormAtomic(novel.id)).toEqual({
        ok: false,
        reason: 'incomplete',
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
