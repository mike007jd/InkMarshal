import type Database from 'better-sqlite3';
import { countWords, nowIso, parseTimestamp } from '@/lib/utils';
import { getDb } from '@/lib/db/connection';
import {
  fromJsonTextLenient,
  parseJsonbWithVersion,
  toJsonText,
  JSON_COLUMN_VERSIONS,
  SAFE_DATA_JSON,
} from '@/lib/db/json-columns';
import {
  CHAT_HISTORY_KEEP,
  mapChapter,
  mapChapterLite,
  mapMessage,
  SNAPSHOT_MAX,
  type Chapter,
  type ChapterLite,
  type ChapterMetaUpdate,
  type ChapterProcessingStatus,
  type ChapterRow,
  type ChapterSnapshot,
  type Message,
} from '@/lib/db-types';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';
import { recordActivityEvent } from '@/lib/db/queries-activity';

export function hydrateChapterRow(r: Record<string, unknown>): ChapterRow {
  return {
    id: r.id as string,
    novel_id: r.novel_id as string,
    chapter_number: r.chapter_number as number,
    title: r.title as string,
    content: r.content as string,
    original_content: (r.original_content as string | null) ?? null,
    word_count: r.word_count as number,
    version: r.version as number,
    summary: (r.summary as string | null) ?? '',
    key_facts: parseJsonbWithVersion(
      r.key_facts,
      r.key_facts_v,
      'chapters.key_facts',
      { maxSupportedVersion: JSON_COLUMN_VERSIONS.key_facts, lenientOnCorruption: true },
    ),
    quality_issues: parseJsonbWithVersion(
      r.quality_issues,
      r.quality_issues_v,
      'chapters.quality_issues',
      { maxSupportedVersion: JSON_COLUMN_VERSIONS.quality_issues, lenientOnCorruption: true },
    ),
    generation_meta: parseJsonbWithVersion(
      r.generation_meta,
      r.generation_meta_v,
      'chapters.generation_meta',
      { maxSupportedVersion: JSON_COLUMN_VERSIONS.generation_meta, lenientOnCorruption: true },
    ),
    // Snapshots is an unversioned JSON list — lenient parse so a corrupt row
    // degrades to "no snapshots" rather than blowing up the chapter read.
    snapshots: fromJsonTextLenient<ChapterSnapshot[]>(r.snapshots),
    processing_status: (r.processing_status as ChapterProcessingStatus | null | undefined) ?? 'complete',
    created_at: r.created_at as string,
  };
}

export async function getChapters(novelId: string): Promise<Chapter[]> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM chapters WHERE novel_id = ? ORDER BY chapter_number ASC')
    .all(novelId) as Record<string, unknown>[];
  return rows.map(r => mapChapter(hydrateChapterRow(r)));
}

export async function getChaptersLite(novelId: string): Promise<ChapterLite[]> {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, novel_id, chapter_number, title, word_count, version, summary, processing_status, created_at FROM chapters WHERE novel_id = ? ORDER BY chapter_number ASC',
    )
    .all(novelId) as Record<string, unknown>[];
  return rows.map(r =>
    mapChapterLite({
      id: r.id as string,
      novel_id: r.novel_id as string,
      chapter_number: r.chapter_number as number,
      title: r.title as string,
      content: '',
      original_content: null,
      word_count: r.word_count as number,
      version: r.version as number,
      summary: (r.summary as string | null) ?? '',
      processing_status: (r.processing_status as ChapterProcessingStatus | null | undefined) ?? 'complete',
      created_at: r.created_at as string,
    }),
  );
}

export interface UpsertChapterOptions {
  /**
   * AI generation must pass `content_saved` so resume can finish metadata
   * without regenerating prose. Manual/import callers leave the default
   * `complete`.
   */
  processingStatus?: ChapterProcessingStatus;
}

export async function upsertChapter(
  novelId: string,
  chapterNumber: number,
  title: string,
  content: string,
  options?: UpsertChapterOptions,
): Promise<Chapter> {
  const db = getDb();
  const wordCount = countWords(content);
  const now = nowIso();
  const processingStatus: ChapterProcessingStatus = options?.processingStatus ?? 'complete';

  // Capture prior length before the upsert so the AI word delta on a
  // re-generation is net (new − old), not the full new length.
  const prev = db
    .prepare('SELECT word_count FROM chapters WHERE novel_id = ? AND chapter_number = ?')
    .get(novelId, chapterNumber) as { word_count: number } | undefined;
  const prevWords = prev?.word_count ?? 0;

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO chapters (
         id, novel_id, chapter_number, title, content, original_content,
         word_count, version, processing_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, chapter_number) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         -- An upsert-on-conflict is a fresh generation: clear any stale
         -- revert-baseline so a later revertChapterToOriginalContent can't
         -- restore content from a previous draft lineage.
         original_content = NULL,
         word_count = excluded.word_count,
         version = COALESCE(chapters.version, 0) + 1,
         processing_status = excluded.processing_status`,
    ).run(
      crypto.randomUUID(),
      novelId,
      chapterNumber,
      title,
      content,
      null,
      wordCount,
      0,
      processingStatus,
      now,
    );
    touchNovelUpdatedAt(db, novelId);
    try {
      recordActivityEvent(db, {
        novelId,
        type: 'chapter_written',
        source: 'ai',
        chapterNumber,
        wordsDelta: wordCount - prevWords,
      });
    } catch {
      // Telemetry must never block a chapter write.
    }
  });
  write();

  const row = db
    .prepare('SELECT * FROM chapters WHERE novel_id = ? AND chapter_number = ?')
    .get(novelId, chapterNumber) as Record<string, unknown>;
  return mapChapter(hydrateChapterRow(row));
}

export async function getChapter(
  novelId: string,
  chapterNumber: number,
): Promise<Chapter | undefined> {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM chapters WHERE novel_id = ? AND chapter_number = ?')
    .get(novelId, chapterNumber) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapChapter(hydrateChapterRow(row));
}

/**
 * Optimistic-version chapter content write — the single source for the
 * `UPDATE chapters … WHERE version = ?` lock. Synchronous and takes the db
 * handle so it is safe to call inside a better-sqlite3 transaction (the
 * whole-book-unification apply loop runs inside one and used to reimplement
 * this). Returns the new version on success, or `conflict` when no row matched
 * `expectedVersion`.
 */
/**
 * SET fragment flagging the cached `summary` as out of sync with `content`.
 * Folded into every content write that does NOT refresh the summary (manual
 * editor saves, unification edits, snapshot restores); cleared when a fresh
 * summary lands via updateChapterMeta. Context assembly substitutes a
 * live-content excerpt for a stale summary so the rolling digest never
 * describes text the user has since rewritten.
 *
 * Gated on `generation_meta IS NOT NULL` — only AI flows write summaries and
 * they always write generation_meta alongside, so this never fabricates a
 * meta object whose sole key is the flag.
 */
const MARK_SUMMARY_STALE_SET = `generation_meta = CASE
    WHEN generation_meta IS NOT NULL AND summary IS NOT NULL AND summary != ''
    THEN json_set(generation_meta, '$.summaryStale', json('true'))
    ELSE generation_meta END`;

export function saveChapterContentVersioned(
  db: Database.Database,
  novelId: string,
  chapterNumber: number,
  content: string,
  expectedVersion: number,
): { conflict: boolean; version: number } {
  const newVersion = expectedVersion + 1;
  const info = db
    .prepare(
      `UPDATE chapters SET content = ?, word_count = ?, version = ?, ${MARK_SUMMARY_STALE_SET}
       WHERE novel_id = ? AND chapter_number = ? AND version = ?`,
    )
    .run(content, countWords(content), newVersion, novelId, chapterNumber, expectedVersion);
  if (info.changes === 0) return { conflict: true, version: -1 };
  touchNovelUpdatedAt(db, novelId);
  return { conflict: false, version: newVersion };
}

/** Set a chapter's `original_content` snapshot. Sync + db-handle so it can run
 *  inside a transaction (e.g. the unification apply). */
export function setChapterOriginalContent(
  db: Database.Database,
  novelId: string,
  chapterNumber: number,
  originalContent: string,
): void {
  const info = db
    .prepare('UPDATE chapters SET original_content = ? WHERE novel_id = ? AND chapter_number = ?')
    .run(originalContent, novelId, chapterNumber);
  if (info.changes > 0) touchNovelUpdatedAt(db, novelId);
}

export async function updateChapterContent(
  novelId: string,
  chapterNumber: number,
  content: string,
  expectedVersion?: number,
): Promise<{ conflict: boolean; version: number }> {
  const db = getDb();
  const current = db
    .prepare('SELECT content, version FROM chapters WHERE novel_id = ? AND chapter_number = ?')
    .get(novelId, chapterNumber) as { content: string; version: number } | undefined;
  if (!current) return { conflict: true, version: -1 };
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { conflict: true, version: -1 };
  }
  if (current.content === content) {
    return { conflict: false, version: current.version };
  }

  // Manual editor save = human authorship. Emit only on a successful write so a
  // version conflict never produces a phantom progress event. The unification
  // apply path calls saveChapterContentVersioned directly (not this), so it
  // never double-fires a human event here.
  const wordsDelta = countWords(content) - countWords(current.content);
  const emitEdit = () => {
    try {
      recordActivityEvent(db, {
        novelId,
        type: 'chapter_edited',
        source: 'human',
        chapterNumber,
        wordsDelta,
      });
    } catch {
      // Telemetry must never block an editor save.
    }
  };

  if (expectedVersion !== undefined) {
    const res = saveChapterContentVersioned(db, novelId, chapterNumber, content, expectedVersion);
    if (!res.conflict) emitEdit();
    return res;
  }
  // Unconditional write: bump version without a lock predicate.
  const info = db
    .prepare(
      `UPDATE chapters SET content = ?, word_count = ?, version = version + 1, ${MARK_SUMMARY_STALE_SET}
       WHERE novel_id = ? AND chapter_number = ?`,
    )
    .run(content, countWords(content), novelId, chapterNumber);
  if (info.changes === 0) return { conflict: true, version: -1 };
  touchNovelUpdatedAt(db, novelId);
  emitEdit();
  return { conflict: false, version: current.version + 1 };
}

export async function setOriginalContent(
  novelId: string,
  chapterNumber: number,
  originalContent: string,
): Promise<void> {
  setChapterOriginalContent(getDb(), novelId, chapterNumber, originalContent);
}

export async function clearOriginalContent(
  novelId: string,
  chapterNumber: number,
): Promise<void> {
  const db = getDb();
  const info = db.prepare(
    'UPDATE chapters SET original_content = NULL WHERE novel_id = ? AND chapter_number = ?',
  ).run(novelId, chapterNumber);
  if (info.changes > 0) touchNovelUpdatedAt(db, novelId);
}

export async function revertChapterToOriginalContent(
  novelId: string,
  chapterNumber: number,
  expectedVersion: number,
): Promise<{ content: string; version: number; conflict: boolean } | null> {
  const db = getDb();
  const tx = db.transaction(() => {
    const current = db
      .prepare('SELECT content, original_content, version FROM chapters WHERE novel_id = ? AND chapter_number = ?')
      .get(novelId, chapterNumber) as
      | { content: string; original_content: string | null; version: number }
      | undefined;
    if (!current || current.original_content === null) return null;
    if (current.version !== expectedVersion) {
      return { content: '', version: -1, conflict: true };
    }

    const content = current.original_content;
    let version = current.version;
    if (current.content !== content) {
      // Preserve the live draft we're about to discard so revert is never a
      // one-way data loss. Same transaction => atomic with the overwrite.
      appendSafetySnapshot(db, novelId, chapterNumber, current.content, '(before revert)');
      version = current.version + 1;
      const info = db
        .prepare(
          `UPDATE chapters
             SET content = ?, word_count = ?, version = ?, original_content = NULL, ${MARK_SUMMARY_STALE_SET}
           WHERE novel_id = ? AND chapter_number = ? AND version = ?`,
        )
        .run(content, countWords(content), version, novelId, chapterNumber, current.version);
      if (info.changes === 0) {
        return { content: '', version: -1, conflict: true };
      }
      try {
        recordActivityEvent(db, {
          novelId,
          type: 'snapshot_restored',
          source: 'human',
          chapterNumber,
          wordsDelta: countWords(content) - countWords(current.content),
        });
      } catch {
        // Telemetry must never block a revert.
      }
    } else {
      db.prepare(
        'UPDATE chapters SET original_content = NULL WHERE novel_id = ? AND chapter_number = ?',
      ).run(novelId, chapterNumber);
    }
    touchNovelUpdatedAt(db, novelId);
    return { content, version, conflict: false };
  });
  return tx();
}

/**
 * Delete chapter `fromChapter` and every chapter after it for `novelId`.
 * Used by `/blueprint/regenerate?fromChapter=N` to clear stale drafts before
 * re-planning the tail of the outline. Returns the number of rows deleted.
 */
export async function deleteChaptersFrom(
  novelId: string,
  fromChapter: number,
): Promise<number> {
  const db = getDb();
  const tx = db.transaction(() => {
    const deletedRows = db
      .prepare('SELECT id FROM chapters WHERE novel_id = ? AND chapter_number >= ?')
      .all(novelId, fromChapter) as { id: string }[];
    const placeholders = deletedRows.map(() => '?').join(',');
    const deletedIds = deletedRows.map(row => row.id);
    if (deletedRows.length > 0) {
      const now = nowIso();
      db
        .prepare(
          `UPDATE knowledge_entries
              SET data = json_set(${SAFE_DATA_JSON}, '$.chapterId', ''),
                  updated_at = ?
            WHERE novel_id = ?
              AND type = 'outline'
              AND json_extract(${SAFE_DATA_JSON}, '$.chapterId') IN (${placeholders})`,
        )
        .run(now, novelId, ...deletedIds);
      db
        .prepare(
          `UPDATE knowledge_index
              SET data = json_set(${SAFE_DATA_JSON}, '$.chapterId', ''),
                  updated_at = ?
            WHERE novel_id = ?
              AND type = 'outline'
              AND json_extract(${SAFE_DATA_JSON}, '$.chapterId') IN (${placeholders})`,
        )
        .run(now, novelId, ...deletedIds);
    }
    const info = db
      .prepare('DELETE FROM chapters WHERE novel_id = ? AND chapter_number >= ?')
      .run(novelId, fromChapter);
    if (info.changes > 0) touchNovelUpdatedAt(db, novelId);
    return info.changes;
  });
  return tx();
}

function pushJsonColumn(
  setParts: string[],
  values: unknown[],
  column: string,
  versionColumn: string,
  raw: unknown,
  version: number,
): void {
  setParts.push(`${column} = ?`, `${versionColumn} = ?`);
  values.push(toJsonText(raw));
  values.push(raw === null || raw === undefined ? null : version);
}

export async function updateChapterMeta(
  novelId: string,
  chapterNumber: number,
  meta: ChapterMetaUpdate,
): Promise<void> {
  const db = getDb();
  const setParts: string[] = [];
  const values: unknown[] = [];
  if (meta.summary !== undefined) {
    setParts.push('summary = ?');
    values.push(meta.summary);
  }
  if ('keyFacts' in meta) {
    pushJsonColumn(setParts, values, 'key_facts', 'key_facts_v', meta.keyFacts, JSON_COLUMN_VERSIONS.key_facts);
  }
  if ('qualityIssues' in meta) {
    pushJsonColumn(setParts, values, 'quality_issues', 'quality_issues_v', meta.qualityIssues, JSON_COLUMN_VERSIONS.quality_issues);
  }
  if ('generationMeta' in meta) {
    pushJsonColumn(setParts, values, 'generation_meta', 'generation_meta_v', meta.generationMeta, JSON_COLUMN_VERSIONS.generation_meta);
  } else if (meta.summary !== undefined) {
    // A fresh summary supersedes the staleness flag set by content-only
    // writes (markChapterSummaryStale). When the caller replaces the whole
    // generation_meta object the flag is gone anyway; this covers
    // summary-only refreshes.
    setParts.push(
      `generation_meta = CASE WHEN generation_meta IS NULL THEN NULL
        ELSE json_remove(generation_meta, '$.summaryStale') END`,
    );
  }
  if (meta.processingStatus !== undefined) {
    setParts.push('processing_status = ?');
    values.push(meta.processingStatus);
  }
  if (setParts.length === 0) return;

  values.push(novelId, chapterNumber);
  const info = db.prepare(
    `UPDATE chapters SET ${setParts.join(', ')} WHERE novel_id = ? AND chapter_number = ?`,
  ).run(...values);
  if (info.changes > 0) touchNovelUpdatedAt(db, novelId);
}

// ---------- Chapter snapshots (Wave 3 commit 3, schema v8) ----------

function readSnapshots(
  db: Database.Database,
  novelId: string,
  chapterNumber: number,
): { snapshots: ChapterSnapshot[]; originalContent: string | null } | null {
  const row = db
    .prepare(
      'SELECT snapshots, original_content FROM chapters WHERE novel_id = ? AND chapter_number = ?',
    )
    .get(novelId, chapterNumber) as
    | { snapshots: string | null; original_content: string | null }
    | undefined;
  if (!row) return null;
  const list = fromJsonTextLenient<ChapterSnapshot[]>(row.snapshots) ?? [];
  return { snapshots: list, originalContent: row.original_content };
}

function writeSnapshots(
  db: Database.Database,
  novelId: string,
  chapterNumber: number,
  snapshots: ChapterSnapshot[],
): void {
  db.prepare(
    'UPDATE chapters SET snapshots = ? WHERE novel_id = ? AND chapter_number = ?',
  ).run(toJsonText(snapshots), novelId, chapterNumber);
}

/**
 * Synchronously capture `currentContent` as an implicit safety snapshot before a
 * destructive overwrite (restore / revert). MUST be called inside a db.transaction
 * so the capture and the overwrite commit atomically — better-sqlite3 transactions
 * are synchronous, which is why this is deliberately *not* the async
 * {@link createChapterSnapshot}: nesting an async write inside a sync transaction
 * would not be atomic and could lose the draft it is meant to protect.
 *
 * The safety snapshot is appended at the tail, so the SNAPSHOT_MAX eviction (which
 * shifts from the front) can never drop the entry we just created. When the list is
 * empty and an originalContent exists, it is folded in as the first ("first draft")
 * entry — mirroring createChapterSnapshot — so restoring never erases visible history.
 *
 * Skips the append when `currentContent` already equals the most recent stored
 * content (nothing would be lost), but still persists any back-fill so the original
 * draft stays surfaced.
 */
export function appendSafetySnapshot(
  db: Database.Database,
  novelId: string,
  chapterNumber: number,
  currentContent: string,
  label: string,
): void {
  const read = readSnapshots(db, novelId, chapterNumber);
  if (!read) return;

  const next: ChapterSnapshot[] = [];
  const backfilling = read.snapshots.length === 0 && read.originalContent !== null;
  if (backfilling) {
    next.push({
      id: crypto.randomUUID(),
      createdAt: Date.now() - 1, // strictly before the safety snapshot
      label: '',
      content: read.originalContent as string,
    });
  } else {
    next.push(...read.snapshots);
  }

  const latest = next[next.length - 1];
  if (latest && latest.content === currentContent) {
    // Current content is already preserved; only persist a fresh back-fill.
    if (backfilling) {
      while (next.length > SNAPSHOT_MAX) next.shift();
      writeSnapshots(db, novelId, chapterNumber, next);
    }
    return;
  }

  next.push({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    label,
    content: currentContent,
  });
  while (next.length > SNAPSHOT_MAX) next.shift();
  writeSnapshots(db, novelId, chapterNumber, next);
}

/**
 * Create a new manual snapshot of the chapter's current `content`. If the
 * snapshot list is empty and `originalContent` is non-null, fold the
 * originalContent in as the first ("first draft") entry so users see their
 * AI-generated baseline alongside their manual ones — this is a one-time
 * upgrade, not a copy on every write.
 *
 * Returns the new snapshot (the one the user just took, *not* the
 * back-fill). When the list would exceed SNAPSHOT_MAX the oldest entry is
 * evicted.
 */
export async function createChapterSnapshot(
  novelId: string,
  chapterNumber: number,
  label?: string,
): Promise<ChapterSnapshot | null> {
  const db = getDb();
  // Wrap the read-modify-write in a transaction so a concurrent edit can't
  // squeeze between our SELECT of `snapshots` and the writeSnapshots UPDATE,
  // which would silently drop one side's edit. Matches the same pattern
  // used by revertChapterToOriginalContent and the other R-M-W chapter
  // mutators in this file.
  const tx = db.transaction((): ChapterSnapshot | null => {
    const chapterRow = db
      .prepare(
        'SELECT content, original_content, snapshots FROM chapters WHERE novel_id = ? AND chapter_number = ?',
      )
      .get(novelId, chapterNumber) as
      | { content: string; original_content: string | null; snapshots: string | null }
      | undefined;
    if (!chapterRow) return null;

    const existing = fromJsonTextLenient<ChapterSnapshot[]>(chapterRow.snapshots) ?? [];
    const normalizedLabel = (label ?? '').trim().slice(0, 80);
    const latest = existing[existing.length - 1] ?? (
      chapterRow.original_content !== null
        ? {
            id: '__original__',
            createdAt: 0,
            label: '',
            content: chapterRow.original_content,
          }
        : null
    );
    if (latest && latest.content === chapterRow.content && latest.label === normalizedLabel) {
      return latest;
    }

    const next: ChapterSnapshot[] = [];

    // First-snapshot back-fill: preserve the AI-generated "first draft" as the
    // implicit history root so the History drawer is never empty when an
    // originalContent already exists.
    if (existing.length === 0 && chapterRow.original_content !== null) {
      next.push({
        id: crypto.randomUUID(),
        createdAt: Date.now() - 1, // ordered strictly before the new snapshot
        label: '', // empty label -> UI renders "First draft" fallback
        content: chapterRow.original_content,
      });
    } else {
      next.push(...existing);
    }

    const fresh: ChapterSnapshot = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      label: normalizedLabel,
      content: chapterRow.content,
    };
    next.push(fresh);

    // Evict oldest entries when over the cap. Oldest = lowest index.
    while (next.length > SNAPSHOT_MAX) next.shift();

    writeSnapshots(db, novelId, chapterNumber, next);
    touchNovelUpdatedAt(db, novelId);
    return fresh;
  });
  return tx();
}

export async function listChapterSnapshots(
  novelId: string,
  chapterNumber: number,
): Promise<ChapterSnapshot[]> {
  const db = getDb();
  const read = readSnapshots(db, novelId, chapterNumber);
  if (!read) return [];
  // Surface originalContent as an implicit first-draft entry when the user
  // hasn't taken any explicit snapshot yet, so the History drawer can offer
  // "Restore first draft" even pre-back-fill.
  if (read.snapshots.length === 0 && read.originalContent !== null) {
    return [
      {
        id: `__original__`,
        createdAt: 0,
        label: '',
        content: read.originalContent,
      },
    ];
  }
  return read.snapshots;
}

/**
 * Restore the chapter's content to a snapshot. Looks up the snapshot by id
 * across both the persisted list and the synthetic `__original__` entry
 * surfaced by {@link listChapterSnapshots}. Bumps the chapter version so
 * concurrent editors see a conflict.
 *
 * Returns the new content + version on success, or null if either the
 * chapter or the snapshot id can't be found.
 */
export async function restoreChapterSnapshot(
  novelId: string,
  chapterNumber: number,
  snapshotId: string,
  expectedVersion?: number,
): Promise<{ content: string; version: number; conflict: boolean } | null> {
  const db = getDb();
  // Whole operation runs in one synchronous transaction so that capturing the
  // current draft as a safety snapshot and overwriting it with the restored
  // content commit atomically. The previous version called the async
  // updateChapterContent *after* reading snapshots outside any transaction,
  // which (a) wasn't atomic and (b) discarded the live draft outright — losing
  // any edits the user hadn't separately snapshotted.
  const tx = db.transaction((): { content: string; version: number; conflict: boolean } | null => {
    const read = readSnapshots(db, novelId, chapterNumber);
    if (!read) return null;

    let restoreContent: string | null = null;
    if (snapshotId === '__original__') {
      restoreContent = read.originalContent;
    } else {
      const hit = read.snapshots.find(s => s.id === snapshotId);
      if (hit) restoreContent = hit.content;
    }
    if (restoreContent === null) return null;

    // Re-read content + version inside the transaction for the optimistic lock.
    const current = db
      .prepare('SELECT content, version FROM chapters WHERE novel_id = ? AND chapter_number = ?')
      .get(novelId, chapterNumber) as { content: string; version: number } | undefined;
    if (!current) return null;
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      return { content: '', version: -1, conflict: true };
    }

    // No-op restore: content already matches the target. Match updateChapterContent
    // — don't bump the version and don't write a safety snapshot (nothing is lost).
    if (current.content === restoreContent) {
      return { content: restoreContent, version: current.version, conflict: false };
    }

    appendSafetySnapshot(db, novelId, chapterNumber, current.content, '(before restore)');

    const newVersion = current.version + 1;
    const info = db
      .prepare(
        `UPDATE chapters SET content = ?, word_count = ?, version = ?, ${MARK_SUMMARY_STALE_SET}
         WHERE novel_id = ? AND chapter_number = ? AND version = ?`,
      )
      .run(restoreContent, countWords(restoreContent), newVersion, novelId, chapterNumber, current.version);
    if (info.changes === 0) {
      return { content: '', version: -1, conflict: true };
    }
    touchNovelUpdatedAt(db, novelId);
    try {
      recordActivityEvent(db, {
        novelId,
        type: 'snapshot_restored',
        source: 'human',
        chapterNumber,
        wordsDelta: countWords(restoreContent) - countWords(current.content),
      });
    } catch {
      // Telemetry must never block a restore.
    }
    return { content: restoreContent, version: newVersion, conflict: false };
  });
  return tx();
}

export async function getMessages(novelId: string): Promise<Message[]> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM messages WHERE novel_id = ? AND conversation_id IS NULL ORDER BY created_at ASC, rowid ASC')
    .all(novelId) as Record<string, unknown>[];
  return rows.map(r =>
    mapMessage({
      id: r.id as string,
      novel_id: r.novel_id as string,
      role: r.role as string,
      content: r.content as string,
      conversation_id: (r.conversation_id as string | null) ?? null,
      created_at: r.created_at as string,
    }),
  );
}

export async function addMessage(
  novelId: string,
  role: Message['role'],
  content: string,
  conversationId?: string | null,
): Promise<Message> {
  const db = getDb();
  const now = nowIso();
  const id = crypto.randomUUID();

  const tx = db.transaction(() => {
    if (conversationId) {
      const conversation = db
        .prepare('SELECT id FROM conversations WHERE id = ? AND novel_id = ?')
        .get(conversationId, novelId);
      if (!conversation) throw new Error('Conversation not found');
    }

    db.prepare(
      `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, novelId, role, content, conversationId ?? null, now);
    if (conversationId) {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND novel_id = ?')
        .run(now, conversationId, novelId);
    }
    touchNovelUpdatedAt(db, novelId);
  });
  tx();

  return mapMessage({
    id,
    novel_id: novelId,
    role,
    content,
    conversation_id: conversationId ?? null,
    created_at: now,
  });
}

export async function addMessageWithId(
  novelId: string,
  id: string,
  role: Message['role'],
  content: string,
  conversationId?: string | null,
): Promise<Message> {
  const db = getDb();
  const conversationIdValue = conversationId ?? null;
  const now = nowIso();

  return db.transaction(() => {
    if (conversationIdValue) {
      const conversation = db
        .prepare('SELECT id FROM conversations WHERE id = ? AND novel_id = ?')
        .get(conversationIdValue, novelId);
      if (!conversation) throw new Error('Conversation not found');
    }

    const write = db.prepare(
      `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(id, novelId, role, content, conversationIdValue, now);

    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error('Message insert failed');
    }

    const existingRole = row.role as Message['role'];
    const existingConversationId = (row.conversation_id as string | null) ?? null;
    if (
      row.novel_id !== novelId
      || existingRole !== role
      || row.content !== content
      || existingConversationId !== conversationIdValue
    ) {
      throw new Error('Message id collision');
    }

    if (write.changes > 0) {
      if (conversationIdValue) {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND novel_id = ?')
          .run(now, conversationIdValue, novelId);
      }
      touchNovelUpdatedAt(db, novelId);
    }

    return mapMessage({
      id: row.id as string,
      novel_id: row.novel_id as string,
      role: existingRole,
      content: row.content as string,
      conversation_id: existingConversationId,
      created_at: row.created_at as string,
    });
  })();
}

/**
 * Append a user turn and its assistant reply atomically. Either both rows land
 * or neither does — prevents one-sided turns when a provider buffers the whole
 * reply and no streaming chunk has already triggered the lazy user insert.
 */
export async function addMessagePair(
  novelId: string,
  userContent: string,
  assistantContent: string,
  conversationId?: string | null,
): Promise<{ user: Message; assistant: Message }> {
  const db = getDb();
  const now = nowIso();
  const rows = [
    { role: 'user' as const, content: userContent },
    { role: 'assistant' as const, content: assistantContent },
  ].map(r => ({ ...r, id: crypto.randomUUID() }));

  const insert = db.prepare(
    `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    if (conversationId) {
      const conversation = db
        .prepare('SELECT id FROM conversations WHERE id = ? AND novel_id = ?')
        .get(conversationId, novelId);
      if (!conversation) throw new Error('Conversation not found');
    }
    for (const r of rows) insert.run(r.id, novelId, r.role, r.content, conversationId ?? null, now);
    if (conversationId) {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND novel_id = ?')
        .run(now, conversationId, novelId);
    }
    touchNovelUpdatedAt(db, novelId);
  })();

  const [user, assistant] = rows.map(r =>
    mapMessage({
      id: r.id,
      novel_id: novelId,
      role: r.role,
      content: r.content,
      conversation_id: conversationId ?? null,
      created_at: now,
    }),
  );
  return { user, assistant };
}

export async function deleteUserMessage(novelId: string, messageId: string): Promise<void> {
  const db = getDb();

  db.transaction(() => {
    const row = db
      .prepare('SELECT conversation_id FROM messages WHERE id = ? AND novel_id = ? AND role = ?')
      .get(messageId, novelId, 'user') as { conversation_id: string | null } | undefined;
    if (!row) return;

    db.prepare('DELETE FROM messages WHERE id = ? AND novel_id = ? AND role = ?')
      .run(messageId, novelId, 'user');

    if (row.conversation_id) {
      const latest = db
        .prepare(
          `SELECT created_at FROM messages
           WHERE novel_id = ? AND conversation_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .get(novelId, row.conversation_id) as { created_at: string } | undefined;
      const fallback = db
        .prepare('SELECT created_at FROM conversations WHERE id = ? AND novel_id = ?')
        .get(row.conversation_id, novelId) as { created_at: string } | undefined;
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND novel_id = ?')
        .run(latest?.created_at ?? fallback?.created_at ?? nowIso(), row.conversation_id, novelId);
    }

    touchNovelUpdatedAt(db, novelId);
  })();
}

export async function getChatHistory(
  novelId: string,
  chapterNumber: number,
  limit = CHAT_HISTORY_KEEP,
) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM chapter_chat_history
       WHERE novel_id = ? AND chapter_number = ?
         AND role IN ('user', 'assistant')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(novelId, chapterNumber, limit) as Record<string, unknown>[];

  return rows.reverse().map(row => ({
    id: row.id as string,
    novelId: row.novel_id as string,
    chapterNumber: row.chapter_number as number,
    role: row.role as string,
    content: row.content as string,
    changes: (row.changes as string | null) ?? null,
    status: row.status as string,
    createdAt: parseTimestamp(row.created_at as string),
  }));
}

export async function addChatMessage(
  novelId: string,
  chapterNumber: number,
  message: { role: string; content: string; changes?: string; status?: string },
) {
  const db = getDb();
  const createdAt = nowIso();
  const [row] = createChapterChatRows([message]);

  const tx = db.transaction(() => {
    insertChapterChatRows(db, novelId, chapterNumber, [row], createdAt);
  });
  tx();

  return { id: row.id, createdAt: parseTimestamp(createdAt) };
}

export async function addChatMessagePair(
  novelId: string,
  chapterNumber: number,
  userMessage: { role: 'user'; content: string; changes?: string; status?: string },
  assistantMessage: { role: 'assistant'; content: string; changes?: string; status?: string },
) {
  return addChatMessagePairSync(getDb(), novelId, chapterNumber, userMessage, assistantMessage);
}

/**
 * Synchronous chat-pair insert that takes the db handle so a caller can fold it
 * into a wider transaction (e.g. the edit route persists originalContent +
 * chat pair atomically so a crash can't leave one without the other). Mirrors
 * {@link addChatMessagePair} exactly, including the keep-trim. The body runs in
 * its own transaction; when called inside a caller's transaction it becomes a
 * nested SAVEPOINT (better-sqlite3 re-entrant), so it still joins the outer txn.
 */
export function addChatMessagePairSync(
  db: ReturnType<typeof getDb>,
  novelId: string,
  chapterNumber: number,
  userMessage: { role: 'user'; content: string; changes?: string; status?: string },
  assistantMessage: { role: 'assistant'; content: string; changes?: string; status?: string },
) {
  const createdAt = nowIso();
  const rows = createChapterChatRows([userMessage, assistantMessage]);

  const tx = db.transaction(() => {
    insertChapterChatRows(db, novelId, chapterNumber, rows, createdAt);
  });
  tx();

  return {
    user: { id: rows[0].id, createdAt: parseTimestamp(createdAt) },
    assistant: { id: rows[1].id, createdAt: parseTimestamp(createdAt) },
  };
}

/** Opaque `changes` marker binding a chat pair to an edit runId (no schema migration). */
export function editRunChangesKey(runId: string): string {
  return `edit-run:${runId}`;
}

export type TerminalEditChatStatus = 'done' | 'cancelled';

export type TerminalEditChatPairResult = {
  outcome: 'inserted' | 'existing';
  status: TerminalEditChatStatus;
};

const EDIT_TERMINAL_ROLE = 'edit_terminal';

function trimChapterChatHistory(
  db: ReturnType<typeof getDb>,
  novelId: string,
  chapterNumber: number,
) {
  const keepRows = db
    .prepare(
      `SELECT id, changes FROM chapter_chat_history
       WHERE novel_id = ? AND chapter_number = ?
         AND role IN ('user', 'assistant')
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(novelId, chapterNumber, CHAT_HISTORY_KEEP) as Array<{
      id: string;
      changes: string | null;
    }>;

  if (keepRows.length < CHAT_HISTORY_KEEP) return;

  // Never leave half of a terminal pair at the retention boundary. If only one
  // row for a run is in the newest 50, drop that half too; the compact
  // edit_terminal tombstone remains outside transcript retention and preserves
  // the first-winner/idempotency decision indefinitely.
  const runKeyCounts = new Map<string, number>();
  for (const row of keepRows) {
    if (row.changes?.startsWith('edit-run:')) {
      runKeyCounts.set(row.changes, (runKeyCounts.get(row.changes) ?? 0) + 1);
    }
  }
  const splitRunKeys = new Set(
    [...runKeyCounts.entries()]
      .filter(([, count]) => count === 1)
      .map(([key]) => key),
  );
  const keepIds = keepRows
    .filter(row => !row.changes || !splitRunKeys.has(row.changes))
    .map(row => row.id);
  const roleFilter = "role IN ('user', 'assistant')";
  if (keepIds.length === 0) {
    db.prepare(
      `DELETE FROM chapter_chat_history
       WHERE novel_id = ? AND chapter_number = ? AND ${roleFilter}`,
    ).run(novelId, chapterNumber);
    return;
  }
  const placeholders = keepIds.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM chapter_chat_history
     WHERE novel_id = ? AND chapter_number = ? AND ${roleFilter}
       AND id NOT IN (${placeholders})`,
  ).run(novelId, chapterNumber, ...keepIds);
}

type ChapterChatMessageInput = {
  role: string;
  content: string;
  changes?: string;
  status?: string;
};

type ChapterChatInsertRow = ChapterChatMessageInput & { id: string };

function createChapterChatRows(
  messages: readonly ChapterChatMessageInput[],
  changes?: string,
): ChapterChatInsertRow[] {
  return messages.map(message => ({
    ...message,
    ...(changes === undefined ? {} : { changes }),
    id: crypto.randomUUID(),
  }));
}

function insertChapterChatRows(
  db: ReturnType<typeof getDb>,
  novelId: string,
  chapterNumber: number,
  rows: readonly ChapterChatInsertRow[],
  createdAt: string,
) {
  const insert = db.prepare(
    `INSERT INTO chapter_chat_history (
       id, novel_id, chapter_number, role, content, changes, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.id,
      novelId,
      chapterNumber,
      row.role,
      row.content,
      row.changes ?? null,
      row.status ?? 'pending',
      createdAt,
    );
  }
  trimChapterChatHistory(db, novelId, chapterNumber);
}

function readTerminalEditChatPairByRunId(
  db: ReturnType<typeof getDb>,
  novelId: string,
  chapterNumber: number,
  runId: string,
): TerminalEditChatPairResult | null {
  const rows = db
    .prepare(
      `SELECT role, status
       FROM chapter_chat_history
       WHERE novel_id = ? AND chapter_number = ? AND changes = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(novelId, chapterNumber, editRunChangesKey(runId)) as Array<{
      role: string;
      status: string;
    }>;

  if (rows.length === 0) return null;
  const markers = rows.filter(row => row.role === EDIT_TERMINAL_ROLE);
  if (markers.length !== 1) {
    throw new Error('Corrupt terminal edit marker');
  }
  const marker = markers[0];
  if (marker.status !== 'done' && marker.status !== 'cancelled') {
    throw new Error('Corrupt terminal edit marker status');
  }

  const messages = rows.filter(row => row.role === 'user' || row.role === 'assistant');
  if (rows.length !== markers.length + messages.length) {
    throw new Error('Corrupt terminal edit chat pair');
  }

  // Retention removes both transcript rows together, leaving the tombstone.
  if (messages.length === 0) {
    return { outcome: 'existing', status: marker.status };
  }
  if (messages.length !== 2) {
    throw new Error('Corrupt terminal edit chat pair');
  }
  const users = messages.filter(row => row.role === 'user');
  const assistants = messages.filter(row => row.role === 'assistant');
  if (users.length !== 1 || assistants.length !== 1) {
    throw new Error('Corrupt terminal edit chat pair roles');
  }
  const [user] = users;
  const [assistant] = assistants;
  if (
    user.status !== marker.status
    || assistant.status !== marker.status
  ) {
    throw new Error('Corrupt terminal edit chat pair status');
  }
  return { outcome: 'existing', status: marker.status };
}

/**
 * Idempotent terminal edit-chat pair write keyed by runId.
 * Successful (`done`) and cancelled pairs for the same run cannot both land —
 * whichever durable terminal state commits first wins and is returned.
 */
export function commitTerminalEditChatPairSync(
  db: ReturnType<typeof getDb>,
  novelId: string,
  chapterNumber: number,
  runId: string,
  userMessage: { role: 'user'; content: string; status: TerminalEditChatStatus },
  assistantMessage: { role: 'assistant'; content: string; status: TerminalEditChatStatus },
): TerminalEditChatPairResult {
  if (userMessage.status !== assistantMessage.status) {
    throw new Error('Terminal edit chat pair status mismatch');
  }
  const tx = db.transaction(() => {
    const existing = readTerminalEditChatPairByRunId(db, novelId, chapterNumber, runId);
    if (existing) return existing;

    const createdAt = nowIso();
    const runKey = editRunChangesKey(runId);
    const rows = createChapterChatRows([
      { role: EDIT_TERMINAL_ROLE, content: '', status: userMessage.status },
      userMessage,
      assistantMessage,
    ], runKey);
    insertChapterChatRows(db, novelId, chapterNumber, rows, createdAt);

    return {
      outcome: 'inserted' as const,
      status: userMessage.status,
    };
  });
  return tx();
}
