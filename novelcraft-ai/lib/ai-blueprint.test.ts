import { describe, expect, it } from 'vitest';

import {
  CHAPTER_POST_GENERATION_LIMITS,
  ChapterQualitySchema,
  ChapterSummarySchema,
  UNIFICATION_REPORT_LIMITS,
  UnificationReportSchema,
  buildUnificationBatches,
  buildRollingDigest,
  selectChapterPlansToWrite,
  type ChapterBlueprint,
} from '@/lib/ai';

// These tests cover the pure helpers + schemas that gate the long-novel
// pipeline. We don't exercise live model calls — the route-level integration
// path is verified manually (see /spec docs).

describe('blueprint reuse', () => {
  const blueprint: ChapterBlueprint[] = [
    { chapterNumber: 1, title: 'One', summary: 'a' },
    { chapterNumber: 2, title: 'Two', summary: 'b' },
    { chapterNumber: 3, title: 'Three', summary: 'c' },
  ];

  it('skips chapters already drafted on resume', () => {
    expect(selectChapterPlansToWrite(blueprint, [{ chapterNumber: 1 }])).toEqual([
      { chapterNumber: 2, title: 'Two', summary: 'b' },
      { chapterNumber: 3, title: 'Three', summary: 'c' },
    ]);
  });

  it('returns the full plan when nothing has been drafted yet', () => {
    expect(selectChapterPlansToWrite(blueprint, [])).toEqual(blueprint);
  });

  it('returns nothing when every chapter is drafted', () => {
    expect(selectChapterPlansToWrite(blueprint, [
      { chapterNumber: 1 },
      { chapterNumber: 2 },
      { chapterNumber: 3 },
    ])).toEqual([]);
  });
});

describe('rolling digest chronology', () => {
  it('preserves chronological order in earlierDigest even when input is shuffled', () => {
    const sources = [
      { chapterNumber: 3, title: 'Three', content: 'tail-three', summary: 's3', keyFacts: null },
      { chapterNumber: 1, title: 'One', content: 'tail-one', summary: 's1', keyFacts: null },
      { chapterNumber: 2, title: 'Two', content: 'tail-two', summary: 's2', keyFacts: null },
    ];
    const result = buildRollingDigest(sources, 1);
    // window=1 ⇒ only ch 3 is in recent, ch 1+2 are earlier in chronological order.
    const idx1 = result.earlierDigest.indexOf('Ch.1');
    const idx2 = result.earlierDigest.indexOf('Ch.2');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(result.recentTails).toContain('Ch.3');
  });

  it('substitutes a live-content excerpt for a stale summary', () => {
    const sources = [
      {
        chapterNumber: 1,
        title: 'One',
        content: 'The rewritten opening where the hero refuses the call.',
        summary: 'OUTDATED: hero accepts the call eagerly.',
        summaryStale: true,
        keyFacts: null,
      },
      { chapterNumber: 2, title: 'Two', content: 'tail-two', summary: 's2', keyFacts: null },
      { chapterNumber: 3, title: 'Three', content: 'tail-three', summary: 's3', keyFacts: null },
    ];
    const result = buildRollingDigest(sources, 1);
    expect(result.earlierDigest).not.toContain('OUTDATED');
    expect(result.earlierDigest).toContain('hero refuses the call');
    // Fresh summaries still pass through untouched.
    expect(result.earlierDigest).toContain('Ch.2 Two: s2');
  });
});

describe('post-generation schemas', () => {
  it('ChapterSummarySchema accepts valid input', () => {
    const ok = ChapterSummarySchema.safeParse({
      summary: 'A concise digest of the chapter that exceeds the minimum length and gives a useful recap.',
      keyFacts: { characters: ['Alice'], locations: ['Town'], items: [], plotMoves: ['Alice arrives'] },
    });
    expect(ok.success).toBe(true);
  });

  it('ChapterSummarySchema rejects empty summary', () => {
    const fail = ChapterSummarySchema.safeParse({
      summary: 'too short',
      keyFacts: { characters: [], locations: [], items: [], plotMoves: ['x'] },
    });
    expect(fail.success).toBe(false);
  });

  it('ChapterSummarySchema bounds generated key-fact text before DB/prompt reuse', () => {
    const fail = ChapterSummarySchema.safeParse({
      summary: 'A concise digest of the chapter that exceeds the minimum length and gives a useful recap.',
      keyFacts: {
        characters: ['A'.repeat(CHAPTER_POST_GENERATION_LIMITS.keyFactText + 1)],
        locations: [],
        items: [],
        plotMoves: ['Alice arrives'],
      },
    });
    expect(fail.success).toBe(false);
  });

  it('ChapterQualitySchema accepts a clean review', () => {
    const ok = ChapterQualitySchema.safeParse({
      consistencyIssues: [],
      overallScore: 95,
    });
    expect(ok.success).toBe(true);
  });

  it('ChapterQualitySchema bounds issue count and generated descriptions', () => {
    const tooManyIssues = ChapterQualitySchema.safeParse({
      consistencyIssues: Array.from({ length: CHAPTER_POST_GENERATION_LIMITS.qualityIssues + 1 }, () => ({
        type: 'other',
        description: 'drift',
        severity: 'minor',
      })),
      overallScore: 70,
    });
    expect(tooManyIssues.success).toBe(false);

    const oversizedDescription = ChapterQualitySchema.safeParse({
      consistencyIssues: [{
        type: 'other',
        description: 'x'.repeat(CHAPTER_POST_GENERATION_LIMITS.qualityIssueDescription + 1),
        severity: 'minor',
      }],
      overallScore: 70,
    });
    expect(oversizedDescription.success).toBe(false);
  });

  it('UnificationReportSchema accepts an edit set', () => {
    const ok = UnificationReportSchema.safeParse({
      edits: [
        {
          chapterNumber: 2,
          original: 'Alis stepped into the room',
          replacement: 'Alice stepped into the room',
          rationale: 'Spelling drift from chapter 1.',
          severity: 'minor',
        },
      ],
      summary: 'One spelling fix.',
    });
    expect(ok.success).toBe(true);

    const exactTarget = UnificationReportSchema.parse({
      edits: [
        {
          chapterNumber: 2,
          original: '\nAlis stepped into the room ',
          replacement: 'Alice stepped into the room',
          rationale: 'Spelling drift from chapter 1.',
          severity: 'minor',
        },
      ],
      summary: 'One spelling fix.',
    });
    expect(exactTarget.edits[0].original).toBe('\nAlis stepped into the room ');
  });

  it('UnificationReportSchema bounds generated edit counts and text fields', () => {
    const tooMany = UnificationReportSchema.safeParse({
      edits: Array.from({ length: UNIFICATION_REPORT_LIMITS.edits + 1 }, () => ({
        chapterNumber: 1,
        original: 'A',
        replacement: 'B',
        rationale: 'continuity',
        severity: 'minor',
      })),
      summary: 'bounded',
    });
    expect(tooMany.success).toBe(false);

    const oversizedText = UnificationReportSchema.safeParse({
      edits: [{
        chapterNumber: 1,
        original: 'A'.repeat(UNIFICATION_REPORT_LIMITS.original + 1),
        replacement: 'B',
        rationale: 'continuity',
        severity: 'minor',
      }],
      summary: 'bounded',
    });
    expect(oversizedText.success).toBe(false);
  });
});

describe('unification batching', () => {
  it('splits long manuscripts into bounded ordered batches', () => {
    const chapters = Array.from({ length: 5 }, (_, idx) => ({
      chapterNumber: idx + 1,
      title: `Chapter ${idx + 1}`,
      content: 'x'.repeat(900),
    }));

    const batches = buildUnificationBatches(chapters, 2000);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map(ch => ch.chapterNumber)).toEqual([1, 2, 3, 4, 5]);
    for (const batch of batches) {
      const size = batch.reduce((sum, ch) => sum + ch.title.length + ch.content.length + 32, 0);
      expect(size).toBeLessThanOrEqual(2000);
    }
  });
});
