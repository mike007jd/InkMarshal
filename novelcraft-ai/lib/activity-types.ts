// Domain types for the append-only project activity stream (activity_events).
// Storage-neutral: the row shape mirrors the DB columns, the
// domain shape is what callers and the command center consume. See
// lib/db/queries-activity.ts for reads/writes.

export type ActivityType =
  | 'chapter_written'
  | 'chapter_edited'
  | 'unification_applied'
  | 'quality_resolved'
  | 'status_changed'
  | 'export_completed'
  | 'snapshot_restored';

/** Who produced the change. `accepted` = the author accepted an AI-generated
 *  suggestion, which powers acceptance-aware activity and cost analytics. */
export type ActivitySource = 'ai' | 'human' | 'accepted';

export interface ActivityEvent {
  id: string;
  novelId: string;
  type: ActivityType;
  source: ActivitySource;
  chapterNumber: number | null;
  wordsDelta: number;
  /** Local-day bucket (YYYY-MM-DD) fixed at write time — never recomputed. */
  dayKey: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface ActivityEventRow {
  id: string;
  novel_id: string;
  type: ActivityType;
  source: ActivitySource;
  chapter_number: number | null;
  words_delta: number;
  day_key: string;
  meta: string | null;
  created_at: string;
}

export function mapActivityEvent(row: ActivityEventRow): ActivityEvent {
  let meta: Record<string, unknown> | null = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    novelId: row.novel_id,
    type: row.type,
    source: row.source,
    chapterNumber: row.chapter_number,
    wordsDelta: row.words_delta,
    dayKey: row.day_key,
    meta,
    createdAt: row.created_at,
  };
}

/** Local-timezone day bucket. Fixed at write time and stored verbatim so a
 *  later timezone change never retroactively reshuffles the streak/series. */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The activity types that count as an "effective advance" for the north-star
 *  metric (Weekly Progressed Projects). Pure AI generated words do NOT count —
 *  only human-meaningful progress. chapter_edited only counts when words_delta>0
 *  (filtered at query time). */
export const PROGRESS_EVENT_TYPES: readonly ActivityType[] = [
  'chapter_written',
  'chapter_edited',
  'unification_applied',
  'status_changed',
  'export_completed',
];
