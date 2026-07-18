import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { UNIFICATION_REPORT_LIMITS } from '@/lib/ai';
import type { UnificationEdit, UnificationReport } from '@/lib/db';
import {
  appendUnificationBatch,
  applyEditsTo,
  applyAndPersistUnificationEdits,
  buildGlobalChapterMap,
  createUnificationReport,
  isUnificationComplete,
  markSkippedEdits,
  sanitizeUnificationReport,
} from '@/lib/whole-book-unification';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-unification-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function edit(id: string, chapterNumber: number, original = 'old', replacement = 'new'): UnificationEdit {
  return {
    id,
    chapterNumber,
    original,
    replacement,
    rationale: 'fix continuity',
    severity: 'minor',
    applied: false,
  };
}

function report(edits: UnificationEdit[]): UnificationReport {
  return {
    edits,
    summary: 'scan summary',
    generatedAt: '2026-01-01T00:00:00.000Z',
    modelId: 'model-1',
  };
}

// Run a callback against a throwaway novel with the given persisted report, then
// clean up. Exercises the ONLY apply path now — the synchronous,
// transaction-backed `applyAndPersistUnificationEdits` against a real DB.
async function withNovel(
  persistedReport: UnificationReport,
  fn: (ctx: {
    novelId: string;
    db: typeof import('@/lib/db');
  }) => Promise<void>,
): Promise<void> {
  const db = await import('@/lib/db');
  const novel = await db.createNovel({ userId: 'local-user', title: 'Unify apply' });
  try {
    await db.updateNovel(novel.id, { stage: 'whole_book_unification', unificationReport: persistedReport });
    await fn({ novelId: novel.id, db });
  } finally {
    await db.deleteNovelCascade(novel.id, 'local-user');
  }
}

describe('whole-book unification report building', () => {
  it('builds a compact chapter map from summaries before content and respects budget', () => {
    const map = buildGlobalChapterMap([
      { chapterNumber: 1, title: 'Opening', summary: '  summary   one  ', content: 'content one' },
      { chapterNumber: 2, title: 'Middle', content: 'content two '.repeat(40) },
      { chapterNumber: 3, title: 'End', content: 'content three' },
    ], 90);

    expect(map).toContain('Ch.1 Opening: summary one');
    expect(map).not.toContain('content one');
    expect(map).toContain('later chapters omitted');
  });

  it('creates well-formed, unique edit ids and final report metadata', () => {
    const merged = appendUnificationBatch([], {
      summary: 'batch summary',
      edits: [
        { chapterNumber: 1, original: 'A', replacement: 'B', rationale: 'r1', severity: 'minor' },
        { chapterNumber: 2, original: 'C', replacement: 'D', rationale: 'r2', severity: 'major' },
      ],
    }, { novelId: 'novel-1', now: () => 123 });

    // Ids are unique, share the novel+timestamp prefix, and end in their index.
    const ids = merged.edits.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toMatch(/^novel-1-123-[a-z0-9]+-0$/);
    expect(ids[1]).toMatch(/^novel-1-123-[a-z0-9]+-1$/);
    expect(createUnificationReport({
      edits: merged.edits,
      summaries: [merged.summary ?? '', 'second'],
      modelId: 'model-1',
      now: () => new Date('2026-01-02T00:00:00.000Z'),
    })).toMatchObject({
      summary: 'batch summary second',
      generatedAt: '2026-01-02T00:00:00.000Z',
      modelId: 'model-1',
    });
  });

  // E2: two batches appended in the same wall-clock millisecond must not collide
  // on their edit ids (the old `${novelId}-${now()}-${index}` collided, collapsing
  // ids in the apply targetSet). The per-call random suffix keeps them distinct.
  it('does not collide edit ids across two batches in the same millisecond', () => {
    const fixedNow = () => 999;
    const a = appendUnificationBatch([], {
      summary: 'a',
      edits: [{ chapterNumber: 1, original: 'A', replacement: 'B', rationale: 'r', severity: 'minor' }],
    }, { novelId: 'novel-1', now: fixedNow });
    const b = appendUnificationBatch(a.edits, {
      summary: 'b',
      edits: [{ chapterNumber: 2, original: 'C', replacement: 'D', rationale: 'r', severity: 'minor' }],
    }, { novelId: 'novel-1', now: fixedNow });

    const ids = b.edits.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('bounds generated and persisted unification reports before later apply', () => {
    const existing = Array.from({ length: UNIFICATION_REPORT_LIMITS.edits }, (_, index) =>
      edit(`e-${index}`, 1),
    );
    const merged = appendUnificationBatch(existing, {
      summary: 'ignored',
      edits: [{ chapterNumber: 1, original: 'A', replacement: 'B', rationale: 'r', severity: 'minor' }],
    }, { novelId: 'novel-1', now: () => 123 });
    expect(merged.edits).toHaveLength(UNIFICATION_REPORT_LIMITS.edits);

    const oversized = edit('oversized', 1, 'A'.repeat(UNIFICATION_REPORT_LIMITS.original + 1), 'B');
    const clean = edit('clean', 1, 'A', 'B');
    const persisted = sanitizeUnificationReport({
      ...report([oversized, clean]),
      summary: 's'.repeat(UNIFICATION_REPORT_LIMITS.summary + 1),
    });
    expect(persisted.edits.map(e => e.id)).toEqual(['clean']);
    expect(persisted.summary).toHaveLength(UNIFICATION_REPORT_LIMITS.summary);
  });
});

describe('whole-book unification apply flow', () => {
  it('applies verbatim replacements and preserves previous not-found results on retry', () => {
    const e1 = edit('e1', 1, 'old', 'new');
    const e2 = edit('e2', 1, 'missing', 'x');
    const first = applyEditsTo('old body', [e1, e2]);
    const second = applyEditsTo('newer old body', [e1, e2], new Map(first.results.map(r => [r.editId, r])));

    expect(first.content).toBe('new body');
    expect(first.results).toEqual([
      { editId: 'e1', status: 'applied' },
      { editId: 'e2', status: 'not_found', reason: 'verbatim original not present' },
    ]);
    expect(second.results[1]).toEqual(first.results[1]);
  });

  it('applies every repeated occurrence of a unification edit', () => {
    const result = applyEditsTo('old name, old name, still old name', [edit('e1', 1, 'old name', 'new name')]);

    expect(result.content).toBe('new name, new name, still new name');
    expect(result.results).toEqual([{ editId: 'e1', status: 'applied' }]);
  });

  it('never corrupts the chapter when an edit has an empty original', () => {
    // An empty `original` previously hit split('').join() and exploded the
    // whole chapter into per-character inserts. The bounded filter must drop it
    // entirely, leaving the content untouched.
    const result = applyEditsTo('the quick brown fox', [edit('empty', 1, '', 'X')]);

    expect(result.content).toBe('the quick brown fox');
    expect(result.results).toEqual([]);
  });

  it('does not let one edit cascade into a later edit within the same batch', () => {
    // Matching is against the immutable original snapshot: editA turning 'A'
    // into 'B' must NOT make editB ('B' -> 'C') rewrite editA's output. Only
    // the original 'B' is replaced.
    const result = applyEditsTo('A B', [edit('a', 1, 'A', 'B'), edit('b', 1, 'B', 'C')]);

    expect(result.content).toBe('B C');
    expect(result.results).toEqual([
      { editId: 'a', status: 'applied' },
      { editId: 'b', status: 'applied' },
    ]);
  });

  it('marks an edit as conflict when all its occurrences overlap an earlier edit', () => {
    // Both edits target overlapping spans of the same original text; the
    // lower-priority one cannot apply against text already claimed.
    const result = applyEditsTo('hello world', [
      edit('a', 1, 'hello world', 'goodbye'),
      edit('b', 1, 'hello', 'hi'),
    ]);

    expect(result.content).toBe('goodbye');
    expect(result.results).toEqual([
      { editId: 'a', status: 'applied' },
      { editId: 'b', status: 'conflict', reason: 'overlaps an earlier edit in this batch' },
    ]);
  });

  it('selects requested edits, persists content + version, sets original, and reports completion only when all edits are done', async () => {
    const e1 = edit('e1', 1, 'old', 'new');
    const e2 = edit('e2', 2, 'old', 'new');
    await withNovel(report([e1, e2]), async ({ novelId, db }) => {
      await db.upsertChapter(novelId, 2, 'Ch2', 'old value');
      const before = await db.getChapter(novelId, 2);

      const result = applyAndPersistUnificationEdits({
        novelId,
        report: report([e1, e2]),
        applyAll: false,
        editIds: ['e2'],
        now: () => new Date('2026-01-03T00:00:00.000Z'),
      });

      expect(result.results).toEqual([{ editId: 'e2', status: 'applied' }]);
      expect(result.report.edits[0].applied).toBe(false);
      expect(result.report.edits[1]).toMatchObject({ applied: true, appliedAt: '2026-01-03T00:00:00.000Z' });
      expect(result.allDone).toBe(false);

      const after = await db.getChapter(novelId, 2);
      expect(after!.content).toBe('new value');
      expect(after!.version).toBe(before!.version + 1);
      expect(after!.originalContent).toBe('old value');
    });
  });

  it('lets unresolved edits be skipped so the unification stage can complete', async () => {
    const e1 = edit('e1', 1, 'old', 'new');
    const e2 = edit('e2', 2, 'missing', 'x');
    const skipped = markSkippedEdits(
      report([{ ...e1, applied: true }, e2]),
      ['e2'],
      () => new Date('2026-01-04T00:00:00.000Z'),
    );

    expect(skipped.results).toEqual([{ editId: 'e2', status: 'skipped' }]);
    expect(skipped.report.edits[1]).toMatchObject({
      skipped: true,
      skippedAt: '2026-01-04T00:00:00.000Z',
    });
    expect(isUnificationComplete(skipped.report)).toBe(true);
  });

  it('skips selected edits through the apply orchestration path', async () => {
    const e1 = edit('e1', 1, 'old', 'new');
    const e2 = edit('e2', 2, 'missing', 'x');
    await withNovel(report([{ ...e1, applied: true }, e2]), async ({ novelId }) => {
      const result = applyAndPersistUnificationEdits({
        novelId,
        report: report([{ ...e1, applied: true }, e2]),
        applyAll: false,
        skipIds: ['e2'],
        now: () => new Date('2026-01-05T00:00:00.000Z'),
      });

      expect(result.results).toEqual([{ editId: 'e2', status: 'skipped' }]);
      expect(result.report.edits[1]).toMatchObject({ skipped: true, skippedAt: '2026-01-05T00:00:00.000Z' });
      expect(result.allDone).toBe(true);
    });
  });

  // NB: the optimistic-lock conflict/retry branch of applyEditsToChapterSync is
  // defensive only — the apply runs inside a single better-sqlite3 transaction,
  // so no concurrent writer can change the version between read and write. The
  // former injectable async-store twin (which existed to inject conflicts) was
  // deleted; there is one apply path now.

  it('returns not-found when the targeted chapter is missing', async () => {
    await withNovel(report([edit('e1', 1)]), async ({ novelId, db }) => {
      // No chapter row created for chapter 1.
      const result = applyAndPersistUnificationEdits({
        novelId,
        report: report([edit('e1', 1)]),
        applyAll: true,
      });
      expect(result.results).toEqual([{ editId: 'e1', status: 'not_found', reason: 'chapter missing' }]);
      expect(await db.getChapter(novelId, 1)).toBeUndefined();
    });
  });

  it('does not bump version or set original content when the targeted edit is stale', async () => {
    await withNovel(report([edit('e1', 1, 'old text', 'new text')]), async ({ novelId, db }) => {
      await db.upsertChapter(novelId, 1, 'Ch1', 'fresh text'); // does not contain "old text"
      const before = await db.getChapter(novelId, 1);

      const result = applyAndPersistUnificationEdits({
        novelId,
        report: report([edit('e1', 1, 'old text', 'new text')]),
        applyAll: true,
      });

      expect(result.results).toEqual([
        { editId: 'e1', status: 'not_found', reason: 'verbatim original not present' },
      ]);
      const after = await db.getChapter(novelId, 1);
      expect(after!.content).toBe('fresh text');
      expect(after!.version).toBe(before!.version);
      expect(after!.originalContent).toBeNull();
    });
  });

  it('sanitizes legacy oversized reports before applying all edits', async () => {
    const oversized = edit('oversized', 1, 'A'.repeat(UNIFICATION_REPORT_LIMITS.original + 1), 'B');
    const clean = edit('clean', 1, 'old', 'new');
    await withNovel(report([oversized, clean]), async ({ novelId, db }) => {
      await db.upsertChapter(novelId, 1, 'Ch1', 'old value');

      const result = applyAndPersistUnificationEdits({
        novelId,
        report: report([oversized, clean]),
        applyAll: true,
        now: () => new Date('2026-01-06T00:00:00.000Z'),
      });

      expect(result.results).toEqual([{ editId: 'clean', status: 'applied' }]);
      expect(result.report.edits.map(e => e.id)).toEqual(['clean']);
      expect((await db.getChapter(novelId, 1))!.content).toBe('new value');
    });
  });

  it('uses the current persisted report instead of a stale caller snapshot', async () => {
    const { createNovel, deleteNovelCascade, getNovel, updateNovel, upsertChapter } = await import('@/lib/db');
    const novel = await createNovel({ userId: 'local-user', title: 'Stale unification snapshot' });
    const pending = report([edit('e1', 1, 'old', 'new')]);
    const alreadyApplied = report([{ ...edit('e1', 1, 'old', 'new'), applied: true }]);

    try {
      await upsertChapter(novel.id, 1, 'One', 'new text');
      await updateNovel(novel.id, {
        stage: 'completed',
        unificationReport: alreadyApplied,
      });

      const result = applyAndPersistUnificationEdits({
        novelId: novel.id,
        report: pending,
        applyAll: true,
      });

      expect(result.results).toEqual([]);
      expect((await getNovel(novel.id))!.unificationReport!.edits[0]).toMatchObject({
        id: 'e1',
        applied: true,
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
