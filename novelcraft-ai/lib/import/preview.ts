import {
  MAX_IMPORT_PREVIEW_CHARS,
  PREVIEW_PARAGRAPH_CHARS,
  PREVIEW_SNIPPET_CHARS,
} from '@/lib/import/limits';
import type { StoredImportSegment } from '@/lib/import/session-store';
import type { ImportPreviewChapter } from '@/lib/import/types';
import { countWords } from '@/lib/utils';

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function splitContentParagraphs(content: string): string[] {
  return content.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
}

export function segmentFromCandidate(candidate: {
  id: string;
  title: string;
  volumeTitle: string | null;
  content: string;
  wordCount: number;
  inferred: boolean;
}): StoredImportSegment {
  const paragraphs = splitContentParagraphs(candidate.content);
  return {
    id: candidate.id,
    title: candidate.title,
    volumeTitle: candidate.volumeTitle,
    paragraphs,
    wordCount: candidate.wordCount || countWords(candidate.content),
    inferred: candidate.inferred,
  };
}

export function buildPreviewChapters(segments: StoredImportSegment[]): ImportPreviewChapter[] {
  const budget = { remaining: MAX_IMPORT_PREVIEW_CHARS };
  return segments.map((seg, index) => {
    const chapterNumber = index + 1;
    const content = seg.paragraphs.join('\n\n');
    return {
      id: seg.id,
      chapterNumber,
      title: seg.title,
      volumeTitle: seg.volumeTitle,
      wordCount: seg.wordCount || countWords(content),
      inferred: seg.inferred,
      snippet: takePreview(content, PREVIEW_SNIPPET_CHARS, budget),
      paragraphs: seg.paragraphs.map(p =>
        takePreview(p, PREVIEW_PARAGRAPH_CHARS, budget)),
      parts: [{
        segmentId: seg.id,
        fromParagraph: 0,
        toParagraph: seg.paragraphs.length,
      }],
    };
  });
}

function takePreview(
  text: string,
  max: number,
  budget: { remaining: number },
): string {
  if (!text) return '';
  if (budget.remaining <= 1) return '…';
  const allowance = Math.min(max, budget.remaining);
  const value = clip(text, allowance);
  budget.remaining -= value.length;
  return value;
}

/**
 * Re-number preview rows after a local merge/split. Preserves `parts` (the
 * reconstruction authority) and only refreshes chapterNumber / display id.
 */
export function renumberPreviewChapters(
  chapters: ImportPreviewChapter[],
): ImportPreviewChapter[] {
  return chapters.map((c, index) => {
    const chapterNumber = index + 1;
    return {
      ...c,
      chapterNumber,
      id: `preview-${chapterNumber}`,
      title: c.title.trim() || `Chapter ${chapterNumber}`,
    };
  });
}

/** Merge chapter at `index` up into the previous chapter (local preview only). */
export function mergePreviewUp(
  chapters: ImportPreviewChapter[],
  index: number,
): ImportPreviewChapter[] {
  if (index <= 0 || index >= chapters.length) return chapters;
  const next = [...chapters];
  const prev = next[index - 1]!;
  const cur = next[index]!;
  next[index - 1] = {
    ...prev,
    wordCount: prev.wordCount + cur.wordCount,
    snippet: clip(
      [prev.snippet.replace(/…$/, ''), cur.snippet.replace(/…$/, '')]
        .filter(Boolean)
        .join('\n\n'),
      PREVIEW_SNIPPET_CHARS,
    ),
    paragraphs: [...prev.paragraphs, ...cur.paragraphs],
    parts: [...prev.parts, ...cur.parts],
  };
  next.splice(index, 1);
  return renumberPreviewChapters(next);
}

/** Split chapter at paragraph index (local preview only). */
export function splitPreviewAt(
  chapters: ImportPreviewChapter[],
  index: number,
  paragraphIndex: number,
): ImportPreviewChapter[] {
  const cur = chapters[index];
  if (!cur) return chapters;
  if (paragraphIndex <= 0 || paragraphIndex >= cur.paragraphs.length) return chapters;

  // Map the display paragraph index onto the underlying parts coverage.
  const leftParts = sliceParts(cur.parts, 0, paragraphIndex);
  const rightParts = sliceParts(cur.parts, paragraphIndex, totalParagraphs(cur.parts));
  if (leftParts.length === 0 || rightParts.length === 0) return chapters;

  const next = [...chapters];
  const leftParas = cur.paragraphs.slice(0, paragraphIndex);
  const rightParas = cur.paragraphs.slice(paragraphIndex);
  next[index] = {
    ...cur,
    wordCount: estimateWords(leftParas),
    snippet: clip(leftParas.join('\n\n'), PREVIEW_SNIPPET_CHARS),
    paragraphs: leftParas,
    parts: leftParts,
  };
  next.splice(index + 1, 0, {
    ...cur,
    id: `${cur.id}-split`,
    title: '',
    inferred: false,
    wordCount: estimateWords(rightParas),
    snippet: clip(rightParas.join('\n\n'), PREVIEW_SNIPPET_CHARS),
    paragraphs: rightParas,
    parts: rightParts,
  });
  return renumberPreviewChapters(next);
}

function totalParagraphs(parts: ImportPreviewChapter['parts']): number {
  return parts.reduce((sum, p) => sum + (p.toParagraph - p.fromParagraph), 0);
}

function sliceParts(
  parts: ImportPreviewChapter['parts'],
  from: number,
  to: number,
): ImportPreviewChapter['parts'] {
  const out: ImportPreviewChapter['parts'] = [];
  let cursor = 0;
  for (const part of parts) {
    const len = part.toParagraph - part.fromParagraph;
    const partStart = cursor;
    const partEnd = cursor + len;
    cursor = partEnd;
    const sliceFrom = Math.max(from, partStart);
    const sliceTo = Math.min(to, partEnd);
    if (sliceFrom >= sliceTo) continue;
    out.push({
      segmentId: part.segmentId,
      fromParagraph: part.fromParagraph + (sliceFrom - partStart),
      toParagraph: part.fromParagraph + (sliceTo - partStart),
    });
  }
  return out;
}

function estimateWords(paragraphs: string[]): number {
  return countWords(paragraphs.join('\n\n'));
}
