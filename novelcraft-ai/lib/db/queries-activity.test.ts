// W1-1 command-center activity stream. Real SQLite (schema 0013) via the
// temp-DATA_DIR + getDb pattern, mirroring queries-writing-jobs.test.ts.
//
// Covers the full contract the command center relies on: the three-source word
// split (ai / human / accepted), negative human deltas, the streak, the daily
// series zero-fill, the today split, the activity timeline, and the
// Weekly Progressed Projects north-star count. Drives the REAL wired emitters
// where they exist (upsertChapter → ai, updateChapterContent → human,
// applyAndPersistUnificationEdits → accepted) so the test exercises the same
// code path production does, not a hand-rolled stand-in.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_ID } from '@/lib/local-user';
import { localDayKey } from '@/lib/activity-types';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-activity-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  return {
    activity: await import('@/lib/db/queries-activity'),
    db: await import('@/lib/db'),
    connection: await import('@/lib/db/connection'),
    unification: await import('@/lib/whole-book-unification'),
  };
}

async function freshNovel(title = 'Activity'): Promise<string> {
  const { db } = await mods();
  const novel = await db.createNovel({ userId: LOCAL_USER_ID, title });
  return novel.id;
}

function todayKey(): string {
  return localDayKey(new Date());
}

describe('queries-activity', () => {
  it('upsertChapter records an ai chapter_written event with the content word delta', async () => {
    const { db, activity } = await mods();
    const novelId = await freshNovel();
    const content = 'one two three four five six seven eight';
    await db.upsertChapter(novelId, 1, 'Chapter One', content);

    const series = activity.getDailyWordSeries(novelId, 7);
    const today = series[series.length - 1];
    expect(today.ai).toBe(8); // 8 whitespace-delimited tokens
    expect(today.human).toBe(0);
    expect(today.accepted).toBe(0);
    expect(today.total).toBe(8);

    const split = activity.getTodayWordSplit(novelId);
    expect(split.ai).toBe(8);
    expect(split.total).toBe(8);

    const timeline = activity.getActivityTimeline(novelId);
    expect(timeline[0]?.type).toBe('chapter_written');
    expect(timeline[0]?.source).toBe('ai');
    expect(timeline[0]?.chapterNumber).toBe(1);
  });

  it('a re-generation of the same chapter records the NET ai delta, not the full length', async () => {
    const { db, activity } = await mods();
    const novelId = await freshNovel();
    await db.upsertChapter(novelId, 1, 'C1', 'alpha beta gamma'); // +3
    await db.upsertChapter(novelId, 1, 'C1', 'alpha beta gamma delta epsilon'); // net +2

    const split = activity.getTodayWordSplit(novelId);
    expect(split.ai).toBe(5); // 3 + 2, never 3 + 5
  });

  it('updateChapterContent records human edits, and a deletion carries a negative delta', async () => {
    const { db, activity, connection } = await mods();
    const novelId = await freshNovel();
    await db.upsertChapter(novelId, 1, 'C1', 'one two three four five'); // ai +5

    // Human grows the chapter: +3 human words.
    await db.updateChapterContent(novelId, 1, 'one two three four five six seven eight');
    // Human deletes back down: net negative human delta.
    await db.updateChapterContent(novelId, 1, 'one two');

    // The series clamps negatives per-bucket, so the visible human total is the
    // positive contribution only (the +3 growth), never a negative bar.
    const split = activity.getTodayWordSplit(novelId);
    expect(split.human).toBe(3);

    // But the RAW event stream must contain the negative delta (the clamp is a
    // presentation concern, not a storage one).
    const db2 = connection.getDb();
    const rows = db2
      .prepare(
        `SELECT words_delta FROM activity_events
          WHERE novel_id = ? AND type = 'chapter_edited' AND source = 'human'
          ORDER BY created_at ASC`,
      )
      .all(novelId) as { words_delta: number }[];
    expect(rows.map(r => r.words_delta)).toContain(3);
    expect(rows.some(r => r.words_delta < 0)).toBe(true);
  });

  it('applying a unification edit records an accepted unification_applied event', async () => {
    const { db, activity, unification } = await mods();
    const novelId = await freshNovel();
    await db.upsertChapter(novelId, 1, 'C1', 'The hero walked into the dark room.');

    const report = {
      edits: [
        {
          id: 'edit-1',
          chapterNumber: 1,
          original: 'dark room',
          replacement: 'shadowed antechamber beyond',
          rationale: 'consistency',
          severity: 'minor' as const,
          applied: false,
        },
      ],
      summary: 'one fix',
      generatedAt: new Date().toISOString(),
      modelId: 'test-model',
    };
    // Persist the report so the apply path reads it back from the novel row.
    await db.updateNovel(novelId, { unificationReport: report });

    const res = unification.applyAndPersistUnificationEdits({
      novelId,
      report,
      applyAll: true,
    });
    expect(res.results.some(r => r.status === 'applied')).toBe(true);

    const split = activity.getTodayWordSplit(novelId);
    // 'dark room' (2) → 'shadowed antechamber beyond' (3): net +1 accepted word.
    expect(split.accepted).toBe(1);

    const timeline = activity.getActivityTimeline(novelId);
    const acceptedEvent = timeline.find(e => e.type === 'unification_applied');
    expect(acceptedEvent?.source).toBe('accepted');
  });

  it('recordActivityEvent writes a status_changed event in the caller transaction', async () => {
    const { activity, connection } = await mods();
    const novelId = await freshNovel();
    const db = connection.getDb();

    db.transaction(() => {
      activity.recordActivityEvent(db, {
        novelId,
        type: 'status_changed',
        source: 'human',
        meta: { from: null, to: 'drafting' },
      });
    })();

    const timeline = activity.getActivityTimeline(novelId);
    expect(timeline[0]?.type).toBe('status_changed');
    expect(timeline[0]?.source).toBe('human');
    expect(timeline[0]?.meta).toMatchObject({ to: 'drafting' });
    // status_changed has no words, so it must not move the word rings.
    expect(activity.getTodayWordSplit(novelId).total).toBe(0);
  });

  it('getDailyWordSeries zero-fills missing days and keeps a stable 7-day window', async () => {
    const { db, activity } = await mods();
    const novelId = await freshNovel();
    await db.upsertChapter(novelId, 1, 'C1', 'only today words here');

    const series = activity.getDailyWordSeries(novelId, 7);
    expect(series).toHaveLength(7);
    expect(series[series.length - 1].dayKey).toBe(todayKey());
    // Earlier days are zero-filled (no events were dated to them).
    expect(series.slice(0, 6).every(p => p.total === 0)).toBe(true);
  });

  it('getWritingStreak counts consecutive active days and tolerates "not today yet"', async () => {
    const { activity, connection } = await mods();
    const novelId = await freshNovel();
    const db = connection.getDb();

    const daysAgo = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return d;
    };
    // Active yesterday + the day before, but NOT today: grace keeps the streak.
    activity.recordActivityEvent(db, {
      novelId, type: 'chapter_written', source: 'ai', wordsDelta: 10, at: daysAgo(1),
    });
    activity.recordActivityEvent(db, {
      novelId, type: 'chapter_written', source: 'ai', wordsDelta: 10, at: daysAgo(2),
    });
    expect(activity.getWritingStreak(novelId)).toBe(2);

    // A gap breaks it: an event 5 days ago does not extend the current run.
    activity.recordActivityEvent(db, {
      novelId, type: 'chapter_written', source: 'ai', wordsDelta: 10, at: daysAgo(5),
    });
    expect(activity.getWritingStreak(novelId)).toBe(2);
  });

  it('getWeeklyProgressedProjects counts distinct novels with an effective advance in 7 days', async () => {
    const { db, activity, connection } = await mods();
    const baseline = activity.getWeeklyProgressedProjects();

    // Novel A: an AI write counts (chapter_written is an effective advance).
    const a = await freshNovel('weekly-A');
    await db.upsertChapter(a, 1, 'C1', 'some fresh words for project a');

    // Novel B: a status change counts too.
    const b = await freshNovel('weekly-B');
    const dbHandle = connection.getDb();
    activity.recordActivityEvent(dbHandle, {
      novelId: b, type: 'status_changed', source: 'human', meta: { to: 'drafting' },
    });

    // Novel C: a PURE ai chapter_edited with words_delta=0 must NOT count.
    const c = await freshNovel('weekly-C');
    activity.recordActivityEvent(dbHandle, {
      novelId: c, type: 'chapter_edited', source: 'human', wordsDelta: 0,
    });

    const after = activity.getWeeklyProgressedProjects();
    // A and B advanced; C did not. (baseline absorbs novels created by earlier
    // tests in this file that also recorded advances.)
    expect(after).toBe(baseline + 2);
  });

  it('an export_completed event counts toward the north star without adding words', async () => {
    const { activity, connection } = await mods();
    const novelId = await freshNovel('export-novel');
    const db = connection.getDb();
    const before = activity.getWeeklyProgressedProjects();

    activity.recordActivityEvent(db, {
      novelId, type: 'export_completed', source: 'human', wordsDelta: 0, meta: { format: 'epub' },
    });

    expect(activity.getWeeklyProgressedProjects()).toBe(before + 1);
    expect(activity.getTodayWordSplit(novelId).total).toBe(0);
  });
});
