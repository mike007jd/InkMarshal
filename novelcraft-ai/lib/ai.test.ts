import { describe, expect, it } from 'vitest';

import {
  BookBlueprintSchema,
  buildNovelLanguageSignals,
  buildRollingDigest,
  CHAPTER_BLUEPRINT_LIMITS,
  CHAPTER_EDIT_LIMITS,
  CHAPTER_POST_GENERATION_LIMITS,
  ChapterEditSchema,
  GREENLIGHT_PACK_LIMITS,
  GreenlightPackSchema,
  getTargetChapterCount,
  getTargetWordsPerChapter,
  MAX_CHAPTER_COUNT,
  MAX_TARGET_WORDS,
  MIN_CHAPTER_COUNT,
  selectChapterPlansToWrite,
} from '@/lib/ai';

describe('long-form writing plan helpers', () => {
  it('bounds greenlight pack fields before they can be persisted as novel context', () => {
    expect(() => GreenlightPackSchema.parse({
      title: '  Bounded Title  ',
      genre: 'fantasy',
      storySummary: 'S'.repeat(GREENLIGHT_PACK_LIMITS.storySummary),
      characterSummary: 'C'.repeat(GREENLIGHT_PACK_LIMITS.characterSummary),
      arcSummary: 'A'.repeat(GREENLIGHT_PACK_LIMITS.arcSummary),
    })).not.toThrow();

    const parsed = GreenlightPackSchema.parse({
      title: '  Bounded Title  ',
      genre: ' fantasy ',
      storySummary: 'story',
      characterSummary: 'characters',
      arcSummary: 'arc',
    });
    expect(parsed.title).toBe('Bounded Title');
    expect(parsed.genre).toBe('fantasy');

    expect(GreenlightPackSchema.safeParse({
      title: 'x'.repeat(GREENLIGHT_PACK_LIMITS.title + 1),
      genre: 'fantasy',
      storySummary: 'story',
      characterSummary: 'characters',
      arcSummary: 'arc',
    }).success).toBe(false);
    expect(GreenlightPackSchema.safeParse({
      title: 'ok',
      genre: 'fantasy',
      storySummary: 'S'.repeat(GREENLIGHT_PACK_LIMITS.storySummary + 1),
      characterSummary: 'characters',
      arcSummary: 'arc',
    }).success).toBe(false);
  });

  it('bounds chapter edit model output before edit chat persistence', () => {
    expect(ChapterEditSchema.safeParse({
      changes: [{
        original: 'o'.repeat(CHAPTER_EDIT_LIMITS.original),
        replacement: 'r'.repeat(CHAPTER_EDIT_LIMITS.replacement),
      }],
      summary: 's'.repeat(CHAPTER_EDIT_LIMITS.summary),
    }).success).toBe(true);

    const exactTarget = ChapterEditSchema.parse({
      changes: [{ original: '  old line\n', replacement: 'new' }],
      summary: 'kept exact target',
    });
    expect(exactTarget.changes[0].original).toBe('  old line\n');
    expect(ChapterEditSchema.safeParse({
      changes: [{ original: '  \n\t', replacement: 'new' }],
      summary: 'blank target',
    }).success).toBe(false);

    expect(ChapterEditSchema.safeParse({
      changes: Array.from({ length: CHAPTER_EDIT_LIMITS.changes + 1 }, () => ({
        original: 'old',
        replacement: 'new',
      })),
      summary: 'ok',
    }).success).toBe(false);
    expect(ChapterEditSchema.safeParse({
      changes: [{
        original: 'o'.repeat(CHAPTER_EDIT_LIMITS.original + 1),
        replacement: 'new',
      }],
      summary: 'ok',
    }).success).toBe(false);
    expect(ChapterEditSchema.safeParse({
      changes: [{ original: 'old', replacement: 'new' }],
      summary: 's'.repeat(CHAPTER_EDIT_LIMITS.summary + 1),
    }).success).toBe(false);
  });

  it('scales chapter count from target word count instead of forcing a demo outline', () => {
    expect(getTargetChapterCount(40_000)).toBe(8);
    expect(getTargetChapterCount(100_000)).toBe(20);
    expect(getTargetChapterCount(200_000)).toBe(40);
  });

  it('uses tighter chapters for very long novels', () => {
    // 500k @ 4k per chapter ⇒ ~125 chapters
    expect(getTargetChapterCount(500_000)).toBe(125);
    // 1M @ 3.5k per chapter ⇒ ~286 chapters
    expect(getTargetChapterCount(1_000_000)).toBe(286);
  });

  it('does not squeeze maximum-length novels into oversized chapters', () => {
    const chapterCount = getTargetChapterCount(MAX_TARGET_WORDS);
    expect(chapterCount).toBeGreaterThan(300);
    expect(getTargetWordsPerChapter(MAX_TARGET_WORDS, chapterCount)).toBeLessThanOrEqual(5000);
  });

  it('clamps to MIN/MAX chapter counts and tolerates extremes', () => {
    expect(getTargetChapterCount(0)).toBe(MIN_CHAPTER_COUNT);
    expect(getTargetChapterCount(-1)).toBe(MIN_CHAPTER_COUNT);
    expect(getTargetChapterCount(MAX_TARGET_WORDS * 10)).toBeLessThanOrEqual(MAX_CHAPTER_COUNT);
  });

  it('derives a per-chapter word target from target words and chapter count', () => {
    expect(getTargetWordsPerChapter(100_000, 20)).toBe(5000);
    expect(getTargetWordsPerChapter(2_000_000, 300)).toBe(5000);
  });

  it('resumes by writing only missing chapters', () => {
    const blueprint = [
      { chapterNumber: 1, title: 'One', summary: 'Opening' },
      { chapterNumber: 2, title: 'Two', summary: 'Escalation' },
      { chapterNumber: 3, title: 'Three', summary: 'Turn' },
    ];

    expect(selectChapterPlansToWrite(blueprint, [{ chapterNumber: 1 }, { chapterNumber: 3 }]))
      .toEqual([{ chapterNumber: 2, title: 'Two', summary: 'Escalation' }]);
  });

  it('requires generated blueprints to be sequential and bounded before outline persistence', () => {
    expect(BookBlueprintSchema.safeParse({
      chapters: [
        { chapterNumber: 1, title: 'One', summary: 'Opening' },
        { chapterNumber: 2, title: 'Two', summary: 'Escalation' },
        { chapterNumber: 3, title: 'Three', summary: 'Turn' },
      ],
    }).success).toBe(true);

    expect(BookBlueprintSchema.safeParse({
      chapters: [
        { chapterNumber: 1, title: 'One', summary: 'Opening' },
        { chapterNumber: 1, title: 'Duplicate', summary: 'Duplicate number' },
        { chapterNumber: 3, title: 'Three', summary: 'Turn' },
      ],
    }).success).toBe(false);

    expect(BookBlueprintSchema.safeParse({
      chapters: [
        { chapterNumber: 1, title: 'One', summary: 'Opening' },
        { chapterNumber: 3, title: 'Gap', summary: 'Skipped chapter two' },
        { chapterNumber: 4, title: 'Four', summary: 'Turn' },
      ],
    }).success).toBe(false);

    expect(BookBlueprintSchema.safeParse({
      chapters: [
        { chapterNumber: 1, title: 'x'.repeat(CHAPTER_BLUEPRINT_LIMITS.title + 1), summary: 'Opening' },
        { chapterNumber: 2, title: 'Two', summary: 'Escalation' },
        { chapterNumber: 3, title: 'Three', summary: 'Turn' },
      ],
    }).success).toBe(false);
  });

  it('uses novel fields as language signals when structured interview has no chat history', () => {
    expect(buildNovelLanguageSignals({
      title: '未命名草稿',
      genre: '奇幻',
      storySummary: '故事发生在海上王国。',
      characterSummary: '',
      arcSummary: '',
    }, [])).toContain('故事发生在海上王国。');
  });
});

describe('buildRollingDigest', () => {
  const makeChapter = (n: number, content: string, summary = `summary ${n}`) => ({
    chapterNumber: n,
    title: `Ch ${n}`,
    content,
    summary,
    keyFacts: { characters: [`hero ${n}`], locations: [], items: [], plotMoves: [`move ${n}`] },
  });

  it('returns empty when no history', () => {
    expect(buildRollingDigest([])).toEqual({ recentTails: '', earlierDigest: '' });
  });

  it('still emits volume summaries when history is empty (chat/outline/unify ops)', () => {
    // These ops skip loading per-chapter tails but must still receive the
    // folded volume memory — the early-return used to drop it entirely.
    const result = buildRollingDigest([], 0, 1500, {
      volumeSummaries: [
        { start: 1, end: 10, summary: 'Act one: the heist goes wrong.' },
        { start: 11, end: 20, summary: 'Act two: the fallout.' },
      ],
    });
    expect(result.recentTails).toBe('');
    expect(result.earlierDigest).toContain('Volumes 1-10: Act one: the heist goes wrong.');
    expect(result.earlierDigest).toContain('Volumes 11-20: Act two: the fallout.');
  });

  it('puts the only chapter in recentTails when window=2', () => {
    const result = buildRollingDigest([makeChapter(1, 'Hello world.')], 2);
    expect(result.recentTails).toContain('Ch.1');
    expect(result.recentTails).toContain('Hello world.');
    expect(result.earlierDigest).toBe('');
  });

  it('rolls older chapters into earlierDigest beyond the window', () => {
    const chapters = [1, 2, 3, 4, 5].map(n => makeChapter(n, `prose ${n}`.repeat(200)));
    const result = buildRollingDigest(chapters, 2, 100);
    // last 2 chapters in recentTails
    expect(result.recentTails).toContain('Ch.4');
    expect(result.recentTails).toContain('Ch.5');
    expect(result.recentTails).not.toContain('Ch.3');
    // earlier 3 chapters in earlierDigest with key-fact lines
    expect(result.earlierDigest).toContain('Ch.1');
    expect(result.earlierDigest).toContain('Ch.2');
    expect(result.earlierDigest).toContain('Ch.3');
    expect(result.earlierDigest).toContain('chars: hero 1');
  });

  it('truncates chapter tails to the requested character budget', () => {
    const long = 'x'.repeat(10_000);
    const result = buildRollingDigest([makeChapter(1, long)], 2, 200);
    // tail length is 200 + the prefix label
    const tailMatch = result.recentTails.match(/x+/);
    expect(tailMatch).not.toBeNull();
    expect(tailMatch![0].length).toBe(200);
  });

  it('clamps stale oversized key facts before building earlierDigest', () => {
    const longFact = 'A'.repeat(CHAPTER_POST_GENERATION_LIMITS.keyFactText + 50);
    const result = buildRollingDigest([
      {
        chapterNumber: 1,
        title: 'Old',
        content: 'old prose',
        summary: 'old summary',
        keyFacts: { characters: [longFact], locations: [], items: [], plotMoves: [longFact] },
      },
      makeChapter(2, 'recent prose'),
    ], 1);

    expect(result.earlierDigest).toContain('A'.repeat(CHAPTER_POST_GENERATION_LIMITS.keyFactText));
    expect(result.earlierDigest).not.toContain('A'.repeat(CHAPTER_POST_GENERATION_LIMITS.keyFactText + 1));
  });
});
