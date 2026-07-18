// Deterministic chapter detection (W2-1) — PURE, NO AI.
//
// Turns a flat `RawDocument` (heading-level + paragraph blocks) into an ordered
// `ChapterCandidate[]` (volume → chapter tree). Every boundary decision is a
// pure function of the blocks, so the same document always yields the same
// split — the preview can then be hand-corrected and nothing is ever inferred
// by a non-deterministic model.
//
// Two boundary sources, in priority order:
//   1. Structural headings the parser already classified (Markdown #/##, DOCX
//      Heading1/2, or an inferred bold-line). `level <= 2` opens a section.
//   2. A TXT/heuristic regex fallback: a paragraph whose ENTIRE text matches a
//      volume / chapter pattern (第X卷 / 卷X / 第X章 / Chapter N / 序章 / 楔子 …)
//      is promoted to a heading. This catches manuscripts with no real heading
//      styles — the common Chinese case of "centered bold line as a title".
//
// A volume heading (level 1, or a 卷-class regex hit) sets the running
// `volumeTitle`; a chapter heading (level 2, or a 章-class hit) opens a new
// chapter. Body paragraphs accumulate into the current chapter. Prose that
// appears before the first detected chapter is kept as an implicit opening
// chapter so nothing is dropped.

import { countWords } from '@/lib/utils';
import type {
  ChapterCandidate,
  DocBlock,
  RawDocument,
} from '@/lib/import/types';

// ── Heuristic regexes (exported for the unit tests) ──────────────────────────

/**
 * Volume markers. Matches "第一卷", "第1卷", "卷一", "卷 1", "Volume 3",
 * "Book Two", optionally followed by a title ("第一卷 风起"). Anchored so a
 * paragraph only qualifies when the WHOLE line is a volume header (a sentence
 * that merely mentions 卷 must not split the manuscript).
 */
// NOTE on `\b`: a CJK ideograph (章/卷) is NOT a `\w` char in JS regex, so a
// `\b` placed after it never matches (there's no word↔non-word transition).
// Both patterns therefore avoid a trailing `\b` after the CJK alternatives and
// instead require either end-of-line or a separator/title via `(?:[…]\s*.{0,N})?$`.
export const VOLUME_REGEX =
  /^\s*(?:第\s*[0-9零一二三四五六七八九十百千两]+\s*卷|卷\s*[0-9零一二三四五六七八九十百千两]+|(?:volume|book|part)\s+(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten))(?:[\s:：、.\-—]+.{0,40})?\s*$/i;

/**
 * Chapter markers. Matches "第一章", "第 12 章", "Chapter 7", "Chapter VII",
 * and the standalone prologue/preface markers "序章" / "楔子" / "Prologue" /
 * "前言". Optional trailing title is captured loosely. Anchored to the whole
 * line for the same reason as VOLUME_REGEX.
 */
export const CHAPTER_REGEX =
  /^\s*(?:第\s*[0-9零一二三四五六七八九十百千两]+\s*[章节回折]|chapter\s+(?:[0-9]+|[ivxlcdm]+)|序章|序言|楔子|引子|前言|后记|尾声|番外|prologue|epilogue|preface|foreword|afterword)(?:[\s:：、.\-—]+.{0,60})?\s*$/i;

/** A line short enough + heading-shaped enough to be a hand-bolded title even
 *  when it doesn't match the volume/chapter wording. Used only as the very last
 *  fallback for `inferred` heading blocks the parser flagged. */
const MAX_INFERRED_TITLE_LEN = 40;

interface Section {
  level: 1 | 2;
  title: string;
  inferred: boolean;
}

/**
 * Classify a block into a section opener (volume/chapter) or `null` (body).
 * Structural headings win; otherwise the regex heuristic promotes a whole-line
 * paragraph. `inferred` blocks the parser already flagged (bold standalone
 * lines) are treated as chapter openers when they look title-like.
 */
function classifyBlock(block: DocBlock): Section | null {
  const text = block.text.trim();
  if (!text) return null;

  // 1. Real structural heading from the parser.
  if (block.kind === 'heading' && typeof block.level === 'number') {
    if (block.level <= 1) {
      // A level-1 heading that *reads* like a chapter (some DOCX templates make
      // every chapter a Heading1) is treated as a chapter, not a volume — the
      // regex disambiguates.
      if (CHAPTER_REGEX.test(text) && !VOLUME_REGEX.test(text)) {
        return { level: 2, title: text, inferred: Boolean(block.inferred) };
      }
      return { level: 1, title: text, inferred: Boolean(block.inferred) };
    }
    // level >= 2 → chapter-class opener.
    return { level: 2, title: text, inferred: Boolean(block.inferred) };
  }

  // 2. Regex heuristic over a plain paragraph (TXT path, or a heading-less docx).
  if (VOLUME_REGEX.test(text)) {
    return { level: 1, title: text, inferred: true };
  }
  if (CHAPTER_REGEX.test(text)) {
    return { level: 2, title: text, inferred: true };
  }

  // 3. Parser-flagged inferred heading (bold standalone line) that is short
  //    enough to be a title — last-resort chapter opener.
  if (
    block.kind === 'heading' &&
    block.inferred &&
    text.length <= MAX_INFERRED_TITLE_LEN &&
    !/[。.!?！？]$/.test(text)
  ) {
    return { level: 2, title: text, inferred: true };
  }

  return null;
}

interface MutableChapter {
  title: string;
  volumeTitle: string | null;
  paragraphs: string[];
  inferred: boolean;
}

function joinParagraphs(paragraphs: string[]): string {
  return paragraphs
    .map(p => p.trim())
    .filter(Boolean)
    .join('\n\n');
}

function isInkMarshalExportFrontMatter(
  chapter: MutableChapter,
  next: MutableChapter | undefined,
): boolean {
  if (chapter.title.trim() || !next || !CHAPTER_REGEX.test(next.title)) return false;

  const lines = joinParagraphs(chapter.paragraphs)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const storyIndex = lines.indexOf('Story Summary');
  const characterIndex = lines.indexOf('Character Summary');
  const arcIndex = lines.indexOf('Plot Arc');

  return (
    lines.length >= 7 &&
    lines.some(line => /^Genre:\s+\S/.test(line)) &&
    storyIndex > 0 &&
    characterIndex > storyIndex &&
    arcIndex > characterIndex
  );
}

function dropExportFrontMatter(chapters: MutableChapter[]): MutableChapter[] {
  if (chapters.length > 1 && isInkMarshalExportFrontMatter(chapters[0], chapters[1])) {
    return chapters.slice(1);
  }
  return chapters;
}

/**
 * Run detection. Always returns at least one candidate when the document has any
 * body text — a manuscript with no recognizable headings collapses to a single
 * "whole document" chapter the user can then split manually.
 */
export function detectChapters(doc: RawDocument): ChapterCandidate[] {
  let currentVolume: string | null = null;
  let current: MutableChapter | null = null;
  const chapters: MutableChapter[] = [];

  const openChapter = (title: string, inferred: boolean) => {
    current = {
      title,
      volumeTitle: currentVolume,
      paragraphs: [],
      inferred,
    };
    chapters.push(current);
  };

  for (const block of doc.blocks) {
    const section = classifyBlock(block);

    if (section?.level === 1) {
      currentVolume = section.title;
      // A volume heading does not itself open a chapter; the next chapter
      // heading (or body text) does. But if body text immediately follows a
      // volume with no chapter heading, it lands in an implicit chapter below.
      continue;
    }

    if (section?.level === 2) {
      openChapter(section.title, section.inferred);
      continue;
    }

    // Body paragraph. If no chapter is open yet, open an implicit one so the
    // opening prose (front matter, a titleless first scene) is never dropped.
    const text = block.text.trim();
    if (!text) continue;
    if (!current) {
      openChapter('', false);
    }
    current!.paragraphs.push(text);
  }

  // Drop trailing chapters that ended up empty (a volume heading with no body,
  // or a heading immediately followed by another heading is still kept — an
  // empty chapter is meaningful as a boundary the user can fill).
  const nonEmpty = chapters.filter(
    (c, i) => c.paragraphs.length > 0 || c.title.trim().length > 0 || i === 0,
  );

  return dropExportFrontMatter(nonEmpty).map((c, index) => {
    const content = joinParagraphs(c.paragraphs);
    const chapterNumber = index + 1;
    const title = c.title.trim() || defaultChapterTitle(chapterNumber);
    return {
      id: `cand-${chapterNumber}`,
      chapterNumber,
      title,
      volumeTitle: c.volumeTitle,
      content,
      wordCount: countWords(content),
      inferred: c.inferred,
    } satisfies ChapterCandidate;
  });
}

/** Stable default title for an untitled (implicit) chapter. The UI can localize
 *  the display; this keeps the stored title non-empty and deterministic. */
export function defaultChapterTitle(chapterNumber: number): string {
  return `Chapter ${chapterNumber}`;
}

/**
 * Re-number a candidate list after a merge/split edit in the preview so the
 * running chapter numbers + ids stay 1..N contiguous. Pure helper shared by the
 * editor's merge/split actions.
 */
export function renumberCandidates(candidates: ChapterCandidate[]): ChapterCandidate[] {
  return candidates.map((c, index) => {
    const chapterNumber = index + 1;
    return {
      ...c,
      chapterNumber,
      id: `cand-${chapterNumber}`,
      wordCount: countWords(c.content),
      title: c.title.trim() || defaultChapterTitle(chapterNumber),
    };
  });
}
