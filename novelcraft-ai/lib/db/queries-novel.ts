import { nowIso, parseTimestamp } from '@/lib/utils';
import { getDb } from '@/lib/db/connection';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';
import {
  parseJsonbWithVersion,
  toJsonText,
  JSON_COLUMN_VERSIONS,
} from '@/lib/db/json-columns';
import {
  FIELD_TO_COLUMN,
  NOVEL_INTERNAL_FIELDS,
  NOVEL_WRITABLE_FIELDS,
  mapNovel,
  type Novel,
  type Message,
  type NovelBlueprint,
  type NovelRow,
  type NovelSettings,
  type WritingLockInfo,
} from '@/lib/db-types';
import type { VolumeSummary } from '@/lib/ai/types';
import { projectBlueprintFromOutline } from '@/lib/ai/blueprint-projection';
import { upsertKnowledgeIndex, type KnowledgeIndexInsert } from '@/lib/db/queries-vault';
import { parseWikilinks } from '@/lib/vault/wikilink';
import { hashContent } from '@/lib/vault/content-hash';
import { slugifyForFs, uniqueFilename } from '@/lib/vault/filename';
import { vaultPathFor } from '@/lib/vault/entry';
import { buildKnowledgeEntrySummary } from '@/lib/knowledge';
import type Database from 'better-sqlite3';

const NOVEL_JSON_COLUMN_VERSION_COL: Record<string, string> = {
  interview_state: 'interview_state_v',
  unification_report: 'unification_report_v',
};

function novelJsonVersion(col: string, value: unknown): number | null {
  if (!NOVEL_JSON_COLUMN_VERSION_COL[col]) return null;
  if (value === null || value === undefined) return null;
  switch (col) {
    case 'interview_state':
      return JSON_COLUMN_VERSIONS.interview_state;
    case 'unification_report':
      return JSON_COLUMN_VERSIONS.unification_report;
    default:
      return null;
  }
}

export function hydrateNovelRow(r: Record<string, unknown>): NovelRow {
  return {
    id: r.id as string,
    user_id: r.user_id as string,
    title: r.title as string,
    genre: r.genre as string,
    target_words: r.target_words as number,
    stage: r.stage as string,
    progress: r.progress as number,
    story_summary: r.story_summary as string,
    character_summary: r.character_summary as string,
    arc_summary: r.arc_summary as string,
    interview_state: parseJsonbWithVersion<Record<string, unknown>>(
      r.interview_state,
      r.interview_state_v,
      'novels.interview_state',
      { maxSupportedVersion: JSON_COLUMN_VERSIONS.interview_state, lenientOnCorruption: true },
    ),
    // W2-D dropped `novels.blueprint` — blueprint is a projection of outline
    // knowledge entries. Mappers default to null; callers needing the blueprint
    // dereference via `getNovelBlueprint(id)` which delegates to the projector.
    blueprint: null,
    writing_lock_token: (r.writing_lock_token as string | null) ?? null,
    writing_lock_expires_at: (r.writing_lock_expires_at as string | null) ?? null,
    unification_report: parseJsonbWithVersion(
      r.unification_report,
      r.unification_report_v,
      'novels.unification_report',
      { maxSupportedVersion: JSON_COLUMN_VERSIONS.unification_report, lenientOnCorruption: true },
    ),
    settings: parseSettings(r.settings),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

// `settings` is a plain TEXT JSON column (no version envelope yet — the shape
// is small and forward-compatible by virtue of every field being optional).
// Tolerate legacy null / malformed payloads by returning null; callers default
// to OPERATION_DEFAULT_CREATIVITY rather than crashing on a parse error.
function parseSettings(raw: unknown): NovelSettings | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as NovelSettings;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as NovelSettings) : null;
  } catch {
    return null;
  }
}

export async function getNovels(userId: string): Promise<Novel[]> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM novels WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as Record<string, unknown>[];
  return rows.map(r => mapNovel(hydrateNovelRow(r)));
}

export function isNovelTrashed(novel: Pick<Novel, 'settings'>): boolean {
  return typeof novel.settings?.trashedAt === 'string' && novel.settings.trashedAt.length > 0;
}

export async function getActiveNovels(userId: string): Promise<Novel[]> {
  return (await getNovels(userId)).filter(novel => !isNovelTrashed(novel));
}

export async function getTrashedNovels(userId: string): Promise<Novel[]> {
  return (await getNovels(userId)).filter(isNovelTrashed);
}

export async function getNovel(id: string): Promise<Novel | undefined> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return mapNovel(hydrateNovelRow(row));
}

export async function getActiveNovel(id: string): Promise<Novel | undefined> {
  const novel = await getNovel(id);
  return novel && !isNovelTrashed(novel) ? novel : undefined;
}

export async function trashNovel(id: string, userId: string): Promise<Novel | null> {
  const novel = await getNovel(id);
  if (!novel || novel.userId !== userId) return null;
  if (isNovelTrashed(novel)) return novel;
  return updateNovel(id, {
    settings: { ...(novel.settings ?? {}), trashedAt: nowIso() },
  });
}

export async function restoreTrashedNovel(id: string, userId: string): Promise<Novel | null> {
  const novel = await getNovel(id);
  if (!novel || novel.userId !== userId || !isNovelTrashed(novel)) return null;
  const settings = { ...(novel.settings ?? {}) };
  delete settings.trashedAt;
  return updateNovel(id, { settings });
}

export async function deleteTrashedNovelPermanently(id: string, userId: string): Promise<boolean> {
  const novel = await getNovel(id);
  if (!novel || novel.userId !== userId || !isNovelTrashed(novel)) return false;
  return deleteNovelCascade(id, userId);
}

export async function verifyNovelOwnership(novelId: string, userId: string): Promise<Novel> {
  const novel = await getActiveNovel(novelId);
  if (!novel || novel.userId !== userId) {
    throw new Error('Not found');
  }
  return novel;
}

export async function createNovel(data: Partial<Novel> & { userId: string }): Promise<Novel> {
  const db = getDb();
  return insertNovel(db, data, nowIso());
}

function buildNovelForInsert(data: Partial<Novel> & { userId: string }): Novel {
  const safe: Partial<Novel> = {};
  for (const key of NOVEL_WRITABLE_FIELDS) {
    if (key in data) (safe as Record<string, unknown>)[key] = (data as Record<string, unknown>)[key];
  }

  return {
    id: crypto.randomUUID(),
    title: 'Untitled Draft',
    genre: '',
    targetWords: 80000,
    stage: 'discovery_interview',
    progress: 0,
    storySummary: '',
    characterSummary: '',
    arcSummary: '',
    interviewState: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...safe,
    userId: data.userId,
  };
}

function insertNovel(
  db: ReturnType<typeof getDb>,
  data: Partial<Novel> & { userId: string },
  now: string,
): Novel {
  const novel = buildNovelForInsert(data);

  const interviewStateValue = novel.interviewState ?? null;
  db.prepare(
    `INSERT INTO novels (
       id, user_id, title, genre, target_words, stage, progress,
       story_summary, character_summary, arc_summary,
       interview_state, interview_state_v,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    novel.id,
    novel.userId,
    novel.title,
    novel.genre,
    novel.targetWords,
    novel.stage,
    novel.progress,
    novel.storySummary,
    novel.characterSummary,
    novel.arcSummary,
    toJsonText(interviewStateValue),
    interviewStateValue === null ? null : JSON_COLUMN_VERSIONS.interview_state,
    now,
    now,
  );

  const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novel.id) as Record<string, unknown>;
  return mapNovel(hydrateNovelRow(row));
}

export async function createNovelWithOpeningMessage(
  data: Partial<Novel> & {
    userId: string;
    openingMessage: string;
    openingMessageRole?: Message['role'];
  },
): Promise<Novel> {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    const novel = insertNovel(db, data, now);
    db.prepare(
      `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      novel.id,
      data.openingMessageRole ?? 'user',
      data.openingMessage,
      null,
      now,
    );
    return novel;
  });
  return tx();
}

export async function createBlankNovel(
  data: Partial<Novel> & { userId: string; firstChapterTitle: string },
): Promise<Novel> {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    const novel = insertNovel(db, data, now);
    db.prepare('UPDATE novels SET stage = ? WHERE id = ?')
      .run('autonomous_writing', novel.id);
    db.prepare(
      `INSERT INTO chapters (
         id, novel_id, chapter_number, title, content, original_content,
         word_count, version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      novel.id,
      1,
      data.firstChapterTitle,
      '',
      null,
      0,
      0,
      now,
    );
    return { ...novel, stage: 'autonomous_writing' as const };
  });
  return tx();
}

// `settings` is included so updateNovel JSON-encodes the payload rather than
// dropping a [object Object] into the column. It has no version sidecar — the
// shape is small + every field optional, so hydration tolerates older rows
// via parseSettings above.
//
// W2-D dropped the `blueprint` column from `novels`; updateNovel ignores any
// stray `blueprint` key on its input (see the `FIELD_TO_COLUMN` filter in
// db-types — blueprint is no longer mapped to a column name).
const JSON_NOVEL_COLUMNS = new Set(['interview_state', 'unification_report', 'settings']);

export async function updateNovel(
  id: string,
  data: Partial<Novel>,
  internal = true,
): Promise<Novel | null> {
  return applyNovelUpdate(getDb(), id, data, internal);
}

/**
 * Synchronous novel UPDATE that takes the db handle so a caller can fold it
 * into a wider `db.transaction(() => {...})()` (e.g. the interview stage-advance
 * which must update both `interview_state` and `stage` atomically). Mirrors
 * {@link updateNovel} field-for-field, including JSON-column versioning.
 */
export function applyNovelUpdate(
  db: ReturnType<typeof getDb>,
  id: string,
  data: Partial<Novel>,
  internal = true,
): Novel | null {
  const allowedKeys = internal ? NOVEL_INTERNAL_FIELDS : NOVEL_WRITABLE_FIELDS;

  const setParts: string[] = ['updated_at = ?'];
  const values: unknown[] = [nowIso()];
  for (const key of allowedKeys) {
    if (key in data) {
      const col = FIELD_TO_COLUMN[key];
      if (col) {
        const raw = (data as Record<string, unknown>)[key];
        if (JSON_NOVEL_COLUMNS.has(col)) {
          setParts.push(`${col} = ?`);
          values.push(toJsonText(raw));
          const versionCol = NOVEL_JSON_COLUMN_VERSION_COL[col];
          if (versionCol) {
            setParts.push(`${versionCol} = ?`);
            values.push(novelJsonVersion(col, raw));
          }
        } else {
          setParts.push(`${col} = ?`);
          values.push(raw);
        }
      }
    }
  }

  values.push(id);
  db.prepare(`UPDATE novels SET ${setParts.join(', ')} WHERE id = ?`).run(...values);

  const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return mapNovel(hydrateNovelRow(row));
}

type PromoteGreenlightDraftResult =
  | { ok: true; novel: Novel }
  | { ok: false; reason: 'not_found' | 'conflict' };

function sameMessageSnapshot(
  actual: readonly { id: string }[],
  expectedIds: readonly string[],
): boolean {
  if (actual.length !== expectedIds.length) return false;
  return actual.every((message, index) => message.id === expectedIds[index]);
}

function sameJsonSnapshot(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
}

function sameNovelSnapshot(current: Novel, expected: Novel): boolean {
  return (
    current.stage === 'discovery_interview' &&
    current.updatedAt === expected.updatedAt &&
    current.title === expected.title &&
    current.genre === expected.genre &&
    current.targetWords === expected.targetWords &&
    current.progress === expected.progress &&
    current.storySummary === expected.storySummary &&
    current.characterSummary === expected.characterSummary &&
    current.arcSummary === expected.arcSummary &&
    sameJsonSnapshot(current.interviewState, expected.interviewState)
  );
}

export async function promoteGreenlightDraftWithMessage(
  novelId: string,
  expectedNovel: Novel,
  expectedMessageIds: readonly string[],
  draft: Pick<Novel, 'title' | 'genre' | 'storySummary' | 'characterSummary' | 'arcSummary'>,
  assistantMessage: string,
): Promise<PromoteGreenlightDraftResult> {
  const db = getDb();
  const tx = db.transaction((): PromoteGreenlightDraftResult => {
    const currentRow = db
      .prepare('SELECT * FROM novels WHERE id = ?')
      .get(novelId) as Record<string, unknown> | undefined;
    if (!currentRow) return { ok: false, reason: 'not_found' };
    const currentNovel = mapNovel(hydrateNovelRow(currentRow));
    if (!sameNovelSnapshot(currentNovel, expectedNovel)) {
      return { ok: false, reason: 'conflict' };
    }

    const currentMessages = db
      .prepare(
        'SELECT id FROM messages WHERE novel_id = ? AND conversation_id IS NULL ORDER BY created_at ASC, rowid ASC',
      )
      .all(novelId) as { id: string }[];
    if (!sameMessageSnapshot(currentMessages, expectedMessageIds)) {
      return { ok: false, reason: 'conflict' };
    }

    const now = nowIso();
    const info = db.prepare(
      `UPDATE novels
          SET title = ?,
              genre = ?,
              story_summary = ?,
              character_summary = ?,
              arc_summary = ?,
              stage = ?,
              updated_at = ?
        WHERE id = ? AND stage = 'discovery_interview'`,
    ).run(
      draft.title,
      draft.genre,
      draft.storySummary,
      draft.characterSummary,
      draft.arcSummary,
      'ready_for_greenlight',
      now,
      novelId,
    );
    if (info.changes === 0) {
      return { ok: false, reason: 'conflict' };
    }

    db.prepare(
      `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
       VALUES (?, ?, 'assistant', ?, NULL, ?)`,
    ).run(crypto.randomUUID(), novelId, assistantMessage, now);

    const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as Record<string, unknown>;
    return { ok: true, novel: mapNovel(hydrateNovelRow(row)) };
  });
  return tx();
}

export async function completeWritingDraft(
  novelId: string,
  assistantMessage: string,
): Promise<Novel | null> {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    const info = db
      .prepare('UPDATE novels SET stage = ?, progress = ?, updated_at = ? WHERE id = ?')
      .run('whole_book_unification', 100, now, novelId);
    if (info.changes === 0) return null;

    db.prepare(
      `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
       VALUES (?, ?, 'assistant', ?, NULL, ?)`,
    ).run(crypto.randomUUID(), novelId, assistantMessage, now);

    const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as Record<string, unknown>;
    return mapNovel(hydrateNovelRow(row));
  });
  return tx();
}

export async function persistUnificationReportWithMessage(
  novelId: string,
  report: Novel['unificationReport'],
  assistantMessage: string,
): Promise<void> {
  const db = getDb();
  const now = nowIso();
  const tx = db.transaction(() => {
    const info = db.prepare(
      `UPDATE novels
          SET unification_report = ?,
              unification_report_v = ?,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      toJsonText(report),
      report === null ? null : JSON_COLUMN_VERSIONS.unification_report,
      now,
      novelId,
    );
    if (info.changes === 0) {
      throw new Error('Novel not found');
    }

    db.prepare(
      `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
       VALUES (?, ?, 'assistant', ?, NULL, ?)`,
    ).run(crypto.randomUUID(), novelId, assistantMessage, now);
  });
  tx();
}

export async function deleteNovelCascade(id: string, userId: string): Promise<boolean> {
  const db = getDb();
  const info = db
    .prepare('DELETE FROM novels WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return info.changes > 0;
}

/** Project the writing blueprint from outline knowledge entries. */
export async function getNovelBlueprint(novelId: string): Promise<NovelBlueprint | null> {
  return projectBlueprintFromOutline(novelId);
}

/**
 * Upserts one outline knowledge entry per blueprint chapter. Existing outline
 * rows for the novel are removed first so a regenerate fully replaces the
 * previous plan; chapter rows in the `chapters` table are NOT touched (URLs
 * stay stable — see plan §3.5).
 *
 * Each outline row is also pushed into the `knowledge_index` mirror via
 * `syncIndexFromEntry` so recall sees the new plan on the very next chapter
 * draft, without waiting for a vault walk.
 */
interface PreparedOutlineRow {
  id: string;
  title: string;
  summary: string;
  data: string;
  sortOrder: number;
  index: KnowledgeIndexInsert;
}

interface PrepareOutlineRowsOptions {
  clearChapterIdsFrom?: number;
}

async function prepareOutlineRows(
  db: Database.Database,
  novelId: string,
  blueprint: NovelBlueprint,
  now: string,
  options: PrepareOutlineRowsOptions = {},
): Promise<PreparedOutlineRow[]> {
  // Build a lookup of (chapter_number → chapter id) so we can back-fill
  // `data.chapterId` when an outline entry corresponds to a drafted chapter.
  const chapterIdByNumber = new Map<number, string>();
  const chapterRows = db
    .prepare('SELECT id, chapter_number FROM chapters WHERE novel_id = ?')
    .all(novelId) as { id: string; chapter_number: number }[];
  for (const c of chapterRows) {
    if (
      typeof options.clearChapterIdsFrom === 'number'
      && c.chapter_number >= options.clearChapterIdsFrom
    ) {
      continue;
    }
    chapterIdByNumber.set(c.chapter_number, c.id);
  }

  const takenFilenames = new Set<string>();
  const targetWordsPerChapter = blueprint.targetWordsPerChapter ?? 0;
  const rows: PreparedOutlineRow[] = [];
  for (let i = 0; i < blueprint.chapters.length; i++) {
    const ch = blueprint.chapters[i];
    const id = crypto.randomUUID();
    const title = ch.title ?? `Chapter ${ch.chapterNumber}`;
    const data = {
      chapterId: chapterIdByNumber.get(ch.chapterNumber) ?? '',
      chapterNumber: ch.chapterNumber,
      synopsis: ch.summary ?? '',
      keyEvents: [],
      characters: [],
      pov: '',
      status: 'planned' as const,
      wordCountTarget: targetWordsPerChapter,
      notes: '',
      // W3-1: regenerate always produces chapter-level outline rows. Stamp the
      // hierarchy fields explicitly so the projection's `level='chapter'` guard
      // matches and a regenerated plan is a clean flat tree of top-level
      // chapters (no inherited scene/beat parentage).
      level: 'chapter' as const,
      parentId: '',
      sceneMeta: { pov: '', time: '', location: '', conflict: '', outcome: '' },
      plotlineTags: [],
      characterArcTags: [],
      customMeta: {},
    };
    const summary = buildKnowledgeEntrySummary('outline', data as unknown as Record<string, unknown>);
    const tags = '[]';
    const dataJson = JSON.stringify(data);
    const filename = uniqueFilename(slugifyForFs(title), 'md', takenFilenames);
    takenFilenames.add(filename);
    const dataForIndex: Record<string, unknown> = { ...data };
    if (summary && !dataForIndex['description']) dataForIndex['__summary'] = summary;
    const contentHash = await hashContent(JSON.stringify({
      title,
      type: 'outline',
      data,
      summary,
      tags: [],
    }));
    rows.push({
      id,
      title,
      summary,
      data: dataJson,
      sortOrder: ch.chapterNumber - 1,
      index: {
        id,
        novelId,
        type: 'outline',
        path: vaultPathFor('outline', filename),
        title,
        tags,
        aliases: '[]',
        importance: null,
        data: JSON.stringify(dataForIndex),
        outgoingLinks: JSON.stringify(parseWikilinks(`${summary}\n${dataJson}`)),
        contentHash,
        updatedAt: now,
      },
    });
  }
  return rows;
}

function replaceOutlineRows(
  db: Database.Database,
  novelId: string,
  rows: PreparedOutlineRow[],
  now: string,
): void {
  db.prepare(
    `DELETE FROM knowledge_index WHERE novel_id = ? AND type = 'outline'`,
  ).run(novelId);
  db.prepare(
    `DELETE FROM knowledge_entries WHERE novel_id = ? AND type = 'outline'`,
  ).run(novelId);

  const insert = db.prepare(
    `INSERT INTO knowledge_entries
       (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
     VALUES (?, ?, 'outline', ?, ?, ?, ?, '[]', ?, ?)`,
  );
  // Rows are guaranteed new (all outline rows were DELETEd just above), so the
  // shared upsert behaves as a plain insert here.
  for (const row of rows) {
    insert.run(
      row.id,
      novelId,
      row.title,
      row.summary,
      row.data,
      row.sortOrder,
      now,
      now,
    );
    upsertKnowledgeIndex(db, row.index);
  }
}

export async function setNovelBlueprint(novelId: string, blueprint: NovelBlueprint): Promise<void> {
  const db = getDb();
  const now = nowIso();
  const rows = await prepareOutlineRows(db, novelId, blueprint, now);

  const tx = db.transaction(() => {
    replaceOutlineRows(db, novelId, rows, now);
    touchNovelUpdatedAt(db, novelId);
  });
  tx();
}

export async function setNovelBlueprintAfterDeletingChaptersFrom(
  novelId: string,
  blueprint: NovelBlueprint,
  fromChapter: number,
): Promise<number> {
  const db = getDb();
  const now = nowIso();
  const rows = await prepareOutlineRows(db, novelId, blueprint, now, {
    clearChapterIdsFrom: fromChapter,
  });
  const tx = db.transaction(() => {
    const info = db
      .prepare('DELETE FROM chapters WHERE novel_id = ? AND chapter_number >= ?')
      .run(novelId, fromChapter);
    replaceOutlineRows(db, novelId, rows, now);
    // Outline rows are always replaced, so the novel always changed — touch
    // unconditionally inside the transaction (no second post-tx touch).
    touchNovelUpdatedAt(db, novelId);
    return info.changes;
  });
  return tx();
}

/** Wipes every outline knowledge entry for a novel + their index mirror rows. */
export async function clearNovelBlueprint(novelId: string): Promise<void> {
  const db = getDb();
  const tx = db.transaction(() => {
    const indexInfo = db.prepare(
      `DELETE FROM knowledge_index WHERE novel_id = ? AND type = 'outline'`,
    ).run(novelId);
    const entryInfo = db.prepare(
      `DELETE FROM knowledge_entries WHERE novel_id = ? AND type = 'outline'`,
    ).run(novelId);
    if (indexInfo.changes > 0 || entryInfo.changes > 0) {
      touchNovelUpdatedAt(db, novelId);
    }
  });
  tx();
}

/**
 * Fetch the volume-summary list for a novel. Volume summaries are a
 * compression of 10+ chapters into a 400-800 word digest; they let
 * buildRollingDigest skip detailed per-chapter facts for everything before the
 * most recent volume boundary, keeping the prompt size flat for million-word
 * novels.
 *
 * Tolerates a missing/null column and parse failures — returns [] rather than
 * surfacing a JSON parse error to the AI route. Order is the on-disk insertion
 * order (start ASC), which `buildRollingDigest` re-sorts defensively anyway.
 */
export async function getVolumeSummaries(novelId: string): Promise<VolumeSummary[]> {
  const db = getDb();
  const row = db
    .prepare('SELECT volume_summaries FROM novels WHERE id = ?')
    .get(novelId) as { volume_summaries: string | null } | undefined;
  if (!row?.volume_summaries) return [];
  try {
    const parsed = JSON.parse(row.volume_summaries);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is VolumeSummary =>
      Boolean(v) && typeof v === 'object'
        && typeof (v as Record<string, unknown>).start === 'number'
        && typeof (v as Record<string, unknown>).end === 'number'
        && typeof (v as Record<string, unknown>).summary === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Append a single volume summary to the novel's volume_summaries list.
 *
 * - Idempotent: if a summary with the same (start,end) already exists it's
 *   replaced rather than duplicated; this matches the start-writing flow that
 *   may re-trigger summarisation after a length-retry chapter.
 * - List stays sorted by `start ASC` on disk so downstream readers don't have
 *   to.
 */
export async function appendVolumeSummary(
  novelId: string,
  v: VolumeSummary,
): Promise<void> {
  if (!v || typeof v.start !== 'number' || typeof v.end !== 'number') return;
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT volume_summaries FROM novels WHERE id = ?').get(novelId) as
      | { volume_summaries: string | null }
      | undefined;
    if (!row) return;
    let current: VolumeSummary[] = [];
    if (row.volume_summaries) {
      try {
        const parsed = JSON.parse(row.volume_summaries) as unknown;
        current = Array.isArray(parsed) ? parsed as VolumeSummary[] : [];
      } catch {
        current = [];
      }
    }
    const filtered = current.filter(x => !(x.start === v.start && x.end === v.end));
    filtered.push(v);
    filtered.sort((a, b) => a.start - b.start);
    db.prepare('UPDATE novels SET volume_summaries = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(filtered), nowIso(), novelId);
  });
  tx();
}

export async function acquireWritingLock(
  novelId: string,
  ttlSec: number,
): Promise<WritingLockInfo | null> {
  const db = getDb();
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  const now = nowIso();

  const acquire = db.transaction(() => {
    return db
      .prepare(
        `UPDATE novels
            SET writing_lock_token = ?,
                writing_lock_expires_at = ?
          WHERE id = ?
            AND (writing_lock_token IS NULL OR writing_lock_expires_at < ?)`,
      )
      .run(token, expiresAt, novelId, now);
  });
  const info = acquire();

  if (info.changes === 0) return null;
  return {
    token,
    expiresAt: parseTimestamp(expiresAt),
  };
}

export async function renewWritingLock(
  novelId: string,
  token: string,
  ttlSec: number,
): Promise<number | null> {
  const db = getDb();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  // Renew only an unexpired lock: matching on token alone would let a holder
  // extend a lock that already lapsed (and may have been re-acquired by
  // another writer). Requiring `expires_at >= now` forces a clean re-acquire.
  const info = db
    .prepare(
      `UPDATE novels SET writing_lock_expires_at = ?
       WHERE id = ? AND writing_lock_token = ? AND writing_lock_expires_at >= ?`,
    )
    .run(expiresAt, novelId, token, now);
  if (info.changes === 0) return null;
  return parseTimestamp(expiresAt);
}

export async function releaseWritingLock(novelId: string, token: string): Promise<void> {
  const db = getDb();
  db.prepare(
    `UPDATE novels
        SET writing_lock_token = NULL,
            writing_lock_expires_at = NULL
      WHERE id = ? AND writing_lock_token = ?`,
  ).run(novelId, token);
}
