import {
  MAX_IMPORT_CHAPTERS,
  MAX_IMPORT_PARTS,
  MAX_IMPORT_TITLE_CHARS,
} from '@/lib/import/limits';
import type { StoredImportSegment } from '@/lib/import/session-store';
import type { ImportChapterRef, ImportPlanChapter } from '@/lib/import/types';

function joinParagraphs(paragraphs: string[]): string {
  return paragraphs.filter(p => p.trim().length > 0).join('\n\n');
}

/**
 * Reconstruct exact chapter prose from compact parts against the session's
 * stored segments. Enforces full coverage: every paragraph of every segment
 * appears in exactly one chapter, with no gaps or overlaps.
 */
export function reconstructChaptersFromParts(
  segments: StoredImportSegment[],
  chapters: ImportChapterRef[],
): ImportPlanChapter[] {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new Error('Nothing to import.');
  }
  if (chapters.length > MAX_IMPORT_CHAPTERS) {
    throw new Error('Too many chapters to import.');
  }

  const byId = new Map(segments.map(s => [s.id, s]));
  if (byId.size !== segments.length) {
    throw new Error('Import session segments are corrupt.');
  }

  let nextSegmentIndex = 0;
  let nextParagraphIndex = 0;
  let partCount = 0;

  const out: ImportPlanChapter[] = [];
  for (const [index, chapter] of chapters.entries()) {
    if (!chapter || typeof chapter !== 'object') {
      throw new Error('Import chapter descriptor is invalid.');
    }
    const title = typeof chapter.title === 'string' ? chapter.title.trim() : '';
    if (title.length > MAX_IMPORT_TITLE_CHARS) {
      throw new Error('A chapter title is too long.');
    }
    if (!Array.isArray(chapter.parts) || chapter.parts.length === 0) {
      throw new Error('Each imported chapter must reference at least one segment part.');
    }

    const bodyParts: string[] = [];
    for (const part of chapter.parts) {
      partCount += 1;
      if (partCount > MAX_IMPORT_PARTS) {
        throw new Error('Import plan contains too many segment parts.');
      }
      if (!part || typeof part !== 'object') {
        throw new Error('Import chapter part is invalid.');
      }
      const segmentId = typeof part.segmentId === 'string' ? part.segmentId : '';
      const seg = byId.get(segmentId);
      if (!seg) {
        throw new Error('Import references an unknown segment.');
      }
      const from = part.fromParagraph;
      const to = part.toParagraph;
      if (
        !Number.isInteger(from)
        || !Number.isInteger(to)
        || from < 0
        || to < from
        || to > seg.paragraphs.length
      ) {
        throw new Error('Import segment paragraph range is invalid.');
      }

      const expected = segments[nextSegmentIndex];
      if (
        !expected
        || expected.id !== segmentId
        || from !== nextParagraphIndex
        || (to === from && seg.paragraphs.length > 0)
      ) {
        throw new Error(
          'Import plan must cover the full manuscript exactly once in original order.',
        );
      }
      nextParagraphIndex = to;
      if (nextParagraphIndex === expected.paragraphs.length) {
        nextSegmentIndex += 1;
        nextParagraphIndex = 0;
      }
      bodyParts.push(...seg.paragraphs.slice(from, to));
    }

    const content = joinParagraphs(bodyParts);
    const chapterNumber = index + 1;
    out.push({
      chapterNumber,
      title: title || `Chapter ${chapterNumber}`,
      content,
    });
  }

  if (nextSegmentIndex !== segments.length || nextParagraphIndex !== 0) {
    throw new Error(
      'Import plan must cover the full manuscript exactly once in original order.',
    );
  }

  // Reject empty total prose.
  if (out.every(c => c.content.trim() === '')) {
    throw new Error('No readable text was found in the file.');
  }

  return out;
}
