import { getUser } from '@/lib/local-auth';
import { getDb } from '@/lib/db/connection';
import { getChapters, verifyNovelOwnership } from '@/lib/db';
import { appendSafetySnapshot } from '@/lib/db/queries-chapter';
import { recordActivityEvent } from '@/lib/db/queries-activity';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';
import { toJsonText } from '@/lib/db/json-columns';
import { countWords, nowIso } from '@/lib/utils';
import { dedupeCandidates } from '@/lib/import/dedupe';
import {
  MAX_IMPORT_CHAPTERS,
  MAX_IMPORT_PARTS,
  MAX_IMPORT_NOVEL_TITLE_CHARS,
  MAX_IMPORT_RECONSTRUCTED_BYTES,
  MAX_IMPORT_TITLE_CHARS,
} from '@/lib/import/limits';
import { reconstructChaptersFromParts } from '@/lib/import/reconstruct';
import {
  loadImportSession,
  removeImportSession,
} from '@/lib/import/session-store';
import type {
  DedupeAction,
  DedupeDecision,
  ImportChapterRef,
  ImportSource,
} from '@/lib/import/types';

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

export interface ConfirmImportSessionInput {
  sessionToken: string;
  mode: 'new' | 'merge';
  targetNovelId?: string;
  novelTitle: string;
  /** Compact chapter refs — server reconstructs exact prose. */
  chapters: ImportChapterRef[];
  /** Per-chapter merge decisions keyed by 1-based chapter number after renumber. */
  dedupeDecisions?: DedupeDecision[];
  runKbExtraction?: boolean;
}

export interface ConfirmImportSessionResult {
  novelId: string;
  importedChapters: number;
  skippedChapters: number;
}

function assertMergeDedupeDecisions(
  chapterCount: number,
  decisions: DedupeDecision[] | undefined,
): Map<number, DedupeDecision> {
  if (!decisions) {
    throw new Error('Merge import requires an explicit dedupe decision for every chapter.');
  }
  if (decisions.length !== chapterCount) {
    throw new Error('Merge import requires an explicit dedupe decision for every chapter.');
  }

  const decisionByNumber = new Map<number, DedupeDecision>();
  const overwriteTargets = new Set<number>();
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object') {
      throw new Error('Merge import dedupe decisions are incomplete or invalid.');
    }
    if (!Number.isInteger(decision.chapterNumber) || decision.chapterNumber <= 0) {
      throw new Error('Merge import dedupe decisions are incomplete or invalid.');
    }
    if (decision.chapterNumber > chapterCount) {
      throw new Error('Merge import includes a dedupe decision outside the import plan.');
    }
    if (decisionByNumber.has(decision.chapterNumber)) {
      throw new Error('Merge import includes duplicate dedupe decisions for the same chapter.');
    }
    if (
      decision.action !== 'skip'
      && decision.action !== 'overwrite'
      && decision.action !== 'append'
    ) {
      throw new Error('Merge import dedupe decisions are incomplete or invalid.');
    }
    if (
      decision.matchedChapterNumber !== null
      && (
        !Number.isInteger(decision.matchedChapterNumber)
        || decision.matchedChapterNumber <= 0
      )
    ) {
      throw new Error('Merge import dedupe decisions are incomplete or invalid.');
    }
    if (decision.action === 'overwrite') {
      if (decision.matchedChapterNumber === null) {
        throw new Error('Merge import cannot overwrite without a matched target chapter.');
      }
      if (overwriteTargets.has(decision.matchedChapterNumber)) {
        throw new Error('Merge import cannot overwrite the same target chapter twice.');
      }
      overwriteTargets.add(decision.matchedChapterNumber);
    }
    decisionByNumber.set(decision.chapterNumber, decision);
  }

  for (let n = 1; n <= chapterCount; n++) {
    if (!decisionByNumber.has(n)) {
      throw new Error('Merge import requires an explicit dedupe decision for every chapter.');
    }
  }

  return decisionByNumber;
}

function assertCompactChapters(chapters: ImportChapterRef[]): void {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new Error('Nothing to import.');
  }
  if (chapters.length > MAX_IMPORT_CHAPTERS) {
    throw new Error('Too many chapters to import.');
  }
  let partCount = 0;
  for (const ch of chapters) {
    if (!ch || typeof ch !== 'object') throw new Error('Import chapter descriptor is invalid.');
    if (
      typeof ch.title !== 'string'
      || ch.title.length > MAX_IMPORT_TITLE_CHARS
      || CONTROL_CHAR_RE.test(ch.title)
    ) {
      throw new Error('A chapter title is too long.');
    }
    if (!Array.isArray(ch.parts) || ch.parts.length === 0) {
      throw new Error('Each imported chapter must reference at least one segment part.');
    }
    partCount += ch.parts.length;
    if (partCount > MAX_IMPORT_PARTS) {
      throw new Error('Import plan contains too many segment parts.');
    }
  }
}

/**
 * Confirm an opaque import session. Reconstructs prose server-side, writes
 * novel + chapters + settings/activity/importMeta in one SQLite transaction
 * (new mode creates no empty shell on failure), and removes the session only
 * after a successful commit.
 */
export async function confirmImportSession(
  input: ConfirmImportSessionInput,
): Promise<ConfirmImportSessionResult> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  if (input.mode !== 'new' && input.mode !== 'merge') {
    throw new Error('Import mode is invalid.');
  }

  if (
    input.runKbExtraction !== undefined
    && typeof input.runKbExtraction !== 'boolean'
  ) {
    throw new Error('Knowledge extraction preference is invalid.');
  }
  if (
    input.mode === 'merge'
    && (typeof input.targetNovelId !== 'string' || !input.targetNovelId.trim())
  ) {
    throw new Error('A target novel is required to merge.');
  }

  const novelTitle = typeof input.novelTitle === 'string'
    ? input.novelTitle.trim() || 'Imported manuscript'
    : 'Imported manuscript';
  if (
    novelTitle.length > MAX_IMPORT_NOVEL_TITLE_CHARS
    || CONTROL_CHAR_RE.test(novelTitle)
  ) {
    throw new Error('Novel title is too long.');
  }

  assertCompactChapters(input.chapters);

  const session = loadImportSession(input.sessionToken);
  const source: ImportSource = session.source;
  if (source !== 'txt' && source !== 'md' && source !== 'docx') {
    throw new Error('Import source is invalid.');
  }

  const planChapters = reconstructChaptersFromParts(session.segments, input.chapters);
  // Approximate serialized size — reject pathological reconstructions.
  const approxBytes = planChapters.reduce(
    (sum, c) => sum + Buffer.byteLength(c.content, 'utf8') + Buffer.byteLength(c.title, 'utf8'),
    0,
  );
  if (approxBytes > MAX_IMPORT_RECONSTRUCTED_BYTES) {
    throw new Error('Reconstructed manuscript exceeds the import size limit.');
  }

  const decisionByNumber = input.mode === 'merge'
    ? assertMergeDedupeDecisions(planChapters.length, input.dedupeDecisions)
    : new Map<number, DedupeDecision>();

  if (input.mode === 'merge') {
    if (!input.targetNovelId) throw new Error('A target novel is required to merge.');
    await verifyNovelOwnership(input.targetNovelId, user.id);
  }

  const db = getDb();
  const now = nowIso();

  let imported = 0;
  let skipped = 0;
  let novelId = '';

  const write = db.transaction(() => {
    if (input.mode === 'merge') {
      novelId = input.targetNovelId!;
    } else {
      // Create the novel INSIDE this transaction so a later failure rolls back
      // the empty shell together with any chapter writes.
      novelId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO novels (
           id, user_id, title, genre, target_words, stage, progress,
           story_summary, character_summary, arc_summary,
           interview_state, interview_state_v,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        novelId,
        user.id,
        novelTitle,
        '',
        80000,
        'discovery_interview',
        0,
        '',
        '',
        '',
        null,
        null,
        now,
        now,
      );
    }

    const novelBefore = db
      .prepare('SELECT settings, progress FROM novels WHERE id = ?')
      .get(novelId) as { settings: string | null; progress: number } | undefined;
    if (!novelBefore) {
      throw new Error('Target novel was not found.');
    }

    let baseSettings: Record<string, unknown> = {};
    if (novelBefore.settings) {
      try {
        baseSettings = JSON.parse(novelBefore.settings) as Record<string, unknown>;
      } catch {
        baseSettings = {};
      }
    }
    const progressValue = input.mode === 'new' ? 100 : (novelBefore.progress ?? 0);

    const insertSql = db.prepare(
      `INSERT INTO chapters (
         id, novel_id, chapter_number, title, content, original_content,
         word_count, version, processing_status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(novel_id, chapter_number) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         original_content = NULL,
         word_count = excluded.word_count,
         version = COALESCE(chapters.version, 0) + 1,
         processing_status = excluded.processing_status`,
    );

    const existingNumbers = new Map<number, { title: string; content: string }>();
    if (input.mode === 'merge') {
      const rows = db
        .prepare('SELECT chapter_number, title, content FROM chapters WHERE novel_id = ?')
        .all(novelId) as { chapter_number: number; title: string; content: string }[];
      for (const r of rows) {
        existingNumbers.set(r.chapter_number, { title: r.title, content: r.content });
      }
      const serverReport = dedupeCandidates(
        planChapters.map(chapter => ({
          id: String(chapter.chapterNumber),
          chapterNumber: chapter.chapterNumber,
          title: chapter.title,
          volumeTitle: null,
          content: chapter.content,
          wordCount: countWords(chapter.content),
          inferred: false,
        })),
        rows.map(row => ({
          chapterNumber: row.chapter_number,
          title: row.title,
          content: row.content,
        })),
      );
      for (const [index, chapter] of planChapters.entries()) {
        const decision = decisionByNumber.get(chapter.chapterNumber)!;
        const expected = serverReport[index]!;
        if (decision.matchedChapterNumber !== expected.matchedChapterNumber) {
          throw new Error(
            'Merge import dedupe report is stale or does not match the target novel.',
          );
        }
        if (
          decision.action === 'overwrite'
          && !existingNumbers.has(decision.matchedChapterNumber!)
        ) {
          throw new Error('Merge import overwrite target no longer exists.');
        }
      }
    }

    let nextAppendNumber = input.mode === 'merge'
      ? Math.max(0, ...Array.from(existingNumbers.keys())) + 1
      : 1;

    for (const chapter of planChapters) {
      const decision = input.mode === 'merge'
        ? decisionByNumber.get(chapter.chapterNumber)!
        : null;
      const action: DedupeAction = decision?.action ?? 'append';

      if (input.mode === 'merge' && action === 'skip') {
        skipped++;
        continue;
      }

      let targetNumber: number;
      if (input.mode === 'merge' && action === 'overwrite') {
        targetNumber = decision!.matchedChapterNumber!;
        const existing = existingNumbers.get(targetNumber);
        if (existing) {
          appendSafetySnapshot(db, novelId, targetNumber, existing.content, '(before import)');
        }
      } else if (input.mode === 'merge') {
        targetNumber = nextAppendNumber++;
      } else {
        // New mode — server renumbers contiguous 1..N.
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
        'complete',
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

    const settings = {
      ...baseSettings,
      importMeta: {
        source: session.source,
        importedAt: now,
        originalFilename: session.filename,
        detectedChapters: imported,
        ...(input.runKbExtraction ? { kbExtraction: 'pending' as const } : {}),
      },
    };
    db.prepare(
      'UPDATE novels SET settings = ?, stage = ?, progress = ?, updated_at = ? WHERE id = ?',
    ).run(toJsonText(settings), 'autonomous_writing', progressValue, now, novelId);
    touchNovelUpdatedAt(db, novelId);
  });

  try {
    write();
  } catch (err) {
    // Leave the session recoverable until expiry on validation/write failure.
    throw err;
  }

  removeImportSession(input.sessionToken);
  return { novelId, importedChapters: imported, skippedChapters: skipped };
}

/** Recompute merge dedupe from compact chapter refs against a target novel. */
export async function dedupeImportSession(args: {
  sessionToken: string;
  targetNovelId: string;
  chapters: ImportChapterRef[];
  /** UI row ids aligned with `chapters` order (for report candidateId). */
  candidateIds: string[];
}) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  await verifyNovelOwnership(args.targetNovelId, user.id);

  assertCompactChapters(args.chapters);
  if (
    !Array.isArray(args.candidateIds)
    || args.candidateIds.length !== args.chapters.length
  ) {
    throw new Error('Dedupe candidate ids are incomplete.');
  }
  const seen = new Set<string>();
  for (const id of args.candidateIds) {
    if (typeof id !== 'string' || !id || seen.has(id)) {
      throw new Error('Dedupe candidate ids are invalid.');
    }
    seen.add(id);
  }

  const session = loadImportSession(args.sessionToken);
  const planChapters = reconstructChaptersFromParts(session.segments, args.chapters);
  const existing = await getChapters(args.targetNovelId);
  return dedupeCandidates(
    planChapters.map((chapter, index) => ({
      id: args.candidateIds[index]!,
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      volumeTitle: null,
      content: chapter.content,
      wordCount: countWords(chapter.content),
      inferred: false,
    })),
    existing.map(c => ({
      chapterNumber: c.chapterNumber,
      title: c.title,
      content: c.content,
    })),
  );
}
