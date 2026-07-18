'use server';

// Manuscript import server actions (W2-1). Node runtime only — these parse
// uploaded bytes and write SQLite via better-sqlite3.
//
//   parseImportedFile  — base64 file bytes → RawDocument → ChapterCandidate[]
//                        (+ dedupe report when importing into an existing novel).
//   importPlanToNovel  — transact a corrected ImportPlan into a NEW or EXISTING
//                        novel: create/select, upsert chapters (safety-snapshot
//                        before any merge overwrite), write importMeta, jump
//                        stage to autonomous_writing.
//
// KB extraction is NOT done here — it runs in the /api/novels/[id]/import/
// extract-knowledge route (needs the request's x-im-* model headers and must
// stream/cancel independently of this synchronous write).

import { getUser } from '@/lib/local-auth';
import { getDb } from '@/lib/db/connection';
import { createNovel, getNovel, verifyNovelOwnership } from '@/lib/db';
import { getChapters } from '@/lib/db';
import { appendSafetySnapshot } from '@/lib/db/queries-chapter';
import { recordActivityEvent } from '@/lib/db/queries-activity';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';
import { toJsonText } from '@/lib/db/json-columns';
import { countWords, nowIso } from '@/lib/utils';

import { detectChapters } from '@/lib/import/detect-chapters';
import { dedupeCandidates } from '@/lib/import/dedupe';
import { parseText, sourceFromFilename } from '@/lib/import/parse-text';
import { parseDocx } from '@/lib/import/parse-docx';
import type {
  ChapterCandidate,
  DedupeDecision,
  DedupeResult,
  ImportPlan,
  ImportSource,
} from '@/lib/import/types';

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — matches the Rust-side cap intent.

export interface ParseImportedFileInput {
  /** Original filename (extension decides the parser). */
  filename: string;
  /** Raw file bytes, base64-encoded (from `readLocalFile`). */
  contentsBase64: string;
  /** When set, also run the merge dedupe report against this novel's chapters. */
  targetNovelId?: string;
}

export interface ParseImportedFileResult {
  source: ImportSource;
  filename: string;
  /** Suggested novel title from the filename (sans extension). */
  suggestedTitle: string;
  candidates: ChapterCandidate[];
  /** Present only when `targetNovelId` was given (merge preview). */
  dedupe?: DedupeResult[];
}

/**
 * Decode + parse an imported file into preview candidates. Pure read — writes
 * nothing. Throws a user-facing Error on an unreadable/empty/oversized file so
 * the wizard can surface it (rather than silently importing nothing).
 */
export async function parseImportedFile(
  input: ParseImportedFileInput,
): Promise<ParseImportedFileResult> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const filename = (input.filename ?? '').trim() || 'manuscript';
  const source = sourceFromFilename(filename);

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.contentsBase64 ?? '', 'base64');
  } catch {
    throw new Error('Could not decode the selected file.');
  }
  if (bytes.length === 0) throw new Error('The selected file is empty.');
  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error('The selected file is too large to import (max 25 MB).');
  }

  const doc =
    source === 'docx'
      ? await parseDocx(bytes, filename)
      : parseText(bytes.toString('utf-8'), filename, source === 'md' ? 'md' : 'txt');

  const candidates = detectChapters(doc);
  if (candidates.length === 0 || candidates.every(c => c.content.trim() === '')) {
    throw new Error('No readable text was found in the file.');
  }

  const suggestedTitle = filename.replace(/\.[^./\\]+$/, '').trim() || 'Imported manuscript';

  let dedupe: DedupeResult[] | undefined;
  if (input.targetNovelId) {
    await verifyNovelOwnership(input.targetNovelId, user.id);
    const existing = await getChapters(input.targetNovelId);
    dedupe = dedupeCandidates(
      candidates,
      existing.map(c => ({ chapterNumber: c.chapterNumber, title: c.title, content: c.content })),
    );
  }

  return { source, filename, suggestedTitle, candidates, dedupe };
}

export interface ImportPlanToNovelInput {
  plan: ImportPlan;
  mode: 'new' | 'merge';
  /** Required when `mode === 'merge'`. */
  targetNovelId?: string;
  /** Per-chapter merge decisions (merge mode only); keyed by chapter number. */
  dedupeDecisions?: DedupeDecision[];
}

export interface ImportPlanToNovelResult {
  novelId: string;
  /** Chapters actually written (new + overwritten + appended). */
  importedChapters: number;
  /** Chapters skipped per the user's dedupe decision. */
  skippedChapters: number;
}

/**
 * Transact the corrected plan into a novel. NEW mode creates a novel (stage
 * jumps straight to autonomous_writing — an existing manuscript skips the
 * discovery interview). MERGE mode writes into an owned novel, honoring each
 * chapter's dedupe action (skip / overwrite / append) and snapshotting any
 * chapter it overwrites so the merge is reversible.
 *
 * Returns `importMeta` already persisted with kbExtraction:'pending' when the
 * caller plans to run extraction next (the route flips it to done/failed).
 */
export async function importPlanToNovel(
  input: ImportPlanToNovelInput & { runKbExtraction?: boolean },
): Promise<ImportPlanToNovelResult> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const { plan } = input;
  if (!plan || !Array.isArray(plan.chapters) || plan.chapters.length === 0) {
    throw new Error('Nothing to import.');
  }

  // Resolve the target novel up front (outside the write transaction, since
  // createNovel runs its own transaction).
  let novelId: string;
  if (input.mode === 'merge') {
    if (!input.targetNovelId) throw new Error('A target novel is required to merge.');
    const novel = await verifyNovelOwnership(input.targetNovelId, user.id);
    novelId = novel.id;
  } else {
    const created = await createNovel({
      userId: user.id,
      title: (plan.novelTitle ?? '').trim() || 'Imported manuscript',
    });
    novelId = created.id;
  }

  const decisionByNumber = new Map(
    (input.dedupeDecisions ?? []).map(d => [d.chapterNumber, d.action]),
  );

  const db = getDb();
  const now = nowIso();

  // Read the current settings up front so the importMeta/stage write can land
  // inside the chapter transaction (see below) rather than as a separate write
  // that could fail after chapters committed.
  const novelBefore = await getNovel(novelId);
  const baseSettings = { ...(novelBefore?.settings ?? {}) };
  const progressValue = input.mode === 'new' ? 100 : (novelBefore?.progress ?? 0);

  const insertSql = db.prepare(
    `INSERT INTO chapters (
       id, novel_id, chapter_number, title, content, original_content,
       word_count, version, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(novel_id, chapter_number) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       original_content = NULL,
       word_count = excluded.word_count,
       version = COALESCE(chapters.version, 0) + 1`,
  );

  // Run all chapter writes + the importMeta/stage update in ONE transaction so a
  // failure mid-import leaves the novel untouched (or, for NEW mode, an empty
  // shell the user can delete) rather than a half-written manuscript.
  let imported = 0;
  let skipped = 0;

  const write = db.transaction(() => {
    // Snapshot existing chapter numbers for merge-mode overwrite detection.
    const existingNumbers = new Map<number, { content: string }>();
    if (input.mode === 'merge') {
      const rows = db
        .prepare('SELECT chapter_number, content FROM chapters WHERE novel_id = ?')
        .all(novelId) as { chapter_number: number; content: string }[];
      for (const r of rows) existingNumbers.set(r.chapter_number, { content: r.content });
    }

    // For merge/append we must not collide with existing chapter numbers; track
    // the next free slot for appended chapters.
    let nextAppendNumber = input.mode === 'merge'
      ? Math.max(0, ...Array.from(existingNumbers.keys())) + 1
      : 1;

    for (const chapter of plan.chapters) {
      const action = input.mode === 'merge'
        ? decisionByNumber.get(chapter.chapterNumber) ?? 'append'
        : 'append';

      if (input.mode === 'merge' && action === 'skip') {
        skipped++;
        continue;
      }

      let targetNumber: number;
      if (input.mode === 'merge' && action === 'overwrite') {
        // Overwrite the matched existing chapter number. Snapshot its current
        // content first so the merge is reversible.
        targetNumber = chapter.chapterNumber;
        const existing = existingNumbers.get(targetNumber);
        if (existing) {
          appendSafetySnapshot(db, novelId, targetNumber, existing.content, '(before import)');
        }
      } else if (input.mode === 'merge') {
        // append — land on the next free slot regardless of the candidate's
        // own number so two appended chapters can't collide.
        targetNumber = nextAppendNumber++;
      } else {
        // new mode — contiguous numbering from 1.
        targetNumber = chapter.chapterNumber;
      }

      const content = chapter.content ?? '';
      const prev = db
        .prepare('SELECT word_count FROM chapters WHERE novel_id = ? AND chapter_number = ?')
        .get(novelId, targetNumber) as { word_count: number } | undefined;
      const prevWords = prev?.word_count ?? 0;
      const wordCount = countWords(content);

      insertSql.run(
        crypto.randomUUID(),
        novelId,
        targetNumber,
        chapter.title || `Chapter ${targetNumber}`,
        content,
        null,
        wordCount,
        0,
        now,
      );
      imported++;

      try {
        recordActivityEvent(db, {
          novelId,
          type: 'chapter_written',
          source: 'human',
          chapterNumber: targetNumber,
          wordsDelta: wordCount - prevWords,
          meta: { imported: true },
        });
      } catch {
        // Telemetry must never block an import.
      }
    }

    // importMeta + stage jump land in the SAME transaction as the chapters, so a
    // failure can never leave a half-imported novel stuck in the interview flow
    // with chapters silently present. `settings` has no version column, so a raw
    // UPDATE mirrors updateNovel's settings write exactly. An imported manuscript
    // is finished prose — skip discovery and land in the autonomous workspace.
    const settings = {
      ...baseSettings,
      importMeta: {
        source: plan.source,
        importedAt: now,
        originalFilename: plan.filename,
        detectedChapters: imported,
        ...(input.runKbExtraction ? { kbExtraction: 'pending' as const } : {}),
      },
    };
    db.prepare(
      'UPDATE novels SET settings = ?, stage = ?, progress = ?, updated_at = ? WHERE id = ?',
    ).run(toJsonText(settings), 'autonomous_writing', progressValue, now, novelId);
    touchNovelUpdatedAt(db, novelId);
  });

  write();

  return { novelId, importedChapters: imported, skippedChapters: skipped };
}
