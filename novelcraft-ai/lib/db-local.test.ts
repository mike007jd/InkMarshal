import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/migrations';
import { migrations } from '@/lib/db/schema';

// The local SQLite store resolves its DB file from INKMARSHAL_DATA_DIR (set
// before the module is imported so the lazy singleton opens inside our tmp
// dir). We restore the env in afterAll so the other 32 suites stay green.
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-dbtest-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Dynamic import so the env is in place before the singleton connection opens.
async function db() {
  return import('@/lib/db');
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('db-local: novel round-trip + cascade', () => {
  let novelId: string;

  afterEach(async () => {
    // Best-effort cleanup so each assertion block starts clean.
    if (novelId) {
      const { deleteNovelCascade } = await db();
      await deleteNovelCascade(novelId, USER_ID).catch(() => {});
      novelId = '';
    }
  });

  it('createNovel → getNovel → updateNovel → getNovels → deleteNovelCascade with field + JSON fidelity', async () => {
    const { createNovel, getNovel, updateNovel, getNovels, deleteNovelCascade } = await db();

    const created = await createNovel({ userId: USER_ID, title: 'My Draft', genre: 'fantasy', targetWords: 50000 });
    novelId = created.id;
    expect(created.id).toBeTruthy();
    expect(created.userId).toBe(USER_ID);
    expect(created.title).toBe('My Draft');
    expect(created.genre).toBe('fantasy');
    expect(created.targetWords).toBe(50000);
    expect(created.stage).toBe('discovery_interview');
    expect(created.blueprint).toBeNull();
    expect(typeof created.createdAt).toBe('number');
    expect(created.createdAt).toBeGreaterThan(0);

    const fetched = await getNovel(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.title).toBe('My Draft');
    expect(fetched!.targetWords).toBe(50000);

    // W2-D: blueprint is no longer a SQLite column — it's projected from
    // outline knowledge entries. updateNovel ignores any stray `blueprint`
    // key; callers go through setNovelBlueprint instead.
    const blueprint = {
      chapters: [{ chapterNumber: 1, title: 'Ch1', summary: 'opening' }],
      targetWordsPerChapter: 2500,
      generatedAt: '2026-05-18T00:00:00.000Z',
      modelId: 'test-model',
    };
    const updated = await updateNovel(created.id, {
      title: 'Renamed',
      stage: 'ready_for_greenlight',
      storySummary: 'a tale',
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Renamed');
    expect(updated!.stage).toBe('ready_for_greenlight');
    expect(updated!.storySummary).toBe('a tale');
    // Fresh `getNovel` always returns blueprint = null — the projection lives
    // in `getNovelBlueprint` / `projectBlueprintFromOutline`.
    expect(updated!.blueprint).toBeNull();

    const { setNovelBlueprint, getNovelBlueprint } = await db();
    await setNovelBlueprint(created.id, blueprint);
    const projected = await getNovelBlueprint(created.id);
    expect(projected).not.toBeNull();
    expect(projected!.chapters.map(c => ({
      chapterNumber: c.chapterNumber,
      title: c.title,
      summary: c.summary,
    }))).toEqual(blueprint.chapters);

    const reFetched = await getNovel(created.id);
    expect(reFetched!.blueprint).toBeNull();
    expect(reFetched!.title).toBe('Renamed');

    const list = await getNovels(USER_ID);
    expect(list.some(n => n.id === created.id)).toBe(true);
    // Ownership predicate honored: a different user sees nothing of ours.
    const otherList = await getNovels('22222222-2222-2222-2222-222222222222');
    expect(otherList.some(n => n.id === created.id)).toBe(false);

    // Cascade: add a child chapter, then delete the novel and confirm the
    // child is gone (FK ON DELETE CASCADE).
    const { upsertChapter, getChapters } = await db();
    await upsertChapter(created.id, 1, 'Chapter One', 'hello world');
    expect((await getChapters(created.id)).length).toBe(1);

    const okWrongOwner = await deleteNovelCascade(created.id, '22222222-2222-2222-2222-222222222222');
    expect(okWrongOwner).toBe(false); // ownership predicate blocks foreign delete
    const ok = await deleteNovelCascade(created.id, USER_ID);
    expect(ok).toBe(true);
    expect(await getNovel(created.id)).toBeUndefined();
    expect((await getChapters(created.id)).length).toBe(0); // cascaded
    novelId = '';
  });

  it('blueprint replacement and clear touch novel recency', async () => {
    const { createNovel, getNovel, setNovelBlueprint, clearNovelBlueprint, deleteNovelCascade } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Blueprint Recency', genre: '', targetWords: 80000 });
    const stale = '2000-01-01T00:00:00.000Z';
    try {
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      await setNovelBlueprint(novel.id, {
        chapters: [{ chapterNumber: 1, title: 'Ch1', summary: 'opening' }],
        targetWordsPerChapter: 2500,
        generatedAt: '2026-05-18T00:00:00.000Z',
        modelId: 'test-model',
      });
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));

      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      await clearNovelBlueprint(novel.id);
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('does not report blueprint replacement success when stale outline index deletion fails', async () => {
    const { createNovel, deleteNovelCascade, getNovelBlueprint, setNovelBlueprint } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Atomic Blueprint Replace', genre: '', targetWords: 80000 });
    try {
      await setNovelBlueprint(novel.id, {
        chapters: [{ chapterNumber: 1, title: 'Old Outline', summary: 'old synopsis' }],
        targetWordsPerChapter: 2500,
        generatedAt: '2026-05-18T00:00:00.000Z',
        modelId: 'test-model',
      });

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_outline_index_delete
          BEFORE DELETE ON knowledge_index
          WHEN OLD.novel_id = '${novel.id}' AND OLD.type = 'outline'
          BEGIN
            SELECT RAISE(ABORT, 'outline index delete failed');
          END`,
      ).run();

      await expect(setNovelBlueprint(novel.id, {
        chapters: [{ chapterNumber: 1, title: 'New Outline', summary: 'new synopsis' }],
        targetWordsPerChapter: 2500,
        generatedAt: '2026-05-18T00:00:00.000Z',
        modelId: 'test-model',
      })).rejects.toThrow('outline index delete failed');

      const projected = await getNovelBlueprint(novel.id);
      expect(projected?.chapters.map(chapter => chapter.title)).toEqual(['Old Outline']);
      const indexedTitles = getDb()
        .prepare("SELECT title FROM knowledge_index WHERE novel_id = ? AND type = 'outline'")
        .all(novel.id) as { title: string }[];
      expect(indexedTitles.map(row => row.title)).toEqual(['Old Outline']);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_outline_index_delete').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('rolls back blueprint replacement when fresh outline index insertion fails', async () => {
    const { createNovel, deleteNovelCascade, getNovelBlueprint, setNovelBlueprint } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Atomic Blueprint Insert', genre: '', targetWords: 80000 });
    try {
      await setNovelBlueprint(novel.id, {
        chapters: [{ chapterNumber: 1, title: 'Old Outline', summary: 'old synopsis' }],
        targetWordsPerChapter: 2500,
        generatedAt: '2026-05-18T00:00:00.000Z',
        modelId: 'test-model',
      });

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_outline_index_insert
          BEFORE INSERT ON knowledge_index
          WHEN NEW.novel_id = '${novel.id}' AND NEW.type = 'outline' AND NEW.title = 'New Outline'
          BEGIN
            SELECT RAISE(ABORT, 'outline index insert failed');
          END`,
      ).run();

      await expect(setNovelBlueprint(novel.id, {
        chapters: [{ chapterNumber: 1, title: 'New Outline', summary: 'new synopsis' }],
        targetWordsPerChapter: 2500,
        generatedAt: '2026-05-18T00:00:00.000Z',
        modelId: 'test-model',
      })).rejects.toThrow('outline index insert failed');

      const projected = await getNovelBlueprint(novel.id);
      expect(projected?.chapters.map(chapter => chapter.title)).toEqual(['Old Outline']);
      const indexedTitles = getDb()
        .prepare("SELECT title FROM knowledge_index WHERE novel_id = ? AND type = 'outline'")
        .all(novel.id) as { title: string }[];
      expect(indexedTitles.map(row => row.title)).toEqual(['Old Outline']);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_outline_index_insert').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('completeWritingDraft atomically promotes the novel and writes the completion message', async () => {
    const { completeWritingDraft, createNovel, deleteNovelCascade, getMessages, getNovel, updateNovel } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Atomic completion', genre: '', targetWords: 80000 });
    try {
      await updateNovel(novel.id, { stage: 'autonomous_writing', progress: 92 });

      const completed = await completeWritingDraft(novel.id, 'draft complete');

      expect(completed?.stage).toBe('whole_book_unification');
      expect(completed?.progress).toBe(100);
      expect((await getNovel(novel.id))?.stage).toBe('whole_book_unification');
      expect((await getMessages(novel.id)).map(m => m.content)).toEqual(['draft complete']);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('completeWritingDraft rolls back stage promotion when completion message persistence fails', async () => {
    const { completeWritingDraft, createNovel, deleteNovelCascade, getMessages, getNovel, updateNovel } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Atomic completion rollback', genre: '', targetWords: 80000 });
    try {
      await updateNovel(novel.id, { stage: 'autonomous_writing', progress: 92 });
      getDb().prepare(
        `CREATE TEMP TRIGGER fail_completion_message
          BEFORE INSERT ON messages
          WHEN NEW.content = 'fail completion'
          BEGIN
            SELECT RAISE(ABORT, 'message insert failed');
          END`,
      ).run();

      await expect(completeWritingDraft(novel.id, 'fail completion')).rejects.toThrow('message insert failed');

      const after = await getNovel(novel.id);
      expect(after?.stage).toBe('autonomous_writing');
      expect(after?.progress).toBe(92);
      expect(await getMessages(novel.id)).toEqual([]);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_completion_message').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('persistUnificationReportWithMessage rolls back report persistence when completion message fails', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      getMessages,
      getNovel,
      persistUnificationReportWithMessage,
      updateNovel,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Atomic unification report', genre: '', targetWords: 80000 });
    const report = {
      edits: [],
      summary: 'scan complete',
      generatedAt: new Date(0).toISOString(),
      modelId: 'test-model',
    };
    try {
      await updateNovel(novel.id, { stage: 'whole_book_unification' });
      getDb().prepare(
        `CREATE TEMP TRIGGER fail_unification_report_message
          BEFORE INSERT ON messages
          WHEN NEW.content = 'fail unification message'
          BEGIN
            SELECT RAISE(ABORT, 'unification message insert failed');
          END`,
      ).run();

      await expect(
        persistUnificationReportWithMessage(novel.id, report, 'fail unification message'),
      ).rejects.toThrow('unification message insert failed');

      const after = await getNovel(novel.id);
      expect(after?.unificationReport).toBeNull();
      expect(await getMessages(novel.id)).toEqual([]);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_unification_report_message').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('promoteGreenlightDraftWithMessage rejects stale interview snapshots', async () => {
    const {
      addMessage,
      createNovel,
      deleteNovelCascade,
      getMessages,
      getNovel,
      promoteGreenlightDraftWithMessage,
      updateNovel,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Greenlight stale draft', genre: 'fantasy' });
    const original = await addMessage(novel.id, 'user', 'original premise');
    const baseline = await getNovel(novel.id);
    try {
      await updateNovel(novel.id, { storySummary: 'newer interview draft' });

      const result = await promoteGreenlightDraftWithMessage(
        novel.id,
        baseline!,
        [original.id],
        {
          title: 'stale title',
          genre: 'fantasy',
          storySummary: 'stale story',
          characterSummary: 'stale characters',
          arcSummary: 'stale arc',
        },
        'confirm stale plan',
      );

      expect(result).toEqual({ ok: false, reason: 'conflict' });
      const after = await getNovel(novel.id);
      expect(after?.stage).toBe('discovery_interview');
      expect(after?.title).toBe('Greenlight stale draft');
      expect(after?.storySummary).toBe('newer interview draft');
      expect((await getMessages(novel.id)).map(message => message.content)).toEqual(['original premise']);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('promoteGreenlightDraftWithMessage atomically rolls back when confirmation persistence fails', async () => {
    const {
      addMessage,
      createNovel,
      deleteNovelCascade,
      getMessages,
      getNovel,
      promoteGreenlightDraftWithMessage,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Greenlight rollback', genre: 'fantasy' });
    const original = await addMessage(novel.id, 'user', 'premise');
    const baseline = await getNovel(novel.id);
    try {
      getDb().prepare(
        `CREATE TEMP TRIGGER fail_greenlight_confirm
          BEFORE INSERT ON messages
          WHEN NEW.content = 'fail greenlight confirm'
          BEGIN
            SELECT RAISE(ABORT, 'greenlight confirm failed');
          END`,
      ).run();

      await expect(
        promoteGreenlightDraftWithMessage(
          novel.id,
          baseline!,
          [original.id],
          {
            title: 'generated title',
            genre: 'fantasy',
            storySummary: 'generated story',
            characterSummary: 'generated characters',
            arcSummary: 'generated arc',
          },
          'fail greenlight confirm',
        ),
      ).rejects.toThrow('greenlight confirm failed');

      const after = await getNovel(novel.id);
      expect(after?.stage).toBe('discovery_interview');
      expect(after?.title).toBe('Greenlight rollback');
      expect(after?.storySummary).toBe('');
      expect((await getMessages(novel.id)).map(message => message.content)).toEqual(['premise']);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_greenlight_confirm').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

describe('db-local: desktop local user is seeded + works end-to-end', () => {
  const LOCAL_ID = 'local-user';

  it('the fixed local user is provisioned by init and createNovel→getNovels→deleteNovelCascade works for it', async () => {
    const { createNovel, getNovels, deleteNovelCascade } = await db();

    // The idempotent init seed provisioned the `users` row for the fixed local
    // user, so a novel can be created against it (FK-satisfied) end-to-end.
    const created = await createNovel({ userId: LOCAL_ID, title: 'Local Draft' });
    expect(created.userId).toBe(LOCAL_ID);

    const list = await getNovels(LOCAL_ID);
    expect(list.some(n => n.id === created.id)).toBe(true);

    const ok = await deleteNovelCascade(created.id, LOCAL_ID);
    expect(ok).toBe(true);
    expect((await getNovels(LOCAL_ID)).some(n => n.id === created.id)).toBe(false);
  });
});

describe('db-local: optimistic lock (updateChapterContent)', () => {
  it('stale expected version is rejected with the exact conflict shape; fresh version increments', async () => {
    const { createNovel, upsertChapter, updateChapterContent, getChapter, deleteNovelCascade } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Lock', genre: '', targetWords: 80000 });

    try {
      const ch = await upsertChapter(novel.id, 1, 'T', 'first');
      expect(ch.version).toBe(0);

      // Correct expected version → success, version increments to 1.
      const ok = await updateChapterContent(novel.id, 1, 'second body', 0);
      expect(ok).toEqual({ conflict: false, version: 1 });
      const afterOk = await getChapter(novel.id, 1);
      expect(afterOk!.version).toBe(1);
      expect(afterOk!.content).toBe('second body');

      // Stale expected version (0 again, but DB is now 1) → conflict shape.
      const stale = await updateChapterContent(novel.id, 1, 'third', 0);
      expect(stale).toEqual({ conflict: true, version: -1 });
      // Conflicting write must NOT have landed.
      const afterStale = await getChapter(novel.id, 1);
      expect(afterStale!.version).toBe(1);
      expect(afterStale!.content).toBe('second body');

      // Fresh expected version → success, increments to 2.
      const ok2 = await updateChapterContent(novel.id, 1, 'fourth', 1);
      expect(ok2).toEqual({ conflict: false, version: 2 });

      // No expectedVersion → unconditional write, but still increments from
      // the stored row version instead of resetting the counter.
      const uncond = await updateChapterContent(novel.id, 1, 'fifth');
      expect(uncond).toEqual({ conflict: false, version: 3 });
      expect((await getChapter(novel.id, 1))!.version).toBe(3);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('reports conflict when a versioned write loses between read and update', async () => {
    const { createNovel, upsertChapter, updateChapterContent, getChapter, deleteNovelCascade } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Lock Race', genre: '', targetWords: 80000 });
    const sqlite = getDb();

    try {
      await upsertChapter(novel.id, 1, 'T', 'first');
      sqlite.prepare(`
        CREATE TEMP TRIGGER chapter_update_race
        BEFORE UPDATE OF content ON chapters
        WHEN OLD.novel_id = '${novel.id}' AND OLD.chapter_number = 1 AND OLD.version = 0
        BEGIN
          UPDATE chapters
          SET content = 'racing write', word_count = 2, version = 1
          WHERE id = OLD.id;
          SELECT RAISE(IGNORE);
        END
      `).run();

      const result = await updateChapterContent(novel.id, 1, 'client write', 0);
      expect(result).toEqual({ conflict: true, version: -1 });
      const stored = await getChapter(novel.id, 1);
      expect(stored!.content).toBe('racing write');
      expect(stored!.version).toBe(1);
    } finally {
      sqlite.prepare('DROP TRIGGER IF EXISTS chapter_update_race').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('upsertChapter preserves optimistic-lock history when a chapter already exists', async () => {
    const {
      createNovel,
      upsertChapter,
      updateChapterContent,
      setOriginalContent,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Upsert Lock', genre: '', targetWords: 80000 });

    try {
      await upsertChapter(novel.id, 1, 'T', 'first');
      await setOriginalContent(novel.id, 1, 'original baseline');
      await updateChapterContent(novel.id, 1, 'manual edit', 0);

      const saved = await upsertChapter(novel.id, 1, 'T2', 'generated replacement');

      expect(saved.version).toBe(2);
      expect(saved.content).toBe('generated replacement');
      // D5: an upsert-on-conflict is a fresh generation, so it clears the
      // stale revert-baseline — a later revert can't restore content from the
      // previous draft lineage.
      expect(saved.originalContent).toBeNull();
      const stale = await updateChapterContent(novel.id, 1, 'stale edit', 1);
      expect(stale).toEqual({ conflict: true, version: -1 });
      expect((await getChapter(novel.id, 1))!.content).toBe('generated replacement');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('same-content chapter saves do not bump version or novel recency', async () => {
    const {
      createNovel,
      upsertChapter,
      updateChapterContent,
      getChapter,
      getNovel,
      deleteNovelCascade,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Chapter No-op Save', genre: '', targetWords: 80000 });
    const stale = '2000-01-01T00:00:00.000Z';

    try {
      await upsertChapter(novel.id, 1, 'T', 'same body');
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);

      const current = await getChapter(novel.id, 1);
      const locked = await updateChapterContent(novel.id, 1, 'same body', current!.version);
      expect(locked).toEqual({ conflict: false, version: current!.version });
      expect((await getChapter(novel.id, 1))!.version).toBe(current!.version);
      expect((await getNovel(novel.id))!.updatedAt).toBe(Date.parse(stale));

      const unconditional = await updateChapterContent(novel.id, 1, 'same body');
      expect(unconditional).toEqual({ conflict: false, version: current!.version });
      expect((await getChapter(novel.id, 1))!.version).toBe(current!.version);
      expect((await getNovel(novel.id))!.updatedAt).toBe(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

describe('db-local: chapter tail deletion', () => {
  it('rolls back partial blueprint replacement when tail rewrite insertion fails', async () => {
    const {
      createNovel,
      upsertChapter,
      getChapter,
      getOutlineEntries,
      setNovelBlueprint,
      setNovelBlueprintAfterDeletingChaptersFrom,
      deleteNovelCascade,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Partial Blueprint Rollback', genre: '', targetWords: 80000 });

    try {
      await upsertChapter(novel.id, 1, 'Old 1', 'keep');
      await upsertChapter(novel.id, 2, 'Old 2', 'delete candidate');
      await setNovelBlueprint(novel.id, {
        chapters: [
          { chapterNumber: 1, title: 'Old 1', summary: 'old keep' },
          { chapterNumber: 2, title: 'Old 2', summary: 'old tail' },
        ],
        targetWordsPerChapter: 1000,
        generatedAt: '2026-05-22T00:00:00.000Z',
        modelId: 'test',
      });

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_partial_blueprint_insert
          BEFORE INSERT ON knowledge_entries
          WHEN NEW.novel_id = '${novel.id}' AND NEW.type = 'outline' AND NEW.title = 'New 2'
          BEGIN
            SELECT RAISE(ABORT, 'outline replacement failed');
          END`,
      ).run();

      await expect(setNovelBlueprintAfterDeletingChaptersFrom(novel.id, {
        chapters: [
          { chapterNumber: 1, title: 'Old 1', summary: 'old keep' },
          { chapterNumber: 2, title: 'New 2', summary: 'new tail' },
        ],
        targetWordsPerChapter: 1000,
        generatedAt: '2026-05-23T00:00:00.000Z',
        modelId: 'test',
      }, 2)).rejects.toThrow('outline replacement failed');

      expect(await getChapter(novel.id, 2)).toBeDefined();
      const outlineTitles = (await getOutlineEntries(novel.id)).map(row => row.title);
      expect(outlineTitles).toEqual(['Old 1', 'Old 2']);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_partial_blueprint_insert').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('does not preserve chapterId links for chapters deleted during tail blueprint replacement', async () => {
    const {
      createNovel,
      upsertChapter,
      getChapter,
      getOutlineEntries,
      setNovelBlueprint,
      setNovelBlueprintAfterDeletingChaptersFrom,
      deleteNovelCascade,
    } = await db();
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    const novel = await createNovel({ userId: USER_ID, title: 'Partial Blueprint Stale Links', genre: '', targetWords: 80000 });

    try {
      await upsertChapter(novel.id, 1, 'Old 1', 'keep');
      await upsertChapter(novel.id, 2, 'Old 2', 'delete candidate');
      const chapterOne = (await getChapter(novel.id, 1))!;
      await setNovelBlueprint(novel.id, {
        chapters: [
          { chapterNumber: 1, title: 'Old 1', summary: 'old keep' },
          { chapterNumber: 2, title: 'Old 2', summary: 'old tail' },
        ],
        targetWordsPerChapter: 1000,
        generatedAt: '2026-05-22T00:00:00.000Z',
        modelId: 'test',
      });

      const deleted = await setNovelBlueprintAfterDeletingChaptersFrom(novel.id, {
        chapters: [
          { chapterNumber: 1, title: 'Old 1', summary: 'old keep' },
          { chapterNumber: 2, title: 'New 2', summary: 'new tail' },
          { chapterNumber: 3, title: 'New 3', summary: 'new ending' },
        ],
        targetWordsPerChapter: 1000,
        generatedAt: '2026-05-23T00:00:00.000Z',
        modelId: 'test',
      }, 2);

      expect(deleted).toBe(1);
      expect(await getChapter(novel.id, 2)).toBeUndefined();
      const byChapterNumber = new Map(
        (await getOutlineEntries(novel.id)).map(row => [JSON.parse(row.data).chapterNumber as number, row]),
      );
      expect(JSON.parse(byChapterNumber.get(1)!.data).chapterId).toBe(chapterOne.id);
      expect(JSON.parse(byChapterNumber.get(2)!.data).chapterId).toBe('');
      expect(JSON.parse(byChapterNumber.get(3)!.data).chapterId).toBe('');
      expect((await getKnowledgeIndexById(byChapterNumber.get(2)!.id))?.data.chapterId).toBe('');
      expect((await getKnowledgeIndexById(byChapterNumber.get(3)!.id))?.data.chapterId).toBe('');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('rolls back chapter deletion when outline mirror cleanup fails', async () => {
    const {
      createNovel,
      upsertChapter,
      getChapter,
      createKnowledgeEntry,
      getKnowledgeEntryById,
      deleteChaptersFrom,
      deleteNovelCascade,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const { upsertKnowledgeIndexRow } = await import('@/lib/db/queries-vault');
    const { getKnowledgeIndexById } = await import('@/lib/db/queries-knowledge-vault');
    const novel = await createNovel({ userId: USER_ID, title: 'Tail Delete Rollback', genre: '', targetWords: 80000 });

    try {
      await upsertChapter(novel.id, 1, 'One', 'keep');
      await upsertChapter(novel.id, 2, 'Two', 'delete candidate');
      const chapterTwo = (await getChapter(novel.id, 2))!;
      const now = new Date().toISOString();
      const outlineId = crypto.randomUUID();
      await createKnowledgeEntry({
        id: outlineId,
        novelId: novel.id,
        type: 'outline',
        title: 'Chapter Two Outline',
        summary: '',
        data: JSON.stringify({ chapterId: chapterTwo.id, chapterNumber: 2 }),
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      await upsertKnowledgeIndexRow({
        id: outlineId,
        novelId: novel.id,
        type: 'outline',
        path: 'outline/chapter-two.md',
        title: 'Chapter Two Outline',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: JSON.stringify({ chapterId: chapterTwo.id, chapterNumber: 2 }),
        outgoingLinks: '[]',
        contentHash: 'chapter-two-outline',
        updatedAt: now,
      });

      getDb().prepare(
        `CREATE TEMP TRIGGER fail_delete_chapters_index_cleanup
          BEFORE UPDATE ON knowledge_index
          WHEN OLD.id = '${outlineId}'
          BEGIN
            SELECT RAISE(ABORT, 'outline cleanup failed');
          END`,
      ).run();

      await expect(deleteChaptersFrom(novel.id, 2)).rejects.toThrow('outline cleanup failed');

      expect(await getChapter(novel.id, 2)).toBeDefined();
      expect(JSON.parse((await getKnowledgeEntryById(outlineId))!.data).chapterId).toBe(chapterTwo.id);
      expect((await getKnowledgeIndexById(outlineId))?.data.chapterId).toBe(chapterTwo.id);
    } finally {
      getDb().prepare('DROP TRIGGER IF EXISTS fail_delete_chapters_index_cleanup').run();
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

describe('db-local: knowledge entries + relations', () => {
  it('createKnowledgeEntry → getKnowledgeEntries → getKnowledgeEntry → updateKnowledgeEntry → deleteKnowledgeEntry', async () => {
    const {
      createNovel, deleteNovelCascade,
      createKnowledgeEntry, getKnowledgeEntries, getKnowledgeEntry, getKnowledgeEntryById,
      updateKnowledgeEntry, deleteKnowledgeEntry,
    } = await db();

    const novel = await createNovel({ userId: USER_ID, title: 'KE Novel', genre: 'test', targetWords: 80000 });
    try {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const entry = await createKnowledgeEntry({
        id,
        novelId: novel.id,
        type: 'character',
        title: 'Hero',
        summary: 'A brave one',
        data: '{"role":"protagonist"}',
        sortOrder: 0,
        tags: '["main"]',
        createdAt: now,
        updatedAt: now,
      });
      expect(entry.id).toBe(id);
      expect(entry.title).toBe('Hero');
      expect(entry.novel_id).toBe(novel.id);

      // getKnowledgeEntries lists it
      const entries = await getKnowledgeEntries(novel.id);
      expect(entries.some(e => e.id === id)).toBe(true);

      // type filter
      const chars = await getKnowledgeEntries(novel.id, { type: 'character' });
      expect(chars.some(e => e.id === id)).toBe(true);
      const worlds = await getKnowledgeEntries(novel.id, { type: 'world' });
      expect(worlds.some(e => e.id === id)).toBe(false);

      // search filter
      const found = await getKnowledgeEntries(novel.id, { search: 'Hero' });
      expect(found.some(e => e.id === id)).toBe(true);
      const notFound = await getKnowledgeEntries(novel.id, { search: 'Villain' });
      expect(notFound.some(e => e.id === id)).toBe(false);

      // getKnowledgeEntry (novelId scoped)
      const fetched = await getKnowledgeEntry(id, novel.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('Hero');
      // wrong novelId → undefined
      expect(await getKnowledgeEntry(id, 'wrong-novel')).toBeUndefined();

      // getKnowledgeEntryById (unscoped)
      const byId = await getKnowledgeEntryById(id);
      expect(byId).toBeDefined();

      // updateKnowledgeEntry
      await updateKnowledgeEntry(id, { title: 'Updated Hero', summary: 'Even braver', updatedAt: now });
      const updated = await getKnowledgeEntryById(id);
      expect(updated!.title).toBe('Updated Hero');
      expect(updated!.summary).toBe('Even braver');

      // deleteKnowledgeEntry
      await deleteKnowledgeEntry(id);
      expect(await getKnowledgeEntryById(id)).toBeUndefined();
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('knowledge entry and relation writes touch novel recency', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createKnowledgeEntry,
      updateKnowledgeEntry,
      deleteKnowledgeEntry,
      createKnowledgeRelation,
      deleteKnowledgeRelation,
      getNovel,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');

    const novel = await createNovel({ userId: USER_ID, title: 'Knowledge Recency', genre: 'test', targetWords: 80000 });
    const stale = '2000-01-01T00:00:00.000Z';
    const now = new Date().toISOString();
    try {
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      const entry = await createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'character',
        title: 'Hero',
        summary: '',
        data: '{}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));

      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      await updateKnowledgeEntry(entry.id, { summary: 'changed', updatedAt: now });
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));

      const target = await createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'character',
        title: 'Target',
        summary: '',
        data: '{}',
        sortOrder: 1,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });

      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      const relation = await createKnowledgeRelation({
        id: crypto.randomUUID(),
        sourceId: entry.id,
        targetId: target.id,
        relationType: 'ally',
        label: 'ally',
        createdAt: now,
      });
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));

      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      await deleteKnowledgeRelation(relation.id);
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));

      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      await deleteKnowledgeEntry(entry.id);
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('knowledge relations: createKnowledgeRelation → getKnowledgeRelationsByEntry → getKnowledgeRelationsByNovel → deleteKnowledgeRelation', async () => {
    const {
      createNovel, deleteNovelCascade,
      createKnowledgeEntry,
      createKnowledgeRelation, getKnowledgeRelationsByEntry, getKnowledgeRelationsByNovel,
      getKnowledgeRelationById, deleteKnowledgeRelation,
    } = await db();

    const novel = await createNovel({ userId: USER_ID, title: 'Rel Novel', genre: 'test', targetWords: 80000 });
    try {
      const now = new Date().toISOString();
      const e1 = await createKnowledgeEntry({ id: crypto.randomUUID(), novelId: novel.id, type: 'character', title: 'E1', summary: '', data: '{}', sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now });
      const e2 = await createKnowledgeEntry({ id: crypto.randomUUID(), novelId: novel.id, type: 'character', title: 'E2', summary: '', data: '{}', sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now });

      const relId = crypto.randomUUID();
      const rel = await createKnowledgeRelation({ id: relId, sourceId: e1.id, targetId: e2.id, relationType: 'ally', label: 'friends', createdAt: now });
      expect(rel.id).toBe(relId);
      expect(rel.source_id).toBe(e1.id);
      expect(rel.target_id).toBe(e2.id);

      // getKnowledgeRelationsByEntry
      const byEntry = await getKnowledgeRelationsByEntry(e1.id);
      expect(byEntry.some(r => r.id === relId)).toBe(true);
      const byTarget = await getKnowledgeRelationsByEntry(e2.id);
      expect(byTarget.some(r => r.id === relId)).toBe(true);

      // getKnowledgeRelationsByNovel
      const byNovel = await getKnowledgeRelationsByNovel(novel.id);
      expect(byNovel.some(r => r.id === relId)).toBe(true);

      const otherNovel = await createNovel({ userId: USER_ID, title: 'Other Rel Novel', genre: 'test', targetWords: 80000 });
      const e3 = await createKnowledgeEntry({ id: crypto.randomUUID(), novelId: otherNovel.id, type: 'character', title: 'E3', summary: '', data: '{}', sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now });
      const crossRelId = crypto.randomUUID();
      await expect(
        createKnowledgeRelation({ id: crossRelId, sourceId: e1.id, targetId: e3.id, relationType: 'leaks', label: 'cross novel', createdAt: now }),
      ).rejects.toThrow(/same novel/);
      const filteredByNovel = await getKnowledgeRelationsByNovel(novel.id);
      expect(filteredByNovel.some(r => r.id === relId)).toBe(true);
      expect(filteredByNovel.some(r => r.id === crossRelId)).toBe(false);
      await deleteNovelCascade(otherNovel.id, USER_ID);

      // getKnowledgeRelationById
      const byId = await getKnowledgeRelationById(relId);
      expect(byId).toBeDefined();

      // deleteKnowledgeRelation
      await deleteKnowledgeRelation(relId);
      expect(await getKnowledgeRelationById(relId)).toBeUndefined();
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

describe('db-local: conversations', () => {
  it('seedNovelData persists conversation rows with the full column set', async () => {
    const { createNovel, deleteNovelCascade, getMessagesForNovel, seedNovelData } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Seed data target', genre: 'test', targetWords: 80000 });
    const now = new Date().toISOString();
    try {
      await seedNovelData([], [{
        id: 'seed-conv-1',
        novel_id: novel.id,
        user_id: USER_ID,
        topic: 'plot',
        title: 'Seeded Conversation',
        parent_message_id: null,
        is_archived: false,
        created_at: now,
        updated_at: now,
      }], [{
        id: 'seed-msg-1',
        novel_id: novel.id,
        role: 'assistant',
        content: 'seeded reply',
        conversation_id: 'seed-conv-1',
        created_at: now,
      }]);

      expect(getDb().prepare('SELECT title FROM conversations WHERE id = ?').get('seed-conv-1')).toEqual({
        title: 'Seeded Conversation',
      });
      expect((await getMessagesForNovel(novel.id)).map(message => message.content)).toEqual(['seeded reply']);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('keeps global interview messages separate from conversation-thread messages', async () => {
    const {
      createConversation,
      createNovel,
      deleteNovelCascade,
      addMessage,
      getMessages,
      getMessagesForNovel,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Message Scope Novel', genre: 'test', targetWords: 80000 });

    try {
      const conversationId = crypto.randomUUID();
      await createConversation({
        id: conversationId,
        novelId: novel.id,
        userId: USER_ID,
        topic: 'plot',
        title: 'Side Conversation',
        parentMessageId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const globalMessage = await addMessage(novel.id, 'user', 'interview-only message');
      const threadMessage = await addMessage(novel.id, 'assistant', 'side conversation message', conversationId);

      expect((await getMessages(novel.id)).map(m => m.id)).toEqual([globalMessage.id]);
      const allMessageIds = (await getMessagesForNovel(novel.id)).map(m => m.id);
      expect(allMessageIds).toHaveLength(2);
      expect(allMessageIds).toEqual(expect.arrayContaining([globalMessage.id, threadMessage.id]));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('createConversation → getConversations → getConversation → updateConversation → deleteConversation', async () => {
    const {
      createNovel, deleteNovelCascade,
      createConversation, getConversations, getConversation, getConversationById,
      updateConversation, deleteConversation, addMessage, getMessagesForNovel,
    } = await db();

    const novel = await createNovel({ userId: USER_ID, title: 'Conv Novel', genre: 'test', targetWords: 80000 });
    try {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const conv = await createConversation({
        id,
        novelId: novel.id,
        userId: USER_ID,
        topic: 'plot',
        title: 'Test Convo',
        parentMessageId: null,
        createdAt: now,
        updatedAt: now,
      });
      expect(conv.id).toBe(id);
      expect(conv.novel_id).toBe(novel.id);
      expect(conv.topic).toBe('plot');
      expect(conv.is_archived).toBe(0);

      // getConversations lists it
      const list = await getConversations(novel.id, USER_ID);
      expect(list.some(c => c.id === id)).toBe(true);
      // different user sees nothing
      const otherList = await getConversations(novel.id, 'other-user');
      expect(otherList.some(c => c.id === id)).toBe(false);

      // getConversation (novelId + userId scoped)
      const fetched = await getConversation(id, novel.id, USER_ID);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('Test Convo');
      // wrong user → undefined
      expect(await getConversation(id, novel.id, 'other-user')).toBeUndefined();

      // getConversationById
      const byId = await getConversationById(id);
      expect(byId).toBeDefined();

      // updateConversation
      await updateConversation(id, novel.id, USER_ID, { title: 'Updated Convo', isArchived: true, updatedAt: now });
      const updated = await getConversationById(id);
      expect(updated!.title).toBe('Updated Convo');
      expect(updated!.is_archived).toBe(1);

      // deleteConversation also removes the conversation's messages
      // (preserves the prior contract — no orphan rows).
      await addMessage(novel.id, 'user', 'in-conversation message', id);
      expect(
        (await getMessagesForNovel(novel.id)).some(m => m.conversation_id === id),
      ).toBe(true);
      await deleteConversation(id, novel.id, USER_ID);
      expect(await getConversationById(id)).toBeUndefined();
      expect(
        (await getMessagesForNovel(novel.id)).some(m => m.conversation_id === id),
      ).toBe(false);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('keeps conversation update and delete scoped to the owning novel', async () => {
    const {
      createNovel, deleteNovelCascade, createConversation, updateConversation,
      deleteConversation, getConversationById, addMessage, getMessagesForNovel,
    } = await db();

    const sourceNovel = await createNovel({ userId: USER_ID, title: 'Conv Source Novel', genre: 'test', targetWords: 80000 });
    const otherNovel = await createNovel({ userId: USER_ID, title: 'Conv Other Novel', genre: 'test', targetWords: 80000 });
    try {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await createConversation({
        id,
        novelId: sourceNovel.id,
        userId: USER_ID,
        topic: 'plot',
        title: 'Source Convo',
        parentMessageId: null,
        createdAt: now,
        updatedAt: now,
      });
      await addMessage(sourceNovel.id, 'user', 'in-conversation message', id);
      await expect(
        addMessage(otherNovel.id, 'user', 'wrong novel message', id),
      ).rejects.toThrow('Conversation not found');
      expect((await getMessagesForNovel(otherNovel.id)).some(m => m.conversation_id === id)).toBe(false);

      await updateConversation(id, otherNovel.id, USER_ID, {
        title: 'Wrong Novel Update',
        isArchived: true,
        updatedAt: now,
      });
      const afterWrongUpdate = await getConversationById(id);
      expect(afterWrongUpdate!.title).toBe('Source Convo');
      expect(afterWrongUpdate!.is_archived).toBe(0);

      await deleteConversation(id, otherNovel.id, USER_ID);
      expect(await getConversationById(id)).toBeDefined();
      expect((await getMessagesForNovel(sourceNovel.id)).some(m => m.conversation_id === id)).toBe(true);
    } finally {
      await deleteNovelCascade(sourceNovel.id, USER_ID);
      await deleteNovelCascade(otherNovel.id, USER_ID);
    }
  });

  it('verifyParentMessageBelongsToNovelLocal requires an attached same-novel conversation message', async () => {
    const {
      createConversation,
      createNovel,
      deleteConversation,
      deleteNovelCascade,
      addMessage,
      verifyParentMessageBelongsToNovelLocal,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'ParentMsg Novel', genre: '', targetWords: 80000 });
    try {
      expect(await verifyParentMessageBelongsToNovelLocal(null, novel.id)).toBe(true);
      expect(await verifyParentMessageBelongsToNovelLocal('nonexistent-id', novel.id)).toBe(false);
      const orphanMsg = await addMessage(novel.id, 'user', 'global message');
      expect(await verifyParentMessageBelongsToNovelLocal(orphanMsg.id, novel.id)).toBe(false);

      const conversationId = crypto.randomUUID();
      await createConversation({
        id: conversationId,
        novelId: novel.id,
        userId: USER_ID,
        topic: 'plot',
        title: 'Parent Conversation',
        parentMessageId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const msg = await addMessage(novel.id, 'user', 'hello', conversationId);
      expect(await verifyParentMessageBelongsToNovelLocal(msg.id, novel.id)).toBe(true);
      expect(await verifyParentMessageBelongsToNovelLocal(msg.id, 'other-novel')).toBe(false);

      await deleteConversation(conversationId, novel.id, USER_ID);
      expect(await verifyParentMessageBelongsToNovelLocal(msg.id, novel.id)).toBe(false);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('addMessage touches conversation recency for list order and context digest selection', async () => {
    const {
      createNovel, deleteNovelCascade,
      createConversation, getConversationById, addMessage,
    } = await db();

    const novel = await createNovel({ userId: USER_ID, title: 'Conv Recency Novel' });
    try {
      const id = crypto.randomUUID();
      await createConversation({
        id,
        novelId: novel.id,
        userId: USER_ID,
        topic: 'plot',
        title: 'Recency Convo',
        parentMessageId: null,
        createdAt: '2000-01-01T00:00:00.000Z',
        updatedAt: '2000-01-01T00:00:00.000Z',
      });

      await addMessage(novel.id, 'assistant', 'fresh context', id);

      const updated = await getConversationById(id);
      expect(updated?.updated_at).not.toBe('2000-01-01T00:00:00.000Z');
      expect(Date.parse(updated!.updated_at)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00.000Z'));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('conversation create/update/delete touches novel recency', async () => {
    const {
      createNovel,
      deleteNovelCascade,
      createConversation,
      updateConversation,
      deleteConversation,
      getNovel,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');

    const novel = await createNovel({ userId: USER_ID, title: 'Conversation Recency Novel' });
    const stale = '2000-01-01T00:00:00.000Z';
    const now = new Date().toISOString();
    try {
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      const id = crypto.randomUUID();
      await createConversation({
        id,
        novelId: novel.id,
        userId: USER_ID,
        topic: 'plot',
        title: 'Recency Convo',
        parentMessageId: null,
        createdAt: now,
        updatedAt: now,
      });
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));

      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      await updateConversation(id, novel.id, USER_ID, {
        title: 'Archived Recency Convo',
        isArchived: true,
        updatedAt: now,
      });
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));

      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      await deleteConversation(id, novel.id, USER_ID);
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

describe('db-local: chapter chat history', () => {
  it('addChatMessagePair persists the edit user turn and assistant reply in order', async () => {
    const { addChatMessagePair, createNovel, deleteNovelCascade, getChatHistory } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Chapter Chat Pair Novel', genre: 'test', targetWords: 80000 });

    try {
      const result = await addChatMessagePair(
        novel.id,
        1,
        { role: 'user', content: 'tighten this paragraph', status: 'done' },
        { role: 'assistant', content: '{"summary":"tightened"}', status: 'done' },
      );

      expect(result.user.id).toBeTruthy();
      expect(result.assistant.id).toBeTruthy();
      const history = await getChatHistory(novel.id, 1);
      expect(history.map(message => ({
        role: message.role,
        content: message.content,
        status: message.status,
      }))).toEqual([
        { role: 'user', content: 'tighten this paragraph', status: 'done' },
        { role: 'assistant', content: '{"summary":"tightened"}', status: 'done' },
      ]);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

describe('db-local: reorderOutlineAtomic', () => {
  it('sets sort_order for outline entries atomically', async () => {
    const {
      createNovel, deleteNovelCascade,
      createKnowledgeEntry, getKnowledgeEntries, reorderOutlineAtomic,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Outline Novel', genre: '', targetWords: 80000 });
    try {
      const now = new Date().toISOString();
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (let i = 0; i < 3; i++) {
        await createKnowledgeEntry({ id: ids[i], novelId: novel.id, type: 'outline', title: `Chapter ${i + 1}`, summary: '', data: '{}', sortOrder: i, tags: '[]', createdAt: now, updatedAt: now });
      }

      // Reorder: [2, 0, 1]
      const newOrder = [ids[2], ids[0], ids[1]];
      await reorderOutlineAtomic(novel.id, newOrder);

      const entries = await getKnowledgeEntries(novel.id, { type: 'outline' });
      const sortedEntries = entries.sort((a, b) => a.sort_order - b.sort_order);
      expect(sortedEntries[0].id).toBe(ids[2]);
      expect(sortedEntries[1].id).toBe(ids[0]);
      expect(sortedEntries[2].id).toBe(ids[1]);

      // Non-outline entries are not affected by reorder (type filter)
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

describe('db-local: migrations', () => {
  it('creates the current knowledge relation uniqueness guard in the baseline schema', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, migrations);
      const now = new Date().toISOString();
      db
        .prepare(
          `INSERT INTO novels (id, user_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('novel-1', USER_ID, 'Current', now, now);
      db
        .prepare(
          `INSERT INTO knowledge_entries
             (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
           VALUES (?, ?, 'character', ?, '', '{}', 0, '[]', ?, ?)`,
        )
        .run('entry-a', 'novel-1', 'A', now, now);
      db
        .prepare(
          `INSERT INTO knowledge_entries
             (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
           VALUES (?, ?, 'character', ?, '', '{}', 1, '[]', ?, ?)`,
        )
        .run('entry-b', 'novel-1', 'B', now, now);
      const insertRelation = db.prepare(
        `INSERT INTO knowledge_relations
           (id, source_id, target_id, relation_type, label, created_at)
         VALUES (?, 'entry-a', 'entry-b', 'knows', '', ?)`,
      );
      insertRelation.run('rel-a', now);
      expect(() => insertRelation.run('rel-b', now)).toThrow('UNIQUE constraint failed');
    } finally {
      db.close();
    }
  });
});

describe('db-local: cooperative writing lock', () => {
  it('acquire succeeds, second acquire fails while live, release then re-acquire succeeds', async () => {
    const { createNovel, acquireWritingLock, releaseWritingLock, renewWritingLock, deleteNovelCascade } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'WL', genre: '', targetWords: 80000 });

    try {
      const first = await acquireWritingLock(novel.id, 300);
      expect(first).not.toBeNull();
      expect(typeof first!.token).toBe('string');
      expect(first!.token.length).toBeGreaterThan(0);
      expect(first!.expiresAt).toBeGreaterThan(Date.now());

      // Second acquire while the first is live & unexpired must fail.
      const second = await acquireWritingLock(novel.id, 300);
      expect(second).toBeNull();

      // Renew with the wrong token must fail (null); right token succeeds.
      expect(await renewWritingLock(novel.id, 'wrong-token', 300)).toBeNull();
      const renewed = await renewWritingLock(novel.id, first!.token, 600);
      expect(typeof renewed).toBe('number');
      expect(renewed!).toBeGreaterThan(Date.now());

      // Releasing with the wrong token must NOT clear the lock.
      await releaseWritingLock(novel.id, 'wrong-token');
      expect(await acquireWritingLock(novel.id, 300)).toBeNull();

      // Release with the correct token, then re-acquire succeeds.
      await releaseWritingLock(novel.id, first!.token);
      const third = await acquireWritingLock(novel.id, 300);
      expect(third).not.toBeNull();
      expect(third!.token).not.toBe(first!.token);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('an expired lock cannot be renewed after a newer owner acquires the row', async () => {
    const { createNovel, acquireWritingLock, renewWritingLock, deleteNovelCascade } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Expired WL', genre: '', targetWords: 80000 });

    try {
      const stale = await acquireWritingLock(novel.id, -1);
      expect(stale).not.toBeNull();

      const current = await acquireWritingLock(novel.id, 300);
      expect(current).not.toBeNull();
      expect(current!.token).not.toBe(stale!.token);

      expect(await renewWritingLock(novel.id, stale!.token, 300)).toBeNull();
      expect(await renewWritingLock(novel.id, current!.token, 300)).not.toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('lock acquire, renew, and release do not change novel recency', async () => {
    const {
      createNovel,
      acquireWritingLock,
      renewWritingLock,
      releaseWritingLock,
      getNovel,
      deleteNovelCascade,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Lock Recency', genre: '', targetWords: 80000 });
    const stale = '2000-01-01T00:00:00.000Z';

    try {
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);

      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      expect((await getNovel(novel.id))!.updatedAt).toBe(Date.parse(stale));

      expect(await renewWritingLock(novel.id, lock!.token, 600)).not.toBeNull();
      expect((await getNovel(novel.id))!.updatedAt).toBe(Date.parse(stale));

      await releaseWritingLock(novel.id, lock!.token);
      expect((await getNovel(novel.id))!.updatedAt).toBe(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

// --- Wave 3 commit 3: chapter snapshots (schema v8) ---

describe('db-local: chapter snapshots', () => {
  it('first snapshot back-fills originalContent + caps list at 10 + restore overwrites content', async () => {
    const {
      createNovel,
      upsertChapter,
      setOriginalContent,
      updateChapterContent,
      createChapterSnapshot,
      listChapterSnapshots,
      restoreChapterSnapshot,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Snaps', genre: '', targetWords: 80000 });
    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'draft v1');
      await setOriginalContent(novel.id, 1, 'AI first draft');
      // After the explicit originalContent + before any manual snapshot,
      // listChapterSnapshots surfaces a synthetic "__original__" entry.
      const pre = await listChapterSnapshots(novel.id, 1);
      expect(pre).toHaveLength(1);
      expect(pre[0]!.id).toBe('__original__');
      expect(pre[0]!.content).toBe('AI first draft');

      // First explicit snapshot folds originalContent in as entry 0, then
      // appends the new snapshot (the chapter's *current* content).
      const first = await createChapterSnapshot(novel.id, 1, 'before tone shift');
      expect(first).not.toBeNull();
      const afterFirst = await listChapterSnapshots(novel.id, 1);
      expect(afterFirst.length).toBe(2);
      // Oldest entry = the back-filled originalContent (empty label → UI
      // renders "First draft").
      expect(afterFirst[0]!.label).toBe('');
      expect(afterFirst[0]!.content).toBe('AI first draft');
      expect(afterFirst[1]!.label).toBe('before tone shift');
      expect(afterFirst[1]!.content).toBe('draft v1');

      // Bump content + make 9 more snapshots so we cross the SNAPSHOT_MAX
      // (10) ceiling. The oldest (the back-fill) must be evicted first.
      let version = (await getChapter(novel.id, 1))!.version;
      for (let i = 0; i < 9; i++) {
        const next = `body iteration ${i}`;
        const w = await updateChapterContent(novel.id, 1, next, version);
        expect(w.conflict).toBe(false);
        version = w.version;
        const s = await createChapterSnapshot(novel.id, 1, `iter-${i}`);
        expect(s).not.toBeNull();
      }
      const capped = await listChapterSnapshots(novel.id, 1);
      expect(capped.length).toBe(10);
      // Back-fill evicted; oldest label is now the first labeled manual snapshot.
      expect(capped[0]!.label).toBe('before tone shift');
      expect(capped[capped.length - 1]!.label).toBe('iter-8');

      // Restore the second-oldest snapshot (label "iter-0", content
      // "body iteration 0") with the correct expected version. Returns the
      // new content + a bumped version.
      const target = capped[1]!;
      const expectedV = (await getChapter(novel.id, 1))!.version;
      const restored = await restoreChapterSnapshot(novel.id, 1, target.id, expectedV);
      expect(restored).not.toBeNull();
      expect(restored!.conflict).toBe(false);
      expect(restored!.content).toBe(target.content);
      const afterRestore = await getChapter(novel.id, 1);
      expect(afterRestore!.content).toBe(target.content);
      expect(afterRestore!.version).toBeGreaterThan(expectedV);

      // Restore with a stale expected version → conflict shape, content
      // unchanged.
      const conflict = await restoreChapterSnapshot(novel.id, 1, target.id, 0);
      expect(conflict).not.toBeNull();
      expect(conflict!.conflict).toBe(true);
      const stillSame = await getChapter(novel.id, 1);
      expect(stillSame!.content).toBe(target.content);

      // Unknown snapshot id → null.
      const missing = await restoreChapterSnapshot(novel.id, 1, 'does-not-exist', stillSame!.version);
      expect(missing).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('restoreChapterSnapshot resolves the synthetic __original__ id even before back-fill', async () => {
    const {
      createNovel,
      upsertChapter,
      setOriginalContent,
      restoreChapterSnapshot,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Orig', genre: '', targetWords: 80000 });
    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'current edits');
      await setOriginalContent(novel.id, 1, 'pristine ai draft');
      const v = (await getChapter(novel.id, 1))!.version;
      const restored = await restoreChapterSnapshot(novel.id, 1, '__original__', v);
      expect(restored).not.toBeNull();
      expect(restored!.conflict).toBe(false);
      expect(restored!.content).toBe('pristine ai draft');
      const after = await getChapter(novel.id, 1);
      expect(after!.content).toBe('pristine ai draft');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('treats an empty originalContent string as a restorable first draft', async () => {
    const {
      createNovel,
      upsertChapter,
      setOriginalContent,
      createChapterSnapshot,
      listChapterSnapshots,
      restoreChapterSnapshot,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Empty Orig', genre: '', targetWords: 80000 });
    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'current edits');
      await setOriginalContent(novel.id, 1, '');

      const pre = await listChapterSnapshots(novel.id, 1);
      expect(pre).toHaveLength(1);
      expect(pre[0]!.id).toBe('__original__');
      expect(pre[0]!.content).toBe('');

      await createChapterSnapshot(novel.id, 1, 'manual');
      const afterSnapshot = await listChapterSnapshots(novel.id, 1);
      expect(afterSnapshot[0]!.content).toBe('');
      expect(afterSnapshot[1]!.content).toBe('current edits');

      const v = (await getChapter(novel.id, 1))!.version;
      const restored = await restoreChapterSnapshot(novel.id, 1, '__original__', v);
      expect(restored).not.toBeNull();
      expect(restored!.conflict).toBe(false);
      expect(restored!.content).toBe('');
      expect((await getChapter(novel.id, 1))!.content).toBe('');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('does not rewrite snapshots or novel recency for duplicate content and label', async () => {
    const {
      createNovel,
      upsertChapter,
      createChapterSnapshot,
      listChapterSnapshots,
      getNovel,
      deleteNovelCascade,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Duplicate Snap', genre: '', targetWords: 80000 });
    const stale = '2000-01-01T00:00:00.000Z';

    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'stable snapshot body');
      const first = await createChapterSnapshot(novel.id, 1, 'stable');
      expect(first).not.toBeNull();
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      const before = await listChapterSnapshots(novel.id, 1);

      const duplicate = await createChapterSnapshot(novel.id, 1, 'stable');

      expect(duplicate).toEqual(first);
      expect(await listChapterSnapshots(novel.id, 1)).toEqual(before);
      expect((await getNovel(novel.id))!.updatedAt).toBe(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('keeps a labeled manual snapshot when current content equals the synthetic first draft', async () => {
    const {
      createNovel,
      upsertChapter,
      setOriginalContent,
      createChapterSnapshot,
      listChapterSnapshots,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Labeled Original Snap', genre: '', targetWords: 80000 });

    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'unchanged first draft');
      await setOriginalContent(novel.id, 1, 'unchanged first draft');

      const manual = await createChapterSnapshot(novel.id, 1, 'approved draft');

      expect(manual).not.toBeNull();
      expect(manual!.label).toBe('approved draft');
      const snapshots = await listChapterSnapshots(novel.id, 1);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]!.content).toBe('unchanged first draft');
      expect(snapshots[1]!.label).toBe('approved draft');
      expect(snapshots[1]!.content).toBe('unchanged first draft');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  // --- QA-3: restore/revert must never silently discard the live draft ---

  it('restore captures the unsnapshotted live draft as a (before restore) safety snapshot', async () => {
    const {
      createNovel,
      upsertChapter,
      updateChapterContent,
      createChapterSnapshot,
      listChapterSnapshots,
      restoreChapterSnapshot,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Safety Restore', genre: '', targetWords: 80000 });
    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'draft A');
      const snapA = await createChapterSnapshot(novel.id, 1, 'snap A'); // captures 'draft A'
      expect(snapA).not.toBeNull();

      // Edit past the snapshot WITHOUT taking a new one — this is the draft at risk.
      const v = (await getChapter(novel.id, 1))!.version;
      await updateChapterContent(novel.id, 1, 'draft B (unsaved live edits)', v);

      const expectedV = (await getChapter(novel.id, 1))!.version;
      const restored = await restoreChapterSnapshot(novel.id, 1, snapA!.id, expectedV);
      expect(restored!.conflict).toBe(false);
      expect(restored!.content).toBe('draft A');
      expect((await getChapter(novel.id, 1))!.content).toBe('draft A');

      const after = await listChapterSnapshots(novel.id, 1);
      const safety = after.find(s => s.label === '(before restore)');
      expect(safety).toBeDefined();
      expect(safety!.content).toBe('draft B (unsaved live edits)');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('revert captures the live draft as a (before revert) safety snapshot before overwriting', async () => {
    const {
      createNovel,
      upsertChapter,
      setOriginalContent,
      updateChapterContent,
      revertChapterToOriginalContent,
      listChapterSnapshots,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Safety Revert', genre: '', targetWords: 80000 });
    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'ai original draft');
      await setOriginalContent(novel.id, 1, 'ai original draft');
      const v = (await getChapter(novel.id, 1))!.version;
      await updateChapterContent(novel.id, 1, 'heavily edited draft', v);

      const expectedV = (await getChapter(novel.id, 1))!.version;
      const reverted = await revertChapterToOriginalContent(novel.id, 1, expectedV);
      expect(reverted!.conflict).toBe(false);
      expect(reverted!.content).toBe('ai original draft');
      expect((await getChapter(novel.id, 1))!.content).toBe('ai original draft');

      const after = await listChapterSnapshots(novel.id, 1);
      const safety = after.find(s => s.label === '(before revert)');
      expect(safety).toBeDefined();
      expect(safety!.content).toBe('heavily edited draft');
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('marks chapter summaries stale when restoring or reverting older content', async () => {
    const {
      createNovel,
      upsertChapter,
      updateChapterContent,
      updateChapterMeta,
      setOriginalContent,
      createChapterSnapshot,
      restoreChapterSnapshot,
      revertChapterToOriginalContent,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Stale Restore Summary', genre: '', targetWords: 80000 });
    const generationMeta = {
      targetWords: 1000,
      actualWords: 3,
      attempts: 1,
      modelId: 'test-model',
      generatedAt: new Date().toISOString(),
    };

    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'snapshot target');
      const snapshot = await createChapterSnapshot(novel.id, 1, 'target');
      let version = (await getChapter(novel.id, 1))!.version;
      await updateChapterContent(novel.id, 1, 'current content with fresh summary', version);
      await updateChapterMeta(novel.id, 1, {
        summary: 'Summary for current content',
        keyFacts: null,
        qualityIssues: null,
        generationMeta,
      });

      version = (await getChapter(novel.id, 1))!.version;
      const restored = await restoreChapterSnapshot(novel.id, 1, snapshot!.id, version);
      expect(restored!.conflict).toBe(false);
      expect((await getChapter(novel.id, 1))!.generationMeta?.summaryStale).toBe(true);

      await upsertChapter(novel.id, 2, 'Ch2', 'original draft');
      await setOriginalContent(novel.id, 2, 'original draft');
      version = (await getChapter(novel.id, 2))!.version;
      await updateChapterContent(novel.id, 2, 'edited draft with fresh summary', version);
      await updateChapterMeta(novel.id, 2, {
        summary: 'Summary for edited draft',
        keyFacts: null,
        qualityIssues: null,
        generationMeta,
      });

      version = (await getChapter(novel.id, 2))!.version;
      const reverted = await revertChapterToOriginalContent(novel.id, 2, version);
      expect(reverted!.conflict).toBe(false);
      expect((await getChapter(novel.id, 2))!.generationMeta?.summaryStale).toBe(true);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('eviction never drops the safety snapshot when the list is already at SNAPSHOT_MAX', async () => {
    const {
      createNovel,
      upsertChapter,
      updateChapterContent,
      createChapterSnapshot,
      listChapterSnapshots,
      restoreChapterSnapshot,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Safety Evict', genre: '', targetWords: 80000 });
    try {
      // Fill exactly SNAPSHOT_MAX (10) distinct snapshots: s0..s9 with content v0..v9.
      await upsertChapter(novel.id, 1, 'Ch1', 'v0');
      await createChapterSnapshot(novel.id, 1, 's0');
      let version = (await getChapter(novel.id, 1))!.version;
      for (let i = 1; i < 10; i++) {
        const w = await updateChapterContent(novel.id, 1, `v${i}`, version);
        version = w.version;
        await createChapterSnapshot(novel.id, 1, `s${i}`);
      }
      expect(await listChapterSnapshots(novel.id, 1)).toHaveLength(10);

      // Distinct, unsnapshotted live edit, then restore an old snapshot.
      const w = await updateChapterContent(novel.id, 1, 'LIVE-UNSNAPSHOTTED', version);
      version = w.version;
      const list = await listChapterSnapshots(novel.id, 1);
      const target = list.find(s => s.label === 's5')!;
      const restored = await restoreChapterSnapshot(novel.id, 1, target.id, version);
      expect(restored!.conflict).toBe(false);
      expect(restored!.content).toBe('v5');

      const capped = await listChapterSnapshots(novel.id, 1);
      expect(capped).toHaveLength(10); // still capped
      // Safety snapshot lives at the tail and survived front-eviction.
      expect(capped[capped.length - 1]!.label).toBe('(before restore)');
      expect(capped[capped.length - 1]!.content).toBe('LIVE-UNSNAPSHOTTED');
      // The oldest (s0/v0) was evicted to make room.
      expect(capped.some(s => s.label === 's0')).toBe(false);
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('leaves no safety snapshot when the restore hits a version conflict', async () => {
    const {
      createNovel,
      upsertChapter,
      updateChapterContent,
      createChapterSnapshot,
      listChapterSnapshots,
      restoreChapterSnapshot,
      getChapter,
      deleteNovelCascade,
    } = await db();
    const novel = await createNovel({ userId: USER_ID, title: 'Safety Conflict', genre: '', targetWords: 80000 });
    try {
      await upsertChapter(novel.id, 1, 'Ch1', 'draft A');
      const snapA = await createChapterSnapshot(novel.id, 1, 'snap A');
      const v = (await getChapter(novel.id, 1))!.version;
      await updateChapterContent(novel.id, 1, 'draft B', v);

      const before = await listChapterSnapshots(novel.id, 1);
      const conflict = await restoreChapterSnapshot(novel.id, 1, snapA!.id, 0); // stale version
      expect(conflict!.conflict).toBe(true);

      const after = await listChapterSnapshots(novel.id, 1);
      expect(after).toHaveLength(before.length); // no safety snapshot written
      expect(after.some(s => s.label === '(before restore)')).toBe(false);
      expect((await getChapter(novel.id, 1))!.content).toBe('draft B'); // unchanged
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});

describe('db-local: chapter writes touch novel recency', () => {
  it('bumps novel.updated_at when chapter content changes', async () => {
    const {
      createNovel,
      getChapter,
      upsertChapter,
      updateChapterContent,
      getNovel,
      deleteNovelCascade,
    } = await db();
    const { getDb } = await import('@/lib/db/connection');
    const novel = await createNovel({ userId: USER_ID, title: 'Chapter Recency', genre: '', targetWords: 80000 });
    const stale = '2000-01-01T00:00:00.000Z';
    try {
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);

      await upsertChapter(novel.id, 1, 'Ch1', 'draft v1');
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));

      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      const chapter = await getChapter(novel.id, 1);
      const result = await updateChapterContent(novel.id, 1, 'draft v2', chapter!.version);
      expect(result.conflict).toBe(false);
      expect((await getNovel(novel.id))!.updatedAt).toBeGreaterThan(Date.parse(stale));
    } finally {
      await deleteNovelCascade(novel.id, USER_ID);
    }
  });
});
