import {
  saveChapterContentVersioned,
  setChapterOriginalContent,
  type UnificationEdit,
  type UnificationReport,
} from '@/lib/db';
import { UNIFICATION_REPORT_LIMITS, type UnificationReportResult } from '@/lib/ai';
import { getDb } from '@/lib/db/connection';
import { recordActivityEvent } from '@/lib/db/queries-activity';
import { JSON_COLUMN_VERSIONS, parseJsonbWithVersion, toJsonText } from '@/lib/db/json-columns';
import { countWords, nowIso } from '@/lib/utils';

export interface ApplyResult {
  editId: string;
  status: 'applied' | 'skipped' | 'not_found' | 'conflict';
  reason?: string;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isBoundedGeneratedUnificationEdit(
  edit: UnificationReportResult['edits'][number],
): boolean {
  return Number.isInteger(edit.chapterNumber)
    && edit.chapterNumber > 0
    && isBoundedString(edit.original, UNIFICATION_REPORT_LIMITS.original)
    // Reject an empty/whitespace-only original: applyEditsTo would otherwise
    // corrupt the whole chapter (empty-string find/replace). Persisted reports
    // predating the schema guard are filtered here too.
    && edit.original.trim().length > 0
    && isBoundedString(edit.replacement, UNIFICATION_REPORT_LIMITS.replacement)
    && isBoundedString(edit.rationale, UNIFICATION_REPORT_LIMITS.rationale)
    && (edit.severity === 'minor' || edit.severity === 'major');
}

function isBoundedUnificationEdit(edit: UnificationEdit): boolean {
  return isBoundedString(edit.id, 128)
    && isBoundedGeneratedUnificationEdit(edit);
}

export function sanitizeUnificationReport(report: UnificationReport): UnificationReport {
  return {
    ...report,
    edits: report.edits
      .slice(0, UNIFICATION_REPORT_LIMITS.edits)
      .filter(isBoundedUnificationEdit),
    summary: String(report.summary ?? '').slice(0, UNIFICATION_REPORT_LIMITS.summary),
  };
}

export function buildGlobalChapterMap(
  chapters: Array<{ chapterNumber: number; title: string; summary?: string; content: string }>,
  charBudget: number,
): string {
  const lines: string[] = [];
  let used = 0;
  for (const chapter of chapters) {
    const basis = chapter.summary || chapter.content.slice(0, 300);
    const compact = basis.replace(/\s+/g, ' ').trim().slice(0, 240);
    const line = `Ch.${chapter.chapterNumber} ${chapter.title}: ${compact}`;
    if (used + line.length > charBudget) {
      const remaining = chapters.length - lines.length;
      if (remaining > 0) lines.push(`... ${remaining} later chapters omitted from compact map.`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.length > 0 ? `Whole-book compact chapter map:\n${lines.join('\n')}` : '';
}

export function appendUnificationBatch(
  edits: UnificationEdit[],
  batchResult: UnificationReportResult,
  options: { novelId: string; now?: () => number },
): { edits: UnificationEdit[]; summary?: string } {
  const now = options.now ?? Date.now;
  const next = [...edits];
  // Per-call random suffix so two batches appended in the same wall-clock
  // millisecond don't collide on `${novelId}-${now()}-${index}` (which collapsed
  // ids in the apply targetSet and made markAppliedEdits/results matching
  // ambiguous).
  const callSuffix = Math.random().toString(36).slice(2, 8);
  for (const edit of batchResult.edits) {
    if (next.length >= UNIFICATION_REPORT_LIMITS.edits) break;
    if (!isBoundedGeneratedUnificationEdit(edit)) continue;
    next.push({
      id: `${options.novelId}-${now()}-${callSuffix}-${next.length}`,
      chapterNumber: edit.chapterNumber,
      original: edit.original,
      replacement: edit.replacement,
      rationale: edit.rationale,
      severity: edit.severity,
      applied: false,
    });
  }
  return { edits: next, summary: batchResult.summary };
}

export function createUnificationReport(args: {
  edits: UnificationEdit[];
  summaries: string[];
  modelId: string;
  now?: () => Date;
}): UnificationReport {
  return {
    edits: args.edits
      .slice(0, UNIFICATION_REPORT_LIMITS.edits)
      .filter(isBoundedUnificationEdit),
    summary: args.summaries.filter(Boolean).join(' ').slice(0, UNIFICATION_REPORT_LIMITS.summary),
    generatedAt: (args.now ?? (() => new Date()))().toISOString(),
    modelId: args.modelId,
  };
}

export function applyEditsTo(
  content: string,
  edits: UnificationEdit[],
  keep?: Map<string, ApplyResult>,
): { content: string; results: ApplyResult[] } {
  const results: ApplyResult[] = [];
  // Plan every replacement against the IMMUTABLE original snapshot, then rebuild
  // the chapter in a single non-cascading pass. The previous approach mutated a
  // running buffer with split/join, so one edit's replacement text could be
  // re-matched and clobbered by a later edit in the same batch.
  type ClaimedSpan = { start: number; end: number; replacement: string };
  const claimed: ClaimedSpan[] = [];
  const overlapsClaimed = (start: number, end: number) =>
    claimed.some(c => start < c.end && c.start < end);

  for (const edit of edits.slice(0, UNIFICATION_REPORT_LIMITS.edits).filter(isBoundedUnificationEdit)) {
    const prior = keep?.get(edit.id);
    if (prior && prior.status === 'not_found') {
      results.push(prior);
      continue;
    }
    // Defense-in-depth: isBoundedUnificationEdit already drops empty originals,
    // but never run split('') here — it would explode the chapter.
    if (edit.original.length === 0) {
      results.push({ editId: edit.id, status: 'not_found', reason: 'empty original' });
      continue;
    }

    // Collect every (non-overlapping within this edit) occurrence in the
    // original snapshot — preserves the prior replace-all semantics.
    const spans: Array<{ start: number; end: number }> = [];
    let from = 0;
    for (;;) {
      const idx = content.indexOf(edit.original, from);
      if (idx === -1) break;
      spans.push({ start: idx, end: idx + edit.original.length });
      from = idx + edit.original.length;
    }
    if (spans.length === 0) {
      results.push({ editId: edit.id, status: 'not_found', reason: 'verbatim original not present' });
      continue;
    }

    // Drop occurrences that overlap a higher-priority edit's claimed span. If
    // every occurrence is taken, the edit genuinely conflicts.
    const free = spans.filter(s => !overlapsClaimed(s.start, s.end));
    if (free.length === 0) {
      results.push({ editId: edit.id, status: 'conflict', reason: 'overlaps an earlier edit in this batch' });
      continue;
    }
    for (const s of free) claimed.push({ start: s.start, end: s.end, replacement: edit.replacement });
    results.push({ editId: edit.id, status: 'applied' });
  }

  claimed.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of claimed) {
    if (span.start < cursor) continue; // residual-overlap safety
    out += content.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  out += content.slice(cursor);
  return { content: out, results };
}

function targetUnificationEdits(
  report: UnificationReport,
  options: { applyAll: boolean; editIds?: string[] },
): UnificationEdit[] {
  const boundedEdits = report.edits
    .slice(0, UNIFICATION_REPORT_LIMITS.edits)
    .filter(isBoundedUnificationEdit);
  if (options.applyAll) return boundedEdits.filter(e => !e.applied && !e.skipped);
  const targetSet = new Set(options.editIds ?? []);
  return boundedEdits.filter(e => targetSet.has(e.id) && !e.applied && !e.skipped);
}

function groupUnificationEditsByChapter(edits: UnificationEdit[]): Map<number, UnificationEdit[]> {
  const byChapter = new Map<number, UnificationEdit[]>();
  for (const edit of edits) {
    const list = byChapter.get(edit.chapterNumber) ?? [];
    list.push(edit);
    byChapter.set(edit.chapterNumber, list);
  }
  return byChapter;
}

function markAppliedEdits(
  report: UnificationReport,
  results: ApplyResult[],
  now: () => Date = () => new Date(),
): UnificationReport {
  const appliedAt = now().toISOString();
  const updatedEdits = report.edits.map(edit => {
    const result = results.find(r => r.editId === edit.id);
    return result?.status === 'applied' ? { ...edit, applied: true, appliedAt } : edit;
  });
  return { ...report, edits: updatedEdits };
}

export function markSkippedEdits(
  report: UnificationReport,
  editIds: string[],
  now: () => Date = () => new Date(),
): { results: ApplyResult[]; report: UnificationReport } {
  const skippedAt = now().toISOString();
  const targetSet = new Set(editIds);
  const results: ApplyResult[] = [];
  const updatedEdits = report.edits.map(edit => {
    if (!targetSet.has(edit.id) || edit.applied || edit.skipped) return edit;
    results.push({ editId: edit.id, status: 'skipped' });
    return { ...edit, skipped: true, skippedAt };
  });
  return { results, report: { ...report, edits: updatedEdits } };
}

export function isUnificationComplete(report: UnificationReport): boolean {
  return report.edits.every(e => e.applied || e.skipped);
}

interface DbChapterRow {
  content: string;
  original_content: string | null;
  version: number;
}

function applyEditsToChapterSync(
  novelId: string,
  chapterNumber: number,
  edits: UnificationEdit[],
): ApplyResult[] {
  const db = getDb();
  const chapter = db
    .prepare('SELECT content, original_content, version FROM chapters WHERE novel_id = ? AND chapter_number = ?')
    .get(novelId, chapterNumber) as DbChapterRow | undefined;
  if (!chapter) {
    return edits.map(e => ({ editId: e.id, status: 'not_found', reason: 'chapter missing' }));
  }

  let pass = applyEditsTo(chapter.content, edits);
  if (pass.content === chapter.content) return pass.results;

  if (chapter.original_content === null) {
    setChapterOriginalContent(db, novelId, chapterNumber, chapter.content);
  }

  // This is the ONLY unification apply path now (the former injectable
  // async-store twin was deleted). It runs inside `applyAndPersistUnificationEdits`'
  // transaction, so the optimistic-version conflict + re-read retry below is
  // defensive: a concurrent writer can't interleave within the transaction, so
  // in practice the first save always wins. Kept as one belt-and-braces copy.
  let savedVersion = chapter.version;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Optimistic-version write recycled into the db layer (queries-chapter).
    const save = saveChapterContentVersioned(db, novelId, chapterNumber, pass.content, savedVersion);
    if (!save.conflict) {
      return pass.results;
    }
    if (attempt === 1) {
      return pass.results.map(r => (r.status === 'applied' ? { ...r, status: 'conflict' as const } : r));
    }

    const fresh = db
      .prepare('SELECT content, version FROM chapters WHERE novel_id = ? AND chapter_number = ?')
      .get(novelId, chapterNumber) as Pick<DbChapterRow, 'content' | 'version'> | undefined;
    if (!fresh) {
      return pass.results.map(r => (
        r.status === 'applied'
          ? { ...r, status: 'not_found' as const, reason: 'chapter removed during apply' }
          : r
      ));
    }
    const keep = new Map(pass.results.map(r => [r.editId, r]));
    pass = applyEditsTo(fresh.content, edits, keep);
    if (pass.content === fresh.content) return pass.results;
    savedVersion = fresh.version;
  }
  return pass.results;
}

function applyUnificationEditsSync(args: {
  novelId: string;
  report: UnificationReport;
  applyAll: boolean;
  editIds?: string[];
  skipAll?: boolean;
  skipIds?: string[];
  now?: () => Date;
}): { results: ApplyResult[]; report: UnificationReport; allDone: boolean } {
  const report = sanitizeUnificationReport(args.report);
  if (args.skipAll || (args.skipIds?.length ?? 0) > 0) {
    const targetEdits = args.skipAll
      ? report.edits.filter(e => !e.applied && !e.skipped)
      : targetUnificationEdits(report, {
          applyAll: false,
          editIds: args.skipIds,
        });
    const skipped = markSkippedEdits(report, targetEdits.map(e => e.id), args.now);
    return {
      results: skipped.results,
      report: skipped.report,
      allDone: isUnificationComplete(skipped.report),
    };
  }

  const targetEdits = targetUnificationEdits(report, {
    applyAll: args.applyAll,
    editIds: args.editIds,
  });
  if (targetEdits.length === 0) {
    return { results: [], report, allDone: isUnificationComplete(report) };
  }

  const results = Array.from(groupUnificationEditsByChapter(targetEdits).entries())
    .flatMap(([chapterNumber, edits]) => applyEditsToChapterSync(args.novelId, chapterNumber, edits));
  const updatedReport = markAppliedEdits(report, results, args.now);
  return { results, report: updatedReport, allDone: isUnificationComplete(updatedReport) };
}

export function applyAndPersistUnificationEdits(args: {
  novelId: string;
  report: UnificationReport;
  applyAll: boolean;
  editIds?: string[];
  skipAll?: boolean;
  skipIds?: string[];
  now?: () => Date;
}): { results: ApplyResult[]; report: UnificationReport; allDone: boolean } {
  const db = getDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare('SELECT unification_report, unification_report_v FROM novels WHERE id = ?')
      .get(args.novelId) as { unification_report: unknown; unification_report_v: unknown } | undefined;
    if (!row) {
      throw new Error('Novel not found');
    }
    const currentReport = parseJsonbWithVersion<UnificationReport>(
      row.unification_report,
      row.unification_report_v,
      'novels.unification_report',
      { maxSupportedVersion: JSON_COLUMN_VERSIONS.unification_report },
    ) ?? args.report;
    const result = applyUnificationEditsSync({ ...args, report: currentReport });
    if (result.results.length === 0 && !result.allDone) return result;

    const updatedAt = nowIso();
    const info = db.prepare(
      `UPDATE novels
       SET unification_report = ?,
           unification_report_v = ?,
           stage = CASE WHEN ? THEN 'completed' ELSE stage END,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      toJsonText(result.report),
      JSON_COLUMN_VERSIONS.unification_report,
      result.allDone ? 1 : 0,
      updatedAt,
      args.novelId,
    );
    if (info.changes === 0) {
      throw new Error('Novel not found');
    }

    // Primary emission point of the source='accepted' signal contract used by
    // activity analytics and the AI cost panel. One event per
    // chapter that received applied edits, net word delta summed across them.
    const appliedIds = new Set(
      result.results.filter(r => r.status === 'applied').map(r => r.editId),
    );
    if (appliedIds.size > 0) {
      const byChapter = new Map<number, number>();
      for (const edit of result.report.edits) {
        if (!appliedIds.has(edit.id)) continue;
        const delta = countWords(edit.replacement) - countWords(edit.original);
        byChapter.set(edit.chapterNumber, (byChapter.get(edit.chapterNumber) ?? 0) + delta);
      }
      for (const [chapterNumber, wordsDelta] of byChapter) {
        try {
          recordActivityEvent(db, {
            novelId: args.novelId,
            type: 'unification_applied',
            source: 'accepted',
            chapterNumber,
            wordsDelta,
            meta: { appliedCount: appliedIds.size },
            at: args.now?.(),
          });
        } catch {
          // Telemetry must never block the apply transaction.
        }
      }
    }
    return result;
  });
  return tx();
}
