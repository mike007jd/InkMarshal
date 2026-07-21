import { describe, expect, it } from 'vitest';

import { findPageIndexForSourceOffset, paginateManuscript } from '@/lib/pagination';

const sourceChapter = {
  id: 'chapter-anchor',
  chapterNumber: 3,
  title: 'Anchored chapter',
  content: Array.from({ length: 500 }, (_, index) => `word-${index}`).join(' '),
};

describe('manuscript pagination source anchors', () => {
  it('maps the same source passage after a larger book reduces page count', () => {
    const before = paginateManuscript([sourceChapter], { charsPerPage: 240, chapterTitleReserve: 0 });
    const previousPage = before[Math.floor(before.length * 0.7)];
    const sourceOffset = previousPage.sourceStart
      + Math.floor((previousPage.sourceEnd - previousPage.sourceStart) / 2);

    const after = paginateManuscript([sourceChapter], { charsPerPage: 520, chapterTitleReserve: 0 });
    const target = findPageIndexForSourceOffset(after, sourceChapter.chapterNumber, sourceOffset);

    expect(after.length).toBeLessThan(before.length);
    expect(target).toBeGreaterThan(0);
    expect(after[target].sourceStart).toBeLessThanOrEqual(sourceOffset);
    expect(after[target].sourceEnd).toBeGreaterThan(sourceOffset);
  });

  it('falls back to the nearest page when the source offset is outside a chapter', () => {
    const pages = paginateManuscript([sourceChapter], { charsPerPage: 400, chapterTitleReserve: 0 });

    expect(findPageIndexForSourceOffset(pages, 3, -10)).toBe(0);
    expect(findPageIndexForSourceOffset(pages, 3, Number.MAX_SAFE_INTEGER)).toBe(pages.length - 1);
    expect(findPageIndexForSourceOffset(pages, 99, 0)).toBe(-1);
  });

  it('keeps CJK sourceStart/sourceEnd offsets mappable after re-pagination', () => {
    const cjkChapter = {
      id: 'cjk-anchor',
      chapterNumber: 1,
      title: '中文章节',
      content: '春江潮水连海平，海上明月共潮生。'.repeat(80),
    };
    const before = paginateManuscript([cjkChapter], { charsPerPage: 96, chapterTitleReserve: 0 });
    expect(before.length).toBeGreaterThan(2);

    const previousPage = before[Math.floor(before.length * 0.6)];
    const sourceOffset = previousPage.sourceStart
      + Math.floor((previousPage.sourceEnd - previousPage.sourceStart) / 2);

    const after = paginateManuscript([cjkChapter], { charsPerPage: 240, chapterTitleReserve: 0 });
    const target = findPageIndexForSourceOffset(after, cjkChapter.chapterNumber, sourceOffset);

    expect(after.length).toBeLessThan(before.length);
    expect(target).toBeGreaterThanOrEqual(0);
    expect(after[target].sourceStart).toBeLessThanOrEqual(sourceOffset);
    expect(after[target].sourceEnd).toBeGreaterThan(sourceOffset);
    expect(cjkChapter.content.slice(after[target].sourceStart, after[target].sourceEnd))
      .toContain(cjkChapter.content.slice(sourceOffset, sourceOffset + 1));
  });
});
