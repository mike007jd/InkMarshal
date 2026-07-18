// Reads/writes for the append-only activity stream (activity_events, 0013).
// recordActivityEvent is the single write primitive — it MUST be handed a db
// handle so the event lands in the SAME transaction as the content write that
// produced it (atomic consistency). The getters power the command center
// dashboard and the Weekly Progressed Projects north-star metric.

import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db/connection';
import { nowIso } from '@/lib/utils';
import {
  localDayKey,
  mapActivityEvent,
  PROGRESS_EVENT_TYPES,
  type ActivityEvent,
  type ActivityEventRow,
  type ActivitySource,
  type ActivityType,
} from '@/lib/activity-types';

export interface RecordActivityEventInput {
  novelId: string;
  type: ActivityType;
  source: ActivitySource;
  chapterNumber?: number | null;
  wordsDelta?: number;
  meta?: Record<string, unknown> | null;
  /** Override the clock (tests / backfill). Defaults to now. */
  at?: Date;
}

/**
 * Append one activity event inside the caller's transaction. Synchronous +
 * db-handle so it composes with the chapter/unification write that triggered
 * it. Best-effort by contract for the caller: wrap in try/catch at the call
 * site if the producing write must never be blocked by telemetry.
 */
export function recordActivityEvent(
  db: Database.Database,
  input: RecordActivityEventInput,
): void {
  const at = input.at ?? new Date();
  db.prepare(
    `INSERT INTO activity_events
       (id, novel_id, type, source, chapter_number, words_delta, day_key, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.novelId,
    input.type,
    input.source,
    input.chapterNumber ?? null,
    input.wordsDelta ?? 0,
    localDayKey(at),
    input.meta ? JSON.stringify(input.meta) : null,
    at.toISOString(),
  );
}

export interface DailyWordPoint {
  dayKey: string;
  ai: number;
  human: number;
  accepted: number;
  total: number;
}

/**
 * Per-day word split for the last `days` local days (inclusive of today),
 * source-bucketed. Missing days are zero-filled so the trend bar chart has a
 * stable x-axis. Negative deltas (deletions) are clamped to 0 per bucket so the
 * trend never shows a negative bar.
 */
export function getDailyWordSeries(novelId: string, days = 7): DailyWordPoint[] {
  const db = getDb();
  const today = new Date();
  const buckets: DailyWordPoint[] = [];
  const index = new Map<string, DailyWordPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = localDayKey(d);
    const point: DailyWordPoint = { dayKey: key, ai: 0, human: 0, accepted: 0, total: 0 };
    buckets.push(point);
    index.set(key, point);
  }
  const earliest = buckets[0]?.dayKey ?? localDayKey(today);
  const rows = db
    .prepare(
      `SELECT day_key, source, SUM(MAX(words_delta, 0)) AS words
         FROM activity_events
        WHERE novel_id = ? AND day_key >= ?
        GROUP BY day_key, source`,
    )
    .all(novelId, earliest) as { day_key: string; source: ActivitySource; words: number }[];
  for (const r of rows) {
    const point = index.get(r.day_key);
    if (!point) continue;
    const words = r.words ?? 0;
    if (r.source === 'ai') point.ai += words;
    else if (r.source === 'human') point.human += words;
    else if (r.source === 'accepted') point.accepted += words;
    point.total += words;
  }
  return buckets;
}

/**
 * Current consecutive-day writing streak: number of days up to and including
 * today (or yesterday, to tolerate "haven't written yet today") with at least
 * one positive-progress event. Tolerant of a single missing today.
 */
export function getWritingStreak(novelId: string): number {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT day_key FROM activity_events
        WHERE novel_id = ? AND words_delta > 0
        ORDER BY day_key DESC`,
    )
    .all(novelId) as { day_key: string }[];
  if (rows.length === 0) return 0;
  const active = new Set(rows.map(r => r.day_key));
  const today = new Date();
  const todayKey = localDayKey(today);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayKey = localDayKey(yesterday);
  // Anchor: today if active, else yesterday (grace), else no current streak.
  let cursor: Date;
  if (active.has(todayKey)) cursor = today;
  else if (active.has(yesterdayKey)) cursor = yesterday;
  else return 0;
  let streak = 0;
  while (active.has(localDayKey(cursor))) {
    streak++;
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function getActivityTimeline(novelId: string, limit = 30): ActivityEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM activity_events
        WHERE novel_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(novelId, limit) as ActivityEventRow[];
  return rows.map(mapActivityEvent);
}

/** Sum of today's positive word deltas, source-split — for the "today" ring. */
export function getTodayWordSplit(novelId: string): {
  ai: number;
  human: number;
  accepted: number;
  total: number;
} {
  const series = getDailyWordSeries(novelId, 1);
  const today = series[series.length - 1];
  return today
    ? { ai: today.ai, human: today.human, accepted: today.accepted, total: today.total }
    : { ai: 0, human: 0, accepted: 0, total: 0 };
}

/**
 * Weekly Progressed Projects (north star): count of distinct novels with at
 * least one effective-advance event in the last 7 local days. chapter_edited
 * only counts with positive words_delta; pure AI generation never counts.
 */
export function getWeeklyProgressedProjects(): number {
  const db = getDb();
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - 6);
  const startKey = localDayKey(start);
  const placeholders = PROGRESS_EVENT_TYPES.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT novel_id) AS n
         FROM activity_events
        WHERE day_key >= ?
          AND type IN (${placeholders})
          AND (type != 'chapter_edited' OR words_delta > 0)`,
    )
    .get(startKey, ...PROGRESS_EVENT_TYPES) as { n: number } | undefined;
  return row?.n ?? 0;
}

export { nowIso };
