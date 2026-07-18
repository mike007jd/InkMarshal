import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

import type { ExportChapterLike, ExportNovelLike } from '@/lib/exporters/text';
import { normalizeLineEndings } from '@/lib/exporters/text';

function buildNovelDocument(
  novel: ExportNovelLike,
  chapters: ExportChapterLike[]
): Document {
  return new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun({ text: novel.title, bold: true, size: 34 })],
          }),
          ...buildNovelFrontMatter(novel),
          ...chapters.flatMap(buildChapterParagraphs),
        ],
      },
    ],
  });
}

function buildChapterDocument(chapter: ExportChapterLike): Document {
  return new Document({
    sections: [
      {
        children: buildChapterParagraphs(chapter),
      },
    ],
  });
}

/**
 * Server path (Next route, Node sidecar) — `Packer.toBuffer` returns a Node
 * `Buffer` and depends on the `Buffer` global. Do NOT call from the webview.
 */
export async function buildNovelDocxBuffer(
  novel: ExportNovelLike,
  chapters: ExportChapterLike[]
): Promise<Uint8Array<ArrayBufferLike>> {
  return new Uint8Array(await Packer.toBuffer(buildNovelDocument(novel, chapters)));
}

export async function buildChapterDocxBuffer(
  chapter: ExportChapterLike
): Promise<Uint8Array<ArrayBufferLike>> {
  return new Uint8Array(await Packer.toBuffer(buildChapterDocument(chapter)));
}

/**
 * Client path (Tauri webview / browser) — `Packer.toBlob` is the browser-safe
 * API and does not touch the absent Node `Buffer` global.
 */
export async function buildNovelDocxBlob(
  novel: ExportNovelLike,
  chapters: ExportChapterLike[]
): Promise<Blob> {
  return Packer.toBlob(buildNovelDocument(novel, chapters));
}

export async function buildChapterDocxBlob(
  chapter: ExportChapterLike
): Promise<Blob> {
  return Packer.toBlob(buildChapterDocument(chapter));
}

function buildNovelFrontMatter(novel: ExportNovelLike): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  if (novel.genre) {
    paragraphs.push(new Paragraph(`Genre: ${novel.genre}`));
  }
  if (novel.storySummary) {
    paragraphs.push(new Paragraph('Story Summary'));
    paragraphs.push(new Paragraph(novel.storySummary));
  }
  if (novel.characterSummary) {
    paragraphs.push(new Paragraph('Character Summary'));
    paragraphs.push(new Paragraph(novel.characterSummary));
  }
  if (novel.arcSummary) {
    paragraphs.push(new Paragraph('Plot Arc'));
    paragraphs.push(new Paragraph(novel.arcSummary));
  }

  return paragraphs;
}

function buildChapterParagraphs(chapter: ExportChapterLike): Paragraph[] {
  return [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: `Chapter ${chapter.chapterNumber}: ${chapter.title}`,
          bold: true,
        }),
      ],
    }),
    ...normalizeLineEndings(chapter.content)
      .split('\n')
      .map((line) => new Paragraph(line)),
  ];
}
