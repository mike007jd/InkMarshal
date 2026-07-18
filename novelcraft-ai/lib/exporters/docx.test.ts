import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  buildChapterDocxBuffer,
  buildNovelDocxBuffer,
} from '@/lib/exporters/docx';

const baseNovel = {
  title: 'Plain Novel',
  genre: 'Fantasy',
  storySummary: '',
  characterSummary: '',
  arcSummary: '',
};

const baseChapter = {
  chapterNumber: 1,
  title: 'Opening',
  content: 'Plain ascii chapter content.',
};

/** Unzip the .docx and return the decoded main document part. */
function documentXml(buffer: Uint8Array): string {
  const entry = unzipSync(buffer)['word/document.xml'];
  expect(entry).toBeDefined();
  return strFromU8(entry);
}

describe('DOCX exporter', () => {
  it('writes title, front matter, and chapter content into the document part', async () => {
    const xml = documentXml(
      await buildNovelDocxBuffer(
        {
          ...baseNovel,
          storySummary: 'A tale of fate.',
          characterSummary: 'One stubborn hero.',
          arcSummary: 'Rise, fall, rise again.',
        },
        [baseChapter]
      )
    );

    expect(xml).toContain('Plain Novel');
    expect(xml).toContain('Genre: Fantasy');
    expect(xml).toContain('A tale of fate.');
    expect(xml).toContain('One stubborn hero.');
    expect(xml).toContain('Rise, fall, rise again.');
    expect(xml).toContain('Chapter 1: Opening');
    expect(xml).toContain('Plain ascii chapter content.');
  });

  it('preserves CJK frontmatter, chapter titles, and body text verbatim', async () => {
    const xml = documentXml(
      await buildNovelDocxBuffer(
        {
          ...baseNovel,
          title: '九州奇缘',
          storySummary: '一个关于宿命与抉择的故事。',
        },
        [
          {
            chapterNumber: 1,
            title: '第一章：风起',
            content: '夜色如墨，长街无人。\n他提着灯笼缓缓走过石桥。',
          },
        ]
      )
    );

    expect(xml).toContain('九州奇缘');
    expect(xml).toContain('一个关于宿命与抉择的故事。');
    expect(xml).toContain('Chapter 1: 第一章：风起');
    expect(xml).toContain('夜色如墨，长街无人。');
    expect(xml).toContain('他提着灯笼缓缓走过石桥。');
  });

  it('splits CRLF/LF content into separate paragraphs without stray \\r', async () => {
    const xml = documentXml(
      await buildNovelDocxBuffer(baseNovel, [
        { ...baseChapter, content: 'First line.\r\nSecond line.\rThird line.' },
      ])
    );

    expect(xml).toContain('First line.');
    expect(xml).toContain('Second line.');
    expect(xml).toContain('Third line.');
    expect(xml).not.toContain('First line.\r');
    expect(xml).not.toContain('First line.Second');
  });

  it('escapes XML-significant characters instead of corrupting the document', async () => {
    const xml = documentXml(
      await buildNovelDocxBuffer(baseNovel, [
        { ...baseChapter, content: 'Fish & chips <for> "everyone".' },
      ])
    );

    expect(xml).toContain('Fish &amp; chips &lt;for&gt;');
    expect(xml).not.toContain('<for>');
  });

  it('builds a standalone chapter document with heading and CJK body', async () => {
    const xml = documentXml(
      await buildChapterDocxBuffer({
        chapterNumber: 3,
        title: '雪夜',
        content: '风雪夜归人。',
      })
    );

    expect(xml).toContain('Chapter 3: 雪夜');
    expect(xml).toContain('风雪夜归人。');
  });
});
