import { describe, expect, it } from 'vitest';

import {
  CHAPTER_REGEX,
  VOLUME_REGEX,
  detectChapters,
  renumberCandidates,
} from '@/lib/import/detect-chapters';
import { parseText } from '@/lib/import/parse-text';
import { htmlToBlocks } from '@/lib/import/parse-docx';
import type { RawDocument } from '@/lib/import/types';

function doc(blocks: RawDocument['blocks']): RawDocument {
  return { source: 'txt', filename: 'm.txt', blocks };
}

describe('VOLUME_REGEX / CHAPTER_REGEX', () => {
  it('matches Chinese volume markers as whole lines', () => {
    expect(VOLUME_REGEX.test('第一卷')).toBe(true);
    expect(VOLUME_REGEX.test('第1卷 风起云涌')).toBe(true);
    expect(VOLUME_REGEX.test('卷三')).toBe(true);
    expect(VOLUME_REGEX.test('Volume 2')).toBe(true);
    expect(VOLUME_REGEX.test('Book Three')).toBe(true);
  });

  it('matches Chinese + English chapter markers', () => {
    expect(CHAPTER_REGEX.test('第一章')).toBe(true);
    expect(CHAPTER_REGEX.test('第 12 章 启程')).toBe(true);
    expect(CHAPTER_REGEX.test('Chapter 7')).toBe(true);
    expect(CHAPTER_REGEX.test('Chapter VII')).toBe(true);
    expect(CHAPTER_REGEX.test('序章')).toBe(true);
    expect(CHAPTER_REGEX.test('楔子')).toBe(true);
    expect(CHAPTER_REGEX.test('Prologue')).toBe(true);
  });

  it('does NOT match a sentence that merely mentions 章/卷', () => {
    expect(CHAPTER_REGEX.test('他翻到了第三章的某一页继续读了下去，思绪万千。')).toBe(false);
    expect(VOLUME_REGEX.test('这卷宗里记录着许多不为人知的往事，长达数百页之多。')).toBe(false);
  });
});

describe('detectChapters — TXT regex heuristic', () => {
  it('splits 第X卷 / 第X章 into a volume → chapter tree', () => {
    const text = [
      '第一卷 启程',
      '',
      '第一章 出发',
      '主角离开了村庄。',
      '前路漫漫。',
      '',
      '第二章 抵达',
      '他到了城里。',
      '',
      '第二卷 风云',
      '',
      '第三章 变故',
      '风暴来临。',
    ].join('\n');

    const parsed = parseText(text, 'm.txt', 'txt');
    const chapters = detectChapters(parsed);

    expect(chapters).toHaveLength(3);
    expect(chapters[0].title).toBe('第一章 出发');
    expect(chapters[0].volumeTitle).toBe('第一卷 启程');
    expect(chapters[0].content).toContain('主角离开了村庄。');
    expect(chapters[0].content).toContain('前路漫漫。');
    expect(chapters[1].title).toBe('第二章 抵达');
    expect(chapters[1].volumeTitle).toBe('第一卷 启程');
    expect(chapters[2].title).toBe('第三章 变故');
    expect(chapters[2].volumeTitle).toBe('第二卷 风云');
    expect(chapters[2].chapterNumber).toBe(3);
  });

  it('keeps a running chapter number across volumes', () => {
    const text = '第一章 a\n正文一\n第二章 b\n正文二\n第三章 c\n正文三';
    const chapters = detectChapters(parseText(text, 'm.txt', 'txt'));
    expect(chapters.map(c => c.chapterNumber)).toEqual([1, 2, 3]);
  });

  it('marks regex-detected boundaries as inferred (no heading style)', () => {
    const chapters = detectChapters(parseText('第一章\n正文', 'm.txt', 'txt'));
    expect(chapters[0].inferred).toBe(true);
  });

  it('falls back to a single chapter when no markers exist', () => {
    const text = '这是一段没有任何章节标记的散文。\n\n第二段继续。';
    const chapters = detectChapters(parseText(text, 'm.txt', 'txt'));
    expect(chapters).toHaveLength(1);
    expect(chapters[0].content).toContain('这是一段');
    expect(chapters[0].content).toContain('第二段继续。');
    expect(chapters[0].inferred).toBe(false);
  });

  it('keeps prose before the first chapter as an implicit opening chapter', () => {
    const text = '楔子前的引言。\n\n第一章 正题\n正文';
    const chapters = detectChapters(parseText(text, 'm.txt', 'txt'));
    expect(chapters[0].content).toContain('引言');
    expect(chapters[1].title).toBe('第一章 正题');
  });

  it('skips InkMarshal TXT export metadata before the first chapter', () => {
    const text = [
      'The Aurelian Archive',
      'Genre: Literary speculative mystery',
      'Story Summary',
      'A city repairs itself.',
      'Character Summary',
      'Mara carries the compass.',
      'Plot Arc',
      'Discovery, fracture, repair.',
      'Chapter 1: One',
      'Body one.',
      '',
      'Chapter 2: Two',
      'Body two.',
    ].join('\n');

    const chapters = detectChapters(parseText(text, 'export.txt', 'txt'));
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('Chapter 1: One');
    expect(chapters[0].content).toBe('Body one.');
  });
});

describe('detectChapters — Markdown heading levels', () => {
  it('maps # to volume and ## to chapter', () => {
    const md = [
      '# Volume One',
      '',
      '## Chapter 1',
      'Body of one.',
      '',
      '## Chapter 2',
      'Body of two.',
    ].join('\n');

    const chapters = detectChapters(parseText(md, 'm.md', 'md'));
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('Chapter 1');
    expect(chapters[0].volumeTitle).toBe('Volume One');
    expect(chapters[0].inferred).toBe(false);
    expect(chapters[1].title).toBe('Chapter 2');
  });

  it('treats a # heading that reads like a chapter as a chapter', () => {
    const md = '# 第一章 开端\n正文内容';
    const chapters = detectChapters(parseText(md, 'm.md', 'md'));
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('第一章 开端');
    expect(chapters[0].volumeTitle).toBeNull();
  });
});

describe('detectChapters — DOCX Heading + bold-line fallback', () => {
  it('splits real h1/h2 headings into volume/chapter', () => {
    const html = '<h1>卷一</h1><h2>第一章</h2><p>正文甲。</p><h2>第二章</h2><p>正文乙。</p>';
    const blocks = htmlToBlocks(html);
    const chapters = detectChapters(doc(blocks));
    expect(chapters).toHaveLength(2);
    expect(chapters[0].volumeTitle).toBe('卷一');
    expect(chapters[0].title).toBe('第一章');
    expect(chapters[0].content).toBe('正文甲。');
    expect(chapters[0].inferred).toBe(false);
  });

  it('promotes a wholly-bold short standalone line to an inferred chapter', () => {
    const html = '<p><strong>第一章 风起</strong></p><p>正文段落。</p><p>普通段落不是标题。</p>';
    const blocks = htmlToBlocks(html);
    // The bold line matches the chapter regex too, but even a non-matching bold
    // title would be promoted via the inferred-heading fallback.
    const chapters = detectChapters(doc(blocks));
    expect(chapters[0].title).toBe('第一章 风起');
    expect(chapters[0].inferred).toBe(true);
    expect(chapters[0].content).toContain('正文段落。');
  });

  it('promotes a bold title that does NOT match the chapter regex (pure bold heuristic)', () => {
    const html = '<p><strong>静夜思</strong></p><p>窗前明月光。</p>';
    const blocks = htmlToBlocks(html);
    const chapters = detectChapters(doc(blocks));
    expect(chapters[0].title).toBe('静夜思');
    expect(chapters[0].inferred).toBe(true);
  });

  it('does NOT treat a long bold sentence as a title', () => {
    const longBold = '这是一句非常长的加粗句子，它本身是正文的一部分而绝不应该被当作章节标题来切分整部书稿。';
    const html = `<p><strong>${longBold}</strong></p><p>下一段。</p>`;
    const blocks = htmlToBlocks(html);
    const chapters = detectChapters(doc(blocks));
    // No heading detected → single fallback chapter containing the bold line.
    expect(chapters).toHaveLength(1);
    expect(chapters[0].content).toContain(longBold);
  });
});

describe('renumberCandidates', () => {
  it('re-sequences numbers + ids + recomputes word count after an edit', () => {
    const chapters = detectChapters(
      parseText('第一章\n甲\n第二章\n乙\n第三章\n丙', 'm.txt', 'txt'),
    );
    // Drop the middle chapter and renumber.
    const next = renumberCandidates([chapters[0], chapters[2]]);
    expect(next.map(c => c.chapterNumber)).toEqual([1, 2]);
    expect(next[1].id).toBe('cand-2');
    expect(next[1].wordCount).toBeGreaterThan(0);
  });

  it('fills an empty title with a deterministic default', () => {
    const next = renumberCandidates([
      {
        id: 'x',
        chapterNumber: 5,
        title: '   ',
        volumeTitle: null,
        content: 'body',
        wordCount: 1,
        inferred: false,
      },
    ]);
    expect(next[0].title).toBe('Chapter 1');
  });
});
