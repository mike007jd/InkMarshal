import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { buildNovelPdfBuffer, CJKNotSupportedError } from '@/lib/exporters/pdf';

const baseNovel = {
  title: 'Plain Novel',
  genre: 'Fantasy',
  storySummary: '',
  characterSummary: '',
  arcSummary: '',
};

const baseChapters = [
  {
    chapterNumber: 1,
    title: 'Opening',
    content: 'Plain ascii chapter content.',
  },
];

async function pageCount(buffer: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(buffer);
  return pdf.getPageCount();
}

describe('PDF exporter', () => {
  it('renders CJK frontmatter and content via the bundled Unicode font', async () => {
    const buffer = await buildNovelPdfBuffer(
      {
        ...baseNovel,
        title: '九州奇缘',
        storySummary: '一个关于宿命与抉择的故事。',
      },
      [
        {
          chapterNumber: 1,
          title: '第一章：风起',
          content: '夜色如墨，长街无人。\n\n他提着灯笼缓缓走过石桥，桥下的河水映着一弯残月。',
        },
      ]
    );
    expect(await pageCount(buffer)).toBeGreaterThan(0);
  });

  it.each([
    ['Cyrillic', 'Привет, мир'],
    ['accented Latin', 'Café résumé naïve Zürich'],
    ['Japanese', '吾輩は猫である。名前はまだ無い。'],
  ])('renders %s via the bundled Unicode font', async (_label, content) => {
    const buffer = await buildNovelPdfBuffer(baseNovel, [
      { ...baseChapters[0], content },
    ]);
    expect(await pageCount(buffer)).toBeGreaterThan(0);
  });

  it.each([
    ['Arabic', 'مرحبا بالعالم'],
    ['accented Greek', 'Καλημέρα'],
  ])('rejects %s (no glyph coverage) instead of emitting tofu', async (_label, content) => {
    await expect(
      buildNovelPdfBuffer(baseNovel, [
        { ...baseChapters[0], content },
      ])
    ).rejects.toBeInstanceOf(CJKNotSupportedError);
  });

  it('wraps long unspaced CJK paragraphs across lines and pages', async () => {
    const longParagraph = '春江潮水连海平，海上明月共潮生。滟滟随波千万里，何处春江无月明。'.repeat(60);
    const buffer = await buildNovelPdfBuffer(baseNovel, [
      { ...baseChapters[0], title: '长段落', content: longParagraph },
    ]);
    expect(await pageCount(buffer)).toBeGreaterThan(1);
  });

  it('does not reject content with a literal ASCII question mark', async () => {
    const buffer = await buildNovelPdfBuffer(baseNovel, [
      { ...baseChapters[0], content: 'Is this real? Yes, it is.' },
    ]);
    expect(await pageCount(buffer)).toBeGreaterThan(0);
  });

  it('does not reject content that only uses curated mapped punctuation', async () => {
    // “smart quotes” — em dash … all map to ASCII, no "?" sentinel.
    const buffer = await buildNovelPdfBuffer(baseNovel, [
      { ...baseChapters[0], content: '“Hello” — she said…' },
    ]);
    expect(await pageCount(buffer)).toBeGreaterThan(0);
  });

  it('builds a readable PDF when ASCII frontmatter fields are present', async () => {
    const buffer = await buildNovelPdfBuffer(
      {
        ...baseNovel,
        storySummary: 'A clear premise.',
        characterSummary: 'A focused protagonist.',
        arcSummary: 'A resolved arc.',
      },
      baseChapters
    );
    expect(await pageCount(buffer)).toBeGreaterThan(0);
  });
});
