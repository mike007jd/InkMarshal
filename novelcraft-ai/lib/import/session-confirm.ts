import { createHash } from 'node:crypto';

import { getUser } from '@/lib/local-auth';
import { getDb } from '@/lib/db/connection';
import {
  acquireWritingLock,
  getChapters,
  releaseWritingLock,
  verifyNovelOwnership,
} from '@/lib/db';
import { appendSafetySnapshot } from '@/lib/db/queries-chapter';
import { recordActivityEvent } from '@/lib/db/queries-activity';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';
import { toJsonText } from '@/lib/db/json-columns';
import { countWords, nowIso } from '@/lib/utils';
import {
  consentContentFingerprint,
  dedupeCandidates,
} from '@/lib/import/dedupe';
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
  DedupeConsent,
  DedupeDecision,
  ImportChapterRef,
  ImportSource,
} from '@/lib/import/types';

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;
/** Merge confirm holds the novel writing lock for the short SQLite mutation. */
const IMPORT_MERGE_LOCK_TTL_SEC = 60;

export type ImportConfirmConflictCode =
  | 'WRITING_IN_PROGRESS'
  | 'STALE_DEDUPE_CONSENT'
  | 'CONFIRMATION_COLLISION';

/** Typed project conflict for merge/import confirmation failures. */
export class ImportConfirmConflictError extends Error {
  readonly code: ImportConfirmConflictCode;

  constructor(code: ImportConfirmConflictCode, message: string) {
    super(message);
    this.name = 'ImportConfirmConflictError';
    this.code = code;
  }
}

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

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value !== 'object') {
    return `${typeof value}:${JSON.stringify(value)}`;
  }
  if (Array.isArray(value)) return `array:[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `object:{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}

/** Stable hash of the confirm request for exactly-once receipts. */
function hashImportConfirmRequest(input: ConfirmImportSessionInput): string {
  return createHash('sha256')
    .update('inkmarshal.import-confirm:v1:')
    .update(canonicalJson({
      mode: input.mode,
      targetNovelId: input.targetNovelId ?? null,
      novelTitle: input.novelTitle,
      chapters: input.chapters,
      dedupeDecisions: input.dedupeDecisions ?? null,
      runKbExtraction: input.runKbExtraction ?? false,
    }))
    .digest('hex');
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
    if (decision.matchedChapterNumber !== null) {
      assertValidConsent(decision.consent);
    } else if (decision.consent != null) {
      throw new Error('Merge import consent is invalid for an unmatched chapter.');
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

function assertValidConsent(consent: DedupeConsent | null | undefined): asserts consent is DedupeConsent {
  if (!consent || typeof consent !== 'object') {
    throw new ImportConfirmConflictError(
      'STALE_DEDUPE_CONSENT',
      'Merge import dedupe consent is missing or invalid.',
    );
  }
  if (typeof consent.matchedChapterId !== 'string' || !consent.matchedChapterId) {
    throw new ImportConfirmConflictError(
      'STALE_DEDUPE_CONSENT',
      'Merge import dedupe consent is missing or invalid.',
    );
  }
  if (!Number.isInteger(consent.matchedVersion) || consent.matchedVersion < 0) {
    throw new ImportConfirmConflictError(
      'STALE_DEDUPE_CONSENT',
      'Merge import dedupe consent is missing or invalid.',
    );
  }
  if (
    typeof consent.matchedContentFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(consent.matchedContentFingerprint)
  ) {
    throw new ImportConfirmConflictError(
      'STALE_DEDUPE_CONSENT',
      'Merge import dedupe consent is missing or invalid.',
    );
  }
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

function parseStoredResult(raw: string | null): ConfirmImportSessionResult {
  if (!raw) {
    throw new Error('Import confirmation result is missing.');
  }
  const parsed = JSON.parse(raw) as ConfirmImportSessionResult;
  if (
    typeof parsed.novelId !== 'string'
    || !Number.isInteger(parsed.importedChapters)
    || !Number.isInteger(parsed.skippedChapters)
  ) {
    throw new Error('Import confirmation result is corrupt.');
  }
  return parsed;
}

function bestEffortRemoveSession(sessionToken: string): void {
  try {
    removeImportSession(sessionToken);
  } catch {
    // Filesystem cleanup must not affect durable replay semantics.
  }
}

/**
 * Confirm an opaque import session. Reconstructs prose server-side, writes
 * novel + chapters + settings/activity/importMeta + confirmation receipt in one
 * SQLite transaction (new mode creates no empty shell on failure). Merge mode
 * acquires the novel writing lock before re-reading the target and validating
 * version-bound dedupe consent. Session filesystem cleanup is best-effort after
 * a successful commit and never gates replay.
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
  if (input.mode === 'merge') {
    assertMergeDedupeDecisions(input.chapters.length, input.dedupeDecisions);
  }

  const requestHash = hashImportConfirmRequest(input);
  const db = getDb();

  // Durable receipt is authoritative for replay/collision — do not require the
  // filesystem session after a successful confirm (cleanup is best-effort).
  const prior = db
    .prepare(
      `SELECT request_hash, status, result_json
         FROM import_confirmations
        WHERE session_token = ?`,
    )
    .get(input.sessionToken) as
    | { request_hash: string; status: string; result_json: string | null }
    | undefined;
  if (prior) {
    if (prior.request_hash !== requestHash) {
      throw new ImportConfirmConflictError(
        'CONFIRMATION_COLLISION',
        'Import session token was already used with a different confirm request.',
      );
    }
    if (prior.status === 'succeeded') {
      const result = parseStoredResult(prior.result_json);
      bestEffortRemoveSession(input.sessionToken);
      return result;
    }
  }

  const session = loadImportSession(input.sessionToken);
  const source: ImportSource = session.source;
  if (source !== 'txt' && source !== 'md' && source !== 'docx') {
    throw new Error('Import source is invalid.');
  }

  const planChapters = reconstructChaptersFromParts(session.segments, input.chapters);
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

  let mergeLockToken: string | null = null;
  if (input.mode === 'merge') {
    const lock = await acquireWritingLock(input.targetNovelId!, IMPORT_MERGE_LOCK_TTL_SEC);
    if (!lock) {
      throw new ImportConfirmConflictError(
        'WRITING_IN_PROGRESS',
        'Another writing session is already in progress for this novel.',
      );
    }
    mergeLockToken = lock.token;
  }

  const now = nowIso();
  let imported = 0;
  let skipped = 0;
  let novelId = '';

  try {
    const write = db.transaction(() => {
      const existingReceipt = db
        .prepare(
          `SELECT request_hash, status, result_json
             FROM import_confirmations
            WHERE session_token = ?`,
        )
        .get(input.sessionToken) as
        | { request_hash: string; status: string; result_json: string | null }
        | undefined;
      if (existingReceipt) {
        if (existingReceipt.request_hash !== requestHash) {
          throw new ImportConfirmConflictError(
            'CONFIRMATION_COLLISION',
            'Import session token was already used with a different confirm request.',
          );
        }
        if (existingReceipt.status === 'succeeded') {
          return parseStoredResult(existingReceipt.result_json);
        }
      } else {
        db.prepare(
          `INSERT INTO import_confirmations
             (session_token, request_hash, status, result_json, created_at, updated_at)
           VALUES (?, ?, 'pending', NULL, ?, ?)`,
        ).run(input.sessionToken, requestHash, now, now);
      }

      if (input.mode === 'merge') {
        novelId = input.targetNovelId!;
        // Hold the lock token through the mutation: refuse if ownership was lost.
        const stillOwned = db
          .prepare(
            `SELECT 1 AS ok FROM novels
              WHERE id = ? AND writing_lock_token = ? AND writing_lock_expires_at >= ?`,
          )
          .get(novelId, mergeLockToken, now) as { ok: number } | undefined;
        if (!stillOwned) {
          throw new ImportConfirmConflictError(
            'WRITING_IN_PROGRESS',
            'Another writing session is already in progress for this novel.',
          );
        }
      } else {
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
           processing_status = excluded.processing_status,
           -- Overwrite replaces manuscript prose; clear every derived AI field
           -- so stale summarize/validate/generation metadata cannot survive.
           summary = '',
           key_facts = NULL,
           key_facts_v = NULL,
           quality_issues = NULL,
           quality_issues_v = NULL,
           generation_meta = NULL,
           generation_meta_v = NULL`,
      );

      const existingByNumber = new Map<number, {
        id: string;
        title: string;
        content: string;
        version: number;
      }>();
      if (input.mode === 'merge') {
        const rows = db
          .prepare(
            `SELECT id, chapter_number, title, content, version
               FROM chapters WHERE novel_id = ?`,
          )
          .all(novelId) as Array<{
            id: string;
            chapter_number: number;
            title: string;
            content: string;
            version: number;
          }>;
        for (const r of rows) {
          existingByNumber.set(r.chapter_number, {
            id: r.id,
            title: r.title,
            content: r.content,
            version: r.version,
          });
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
            id: row.id,
            chapterNumber: row.chapter_number,
            title: row.title,
            content: row.content,
            version: row.version,
          })),
        );
        for (const [index, chapter] of planChapters.entries()) {
          const decision = decisionByNumber.get(chapter.chapterNumber)!;
          const expected = serverReport[index]!;
          if (decision.matchedChapterNumber !== expected.matchedChapterNumber) {
            throw new ImportConfirmConflictError(
              'STALE_DEDUPE_CONSENT',
              'Merge import dedupe report is stale or does not match the target novel.',
            );
          }
          if (decision.matchedChapterNumber !== null) {
            const target = existingByNumber.get(decision.matchedChapterNumber);
            const consent = decision.consent;
            if (
              !target
              || !consent
              || consent.matchedChapterId !== target.id
              || consent.matchedVersion !== target.version
              || consent.matchedContentFingerprint !== consentContentFingerprint(target.content)
              || expected.consent?.matchedChapterId !== consent.matchedChapterId
              || expected.consent?.matchedVersion !== consent.matchedVersion
              || expected.consent?.matchedContentFingerprint !== consent.matchedContentFingerprint
            ) {
              throw new ImportConfirmConflictError(
                'STALE_DEDUPE_CONSENT',
                'Merge import dedupe consent is stale; the target chapter changed.',
              );
            }
          }
          if (
            decision.action === 'overwrite'
            && !existingByNumber.has(decision.matchedChapterNumber!)
          ) {
            throw new ImportConfirmConflictError(
              'STALE_DEDUPE_CONSENT',
              'Merge import overwrite target no longer exists.',
            );
          }
        }
      }

      let nextAppendNumber = input.mode === 'merge'
        ? Math.max(0, ...Array.from(existingByNumber.keys())) + 1
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
          const existing = existingByNumber.get(targetNumber);
          if (existing) {
            appendSafetySnapshot(db, novelId, targetNumber, existing.content, '(before import)');
          }
        } else if (input.mode === 'merge') {
          targetNumber = nextAppendNumber++;
        } else {
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

      const result: ConfirmImportSessionResult = {
        novelId,
        importedChapters: imported,
        skippedChapters: skipped,
      };
      db.prepare(
        `UPDATE import_confirmations
            SET status = 'succeeded', result_json = ?, updated_at = ?
          WHERE session_token = ? AND request_hash = ?`,
      ).run(JSON.stringify(result), now, input.sessionToken, requestHash);
      return result;
    });

    const result = write();
    bestEffortRemoveSession(input.sessionToken);
    return result;
  } finally {
    if (mergeLockToken && input.targetNovelId) {
      await releaseWritingLock(input.targetNovelId, mergeLockToken).catch(() => undefined);
    }
  }
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
      id: c.id,
      chapterNumber: c.chapterNumber,
      title: c.title,
      content: c.content,
      version: c.version,
    })),
  );
}
