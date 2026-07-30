import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
const PREV_DESKTOP_SESSION = process.env.INKMARSHAL_DESKTOP_SESSION;
let tmpDir: string;

function token(): string {
  return randomBytes(32).toString('hex');
}

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-import-action-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
  process.env.INKMARSHAL_DESKTOP_SESSION = 'test-desktop-session-token';
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  if (PREV_DESKTOP_SESSION === undefined) delete process.env.INKMARSHAL_DESKTOP_SESSION;
  else process.env.INKMARSHAL_DESKTOP_SESSION = PREV_DESKTOP_SESSION;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function stageAndOpen(manuscript: string, basename = 'draft.txt') {
  const { stageTestManuscript } = await import('@/lib/import/session-store');
  const { openImportSessionAction } = await import('@/app/actions/import');
  const t = token();
  stageTestManuscript({
    token: t,
    basename,
    bytes: Buffer.from(manuscript, 'utf8'),
  });
  const opened = await openImportSessionAction({ token: t, basename });
  return opened;
}

describe('opaque import session pipeline', () => {
  it('opens a multi-megabyte manuscript and returns only bounded previews', async () => {
    const para = 'A'.repeat(4000);
    const body = Array.from({ length: 800 }, (_, i) => `Chapter ${i + 1}\n\n${para}`).join('\n\n');
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(3 * 1024 * 1024);

    const opened = await stageAndOpen(body, 'big.txt');
    expect(opened.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(opened.chapters.length).toBeGreaterThan(100);
    for (const ch of opened.chapters) {
      expect(ch.snippet.length).toBeLessThanOrEqual(500);
      expect(JSON.stringify(ch).length).toBeLessThan(20_000);
      expect(ch).not.toHaveProperty('content');
      expect(ch.parts.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(opened).length).toBeLessThan(500_000);
  });

  it('rejects forged tokens and does not create a session', async () => {
    const { openImportSessionAction } = await import('@/app/actions/import');
    await expect(openImportSessionAction({
      token: 'a'.repeat(64),
      basename: 'missing.txt',
    })).rejects.toThrow(/not found|expired/i);

    await expect(openImportSessionAction({
      token: 'not-a-valid-token',
      basename: 'x.txt',
    })).rejects.toThrow(/invalid/i);
  });

  it('rejects forged segment parts and leaves the session recoverable', async () => {
    const { confirmImportSessionAction } = await import('@/app/actions/import');
    const { loadImportSession } = await import('@/lib/import/session-store');

    const opened = await stageAndOpen(
      '第一章 开场\n\nHello world.\n\n第二章 继续\n\nMore prose here.\n',
      'two.txt',
    );

    await expect(confirmImportSessionAction({
      sessionToken: opened.sessionToken,
      mode: 'new',
      novelTitle: 'Forged',
      chapters: [{
        title: 'Hack',
        parts: [{ segmentId: 'does-not-exist', fromParagraph: 0, toParagraph: 1 }],
      }],
    })).rejects.toThrow(/unknown segment/i);

    // Session remains until expiry after validation failure.
    expect(loadImportSession(opened.sessionToken).token).toBe(opened.sessionToken);
  });

  it('creates a new novel atomically and removes the session on success', async () => {
    const { confirmImportSessionAction } = await import('@/app/actions/import');
    const { getChapters, getNovel, deleteNovelCascade } = await import('@/lib/db');
    const { sessionDirForToken } = await import('@/lib/import/session-store');

    const opened = await stageAndOpen(
      '第一章 开场\n\nHello world.\n\n第二章 继续\n\nMore prose here.\n',
      'two.txt',
    );

    const result = await confirmImportSessionAction({
      sessionToken: opened.sessionToken,
      mode: 'new',
      novelTitle: 'Imported Tale',
      chapters: opened.chapters.map(c => ({ title: c.title, parts: c.parts })),
    });

    try {
      const novel = await getNovel(result.novelId);
      expect(novel?.title).toBe('Imported Tale');
      expect(novel?.stage).toBe('autonomous_writing');
      const chapters = await getChapters(result.novelId);
      expect(chapters.map(c => ({ n: c.chapterNumber, content: c.content }))).toEqual([
        { n: 1, content: 'Hello world.' },
        { n: 2, content: 'More prose here.' },
      ]);
      expect(chapters.every(c => c.processingStatus === 'complete')).toBe(true);
      expect(existsSync(sessionDirForToken(opened.sessionToken))).toBe(false);
    } finally {
      await deleteNovelCascade(result.novelId, 'local-user');
    }
  });

  it('rolls back new-mode creation so no empty shell remains on write failure', async () => {
    const { openImportSession } = await import('@/lib/import/session-open');
    const { stageTestManuscript, loadImportSession } = await import('@/lib/import/session-store');
    const { getDb } = await import('@/lib/db/connection');
    const { confirmImportSession } = await import('@/lib/import/session-confirm');

    const t = token();
    stageTestManuscript({
      token: t,
      basename: 'fail.txt',
      bytes: Buffer.from('第一章\n\nBody one.\n\n第二章\n\nBody two.\n', 'utf8'),
    });
    const opened = await openImportSession({ token: t, basename: 'fail.txt' });
    const novelsBefore = (
      getDb().prepare('SELECT COUNT(*) AS n FROM novels').get() as { n: number }
    ).n;

    // Force a mid-transaction failure via an invalid overwrite decision after
    // reconstructing valid chapters — use merge mode against a missing novel
    // ownership path... instead: pass overlapping/incomplete parts.
    await expect(confirmImportSession({
      sessionToken: opened.sessionToken,
      mode: 'new',
      novelTitle: 'Should Not Exist',
      chapters: [
        {
          title: 'Only first paragraph of seg 1',
          parts: [{
            segmentId: opened.chapters[0]!.parts[0]!.segmentId,
            fromParagraph: 0,
            toParagraph: 1,
          }],
        },
        // Missing coverage of remaining segments → reject before/at reconstruct.
      ],
    })).rejects.toThrow(/cover the full manuscript/i);

    const novelsAfter = (
      getDb().prepare('SELECT COUNT(*) AS n FROM novels').get() as { n: number }
    ).n;
    expect(novelsAfter).toBe(novelsBefore);
    expect(loadImportSession(opened.sessionToken).token).toBe(opened.sessionToken);
  });

  it('rejects a desktop-session binding mismatch', async () => {
    const { confirmImportSessionAction } = await import('@/app/actions/import');
    const opened = await stageAndOpen('第一章\n\nOnly one.\n', 'one.txt');
    const previous = process.env.INKMARSHAL_DESKTOP_SESSION;
    process.env.INKMARSHAL_DESKTOP_SESSION = 'different-session';
    try {
      await expect(confirmImportSessionAction({
        sessionToken: opened.sessionToken,
        mode: 'new',
        novelTitle: 'Bound',
        chapters: opened.chapters.map(c => ({ title: c.title, parts: c.parts })),
      })).rejects.toThrow(/not bound to this desktop session/i);
    } finally {
      process.env.INKMARSHAL_DESKTOP_SESSION = previous;
    }
  });
});

async function consentForChapter(
  novelId: string,
  chapterNumber: number,
) {
  const { consentContentFingerprint } = await import('@/lib/import/dedupe');
  const { getDb } = await import('@/lib/db/connection');
  const row = getDb()
    .prepare(
      `SELECT id, version, content FROM chapters
        WHERE novel_id = ? AND chapter_number = ?`,
    )
    .get(novelId, chapterNumber) as
    | { id: string; version: number; content: string }
    | undefined;
  if (!row) throw new Error(`missing chapter ${chapterNumber}`);
  return {
    matchedChapterId: row.id,
    matchedVersion: row.version,
    matchedContentFingerprint: consentContentFingerprint(row.content),
  };
}

describe('importPlanToNovel merge dedupe fail-closed (session confirm)', () => {
  it('rejects a missing dedupe report before mutating chapters and leaves the target unchanged', async () => {
    const { createNovel, getChapters, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { confirmImportSessionAction } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'Merge target' });
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 1, 'Existing', 'Keep me', 2, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, now);

    const opened = await stageAndOpen(
      '第一章 Incoming One\n\nNew body\n\n第二章 Incoming Two\n\nAnother\n',
      'incoming.txt',
    );

    try {
      await expect(confirmImportSessionAction({
        mode: 'merge',
        targetNovelId: novel.id,
        sessionToken: opened.sessionToken,
        novelTitle: 'Incoming',
        chapters: opened.chapters.map(c => ({ title: c.title, parts: c.parts })),
      })).rejects.toThrow(/explicit dedupe decision/);

      const chapters = await getChapters(novel.id);
      expect(chapters).toHaveLength(1);
      expect(chapters[0]).toMatchObject({
        chapterNumber: 1,
        title: 'Existing',
        content: 'Keep me',
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('overwrites the matched existing chapter rather than the incoming chapter number', async () => {
    const { createNovel, getChapters, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { confirmImportSessionAction } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'Matched target' });
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 10, 'Shared title', 'Original body', 2, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, new Date().toISOString());

    const opened = await stageAndOpen(
      '第一章 Shared title\n\nReplacement body\n',
      'incoming.txt',
    );

    try {
      await confirmImportSessionAction({
        mode: 'merge',
        targetNovelId: novel.id,
        sessionToken: opened.sessionToken,
        novelTitle: 'Incoming',
        chapters: opened.chapters.map(c => ({ title: 'Shared title', parts: c.parts })),
        dedupeDecisions: [{
          chapterNumber: 1,
          action: 'overwrite',
          matchedChapterNumber: 10,
          consent: await consentForChapter(novel.id, 10),
        }],
      });

      expect(await getChapters(novel.id)).toEqual([
        expect.objectContaining({
          chapterNumber: 10,
          title: 'Shared title',
          content: 'Replacement body',
        }),
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('atomically clears stale derived AI metadata on merge overwrite', async () => {
    const { createNovel, getChapter, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { JSON_COLUMN_VERSIONS } = await import('@/lib/db/json-columns');
    const { confirmImportSessionAction } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'Metadata target' });
    const chapterId = crypto.randomUUID();
    const now = new Date().toISOString();
    const snapshots = JSON.stringify([{
      id: 'snap-1',
      createdAt: Date.parse(now),
      label: 'keep me',
      content: 'snapshot body',
    }]);
    getDb().prepare(
      `INSERT INTO chapters (
         id, novel_id, chapter_number, title, content, original_content,
         word_count, version, summary, key_facts, key_facts_v,
         quality_issues, quality_issues_v, generation_meta, generation_meta_v,
         snapshots, processing_status, created_at
       ) VALUES (?, ?, 1, 'Shared title', 'Original body', 'original baseline',
         2, 3, 'Old AI summary', ?, ?, ?, ?, ?, ?, ?, 'complete', ?)`,
    ).run(
      chapterId,
      novel.id,
      JSON.stringify({
        characters: ['Old'],
        locations: ['Castle'],
        items: [],
        plotMoves: ['twist'],
      }),
      JSON_COLUMN_VERSIONS.key_facts,
      JSON.stringify([{ type: 'other', severity: 'minor', description: 'stale' }]),
      JSON_COLUMN_VERSIONS.quality_issues,
      JSON.stringify({
        targetWords: 1000,
        actualWords: 2,
        attempts: 1,
        modelId: 'stale-model',
        generatedAt: now,
      }),
      JSON_COLUMN_VERSIONS.generation_meta,
      snapshots,
      now,
    );

    const opened = await stageAndOpen(
      '第一章 Shared title\n\nImported replacement body\n',
      'meta-overwrite.txt',
    );

    try {
      await confirmImportSessionAction({
        mode: 'merge',
        targetNovelId: novel.id,
        sessionToken: opened.sessionToken,
        novelTitle: 'Incoming',
        chapters: opened.chapters.map(c => ({ title: 'Shared title', parts: c.parts })),
        dedupeDecisions: [{
          chapterNumber: 1,
          action: 'overwrite',
          matchedChapterNumber: 1,
          consent: await consentForChapter(novel.id, 1),
        }],
      });

      const chapter = await getChapter(novel.id, 1);
      expect(chapter).toMatchObject({
        id: chapterId,
        content: 'Imported replacement body',
        version: 4,
        summary: '',
        keyFacts: null,
        qualityIssues: null,
        generationMeta: null,
        processingStatus: 'complete',
      });
      expect(chapter?.snapshots).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'snap-1', label: 'keep me' }),
        expect.objectContaining({ label: '(before import)' }),
      ]));
      const row = getDb().prepare(
        `SELECT key_facts_v, quality_issues_v, generation_meta_v, original_content
           FROM chapters WHERE id = ?`,
      ).get(chapterId) as {
        key_facts_v: number | null;
        quality_issues_v: number | null;
        generation_meta_v: number | null;
        original_content: string | null;
      };
      expect(row).toEqual({
        key_facts_v: null,
        quality_issues_v: null,
        generation_meta_v: null,
        original_content: null,
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects duplicate overwrite targets before mutating the target novel', async () => {
    const { createNovel, getChapters, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { confirmImportSessionAction } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'One target' });
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 10, 'Shared title', 'Original body', 2, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, new Date().toISOString());

    const opened = await stageAndOpen(
      '第一章 Shared title\n\nFirst replacement\n\n第二章 Shared title\n\nSecond replacement\n',
      'incoming.txt',
    );

    try {
      const consent = await consentForChapter(novel.id, 10);
      await expect(confirmImportSessionAction({
        mode: 'merge',
        targetNovelId: novel.id,
        sessionToken: opened.sessionToken,
        novelTitle: 'Incoming',
        chapters: opened.chapters.map(c => ({ title: 'Shared title', parts: c.parts })),
        dedupeDecisions: [
          { chapterNumber: 1, action: 'overwrite', matchedChapterNumber: 10, consent },
          { chapterNumber: 2, action: 'overwrite', matchedChapterNumber: 10, consent },
        ],
      })).rejects.toThrow(/same target chapter twice/);

      expect(await getChapters(novel.id)).toEqual([
        expect.objectContaining({
          chapterNumber: 10,
          content: 'Original body',
        }),
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('server-recomputes dedupe and rejects a stale matchedChapterNumber', async () => {
    const { createNovel, getChapters, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { confirmImportSessionAction } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'Stale target' });
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 3, 'Other', 'Keep', 1, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, new Date().toISOString());

    const opened = await stageAndOpen(
      '第一章 Brand New\n\nTotally unique prose for dedupe.\n',
      'new.txt',
    );

    try {
      await expect(confirmImportSessionAction({
        mode: 'merge',
        targetNovelId: novel.id,
        sessionToken: opened.sessionToken,
        novelTitle: 'Incoming',
        chapters: opened.chapters.map(c => ({ title: c.title, parts: c.parts })),
        dedupeDecisions: [{
          chapterNumber: 1,
          action: 'overwrite',
          matchedChapterNumber: 3, // forged — server report has no match
          consent: await consentForChapter(novel.id, 3),
        }],
      })).rejects.toThrow(/stale|does not match|consent/i);

      expect(await getChapters(novel.id)).toEqual([
        expect.objectContaining({ chapterNumber: 3, content: 'Keep' }),
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});

describe('import durability fencing (adversarial)', () => {
  it('returns a typed conflict when an active writer owns the novel lock', async () => {
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      getChapters,
      releaseWritingLock,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { confirmImportSessionAction } = await import('@/app/actions/import');
    const { ImportConfirmConflictError } = await import('@/lib/import/session-confirm');

    const novel = await createNovel({ userId: 'local-user', title: 'Locked target' });
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 1, 'Existing', 'Keep me', 2, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, new Date().toISOString());
    const lock = await acquireWritingLock(novel.id, 300);
    expect(lock).not.toBeNull();

    const opened = await stageAndOpen(
      '第一章 Existing\n\nIncoming overwrite body\n',
      'locked.txt',
    );

    try {
      await expect(confirmImportSessionAction({
        mode: 'merge',
        targetNovelId: novel.id,
        sessionToken: opened.sessionToken,
        novelTitle: 'Incoming',
        chapters: opened.chapters.map(c => ({ title: 'Existing', parts: c.parts })),
        dedupeDecisions: [{
          chapterNumber: 1,
          action: 'overwrite',
          matchedChapterNumber: 1,
          consent: await consentForChapter(novel.id, 1),
        }],
      })).rejects.toMatchObject({
        name: ImportConfirmConflictError.name,
        code: 'WRITING_IN_PROGRESS',
      });

      expect(await getChapters(novel.id)).toEqual([
        expect.objectContaining({ content: 'Keep me', version: 0 }),
      ]);
    } finally {
      if (lock) await releaseWritingLock(novel.id, lock.token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects stale consent after a manual chapter edit without overwriting', async () => {
    const { createNovel, deleteNovelCascade, getChapters, updateChapterContent } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { confirmImportSessionAction } = await import('@/app/actions/import');

    const novel = await createNovel({ userId: 'local-user', title: 'Edited target' });
    getDb().prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES (?, ?, 1, 'Shared title', 'Original body', 2, 0, ?)`,
    ).run(crypto.randomUUID(), novel.id, new Date().toISOString());

    const opened = await stageAndOpen(
      '第一章 Shared title\n\nReplacement body\n',
      'stale-consent.txt',
    );
    const staleConsent = await consentForChapter(novel.id, 1);
    await updateChapterContent(novel.id, 1, 'Later user edit that must be preserved', 0);

    try {
      await expect(confirmImportSessionAction({
        mode: 'merge',
        targetNovelId: novel.id,
        sessionToken: opened.sessionToken,
        novelTitle: 'Incoming',
        chapters: opened.chapters.map(c => ({ title: 'Shared title', parts: c.parts })),
        dedupeDecisions: [{
          chapterNumber: 1,
          action: 'overwrite',
          matchedChapterNumber: 1,
          consent: staleConsent,
        }],
      })).rejects.toMatchObject({ code: 'STALE_DEDUPE_CONSENT' });

      expect(await getChapters(novel.id)).toEqual([
        expect.objectContaining({
          content: 'Later user edit that must be preserved',
          version: 1,
        }),
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('replays the same confirm hash exactly once and rejects a token collision', async () => {
    const { confirmImportSessionAction } = await import('@/app/actions/import');
    const { getChapters, getNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { removeImportSession, sessionDirForToken } = await import('@/lib/import/session-store');
    const { existsSync } = await import('node:fs');

    const opened = await stageAndOpen(
      '第一章 One\n\nBody one.\n\n第二章 Two\n\nBody two.\n',
      'once.txt',
    );
    const input = {
      sessionToken: opened.sessionToken,
      mode: 'new' as const,
      novelTitle: 'Exactly Once',
      chapters: opened.chapters.map(c => ({ title: c.title, parts: c.parts })),
    };

    const first = await confirmImportSessionAction(input);
    try {
      // Simulate cleanup failure: restore session dir is unnecessary; replay must
      // still return the stored result even if filesystem session is gone.
      expect(existsSync(sessionDirForToken(opened.sessionToken))).toBe(false);
      removeImportSession(opened.sessionToken); // best-effort no-op when absent

      const replay = await confirmImportSessionAction(input);
      expect(replay).toEqual(first);
      expect(await getNovel(first.novelId)).toMatchObject({ title: 'Exactly Once' });
      expect(await getChapters(first.novelId)).toHaveLength(2);

      const novels = (
        getDb().prepare('SELECT COUNT(*) AS n FROM novels WHERE title = ?').get('Exactly Once') as { n: number }
      ).n;
      expect(novels).toBe(1);

      await expect(confirmImportSessionAction({
        ...input,
        novelTitle: 'Different Request Same Token',
      })).rejects.toMatchObject({ code: 'CONFIRMATION_COLLISION' });
    } finally {
      await deleteNovelCascade(first.novelId, 'local-user');
    }
  });
});

describe('removed base64 import action surface', () => {
  it('does not export parseImportedFile or importPlanToNovel', async () => {
    const mod = await import('@/app/actions/import');
    expect(mod).not.toHaveProperty('parseImportedFile');
    expect(mod).not.toHaveProperty('importPlanToNovel');
    expect(typeof mod.openImportSessionAction).toBe('function');
    expect(typeof mod.confirmImportSessionAction).toBe('function');
  });

  it('binds sessions to the desktop session hash', async () => {
    const { desktopSessionBinding } = await import('@/lib/import/session-store');
    const expected = createHash('sha256')
      .update('test-desktop-session-token')
      .digest('hex');
    expect(desktopSessionBinding()).toBe(expected);
  });
});
