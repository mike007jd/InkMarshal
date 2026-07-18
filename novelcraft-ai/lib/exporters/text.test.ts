import { describe, expect, it } from 'vitest';

import { buildChapterTxt, buildNovelTxt } from '@/lib/exporters/text';

const novel = {
  title: 'CRLF Novel',
  genre: 'Drama',
  storySummary: 'Line one\r\nLine two',
  characterSummary: '',
  arcSummary: '',
};

describe('text exporter line-ending normalization (E7)', () => {
  it('strips CRLF/CR from chapter content in buildChapterTxt', () => {
    const out = buildChapterTxt({
      chapterNumber: 1,
      title: 'Opening',
      content: 'First\r\nSecond\rThird\nFourth',
    });
    expect(out).not.toContain('\r');
    expect(out).toContain('First\nSecond\nThird\nFourth');
  });

  it('strips CRLF from chapter content and frontmatter in buildNovelTxt', () => {
    const out = buildNovelTxt(novel, [
      {
        chapterNumber: 1,
        title: 'Opening',
        content: 'Alpha\r\nBeta',
      },
    ]);
    expect(out).not.toContain('\r');
    expect(out).toContain('Story Summary\nLine one\nLine two');
    expect(out).toContain('Alpha\nBeta');
  });
});
