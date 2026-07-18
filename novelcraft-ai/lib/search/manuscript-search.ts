/**
 * Pure manuscript-search core. Lives outside the Worker file so it can be
 * imported synchronously when the Worker is unavailable (SSR, jsdom, very old
 * environments) and unit-tested in plain Node.
 *
 * The matcher is intentionally simple: NFKC + lowercase normalize, then a
 * sliding `indexOf` against the normalized chapter title and body. Chinese
 * doesn't tokenise cleanly, so we keep substring semantics; for ASCII queries
 * we don't enforce word boundaries (a tradeoff — closer to Cmd+F muscle memory
 * than to a proper full-text engine).
 *
 * One floor we do enforce: a single-character CJK query matches inside far too
 * many unrelated compounds to be useful, so CJK queries require ≥2 characters.
 * This mirrors the recall-side `containsName` heuristic (recall.ts) which also
 * skips 1-char CJK names. Latin queries keep their 1-char floor (Cmd+F parity).
 */

import {
  buildNormalizedTextIndex,
  normalizeSearchText,
  originalRangeForNormalizedMatch,
} from './normalized-text';

export interface SearchInputChapter {
  chapterNumber: number;
  title: string;
  content: string;
}

export interface SearchResult {
  chapterNumber: number;
  /** "title" when the match lives in the chapter title; "body" otherwise. */
  field: 'title' | 'body';
  /** Character offset of the match into the ORIGINAL (un-normalized) text. */
  offset: number;
  /** ±30 chars around the match; includes the match itself. */
  snippet: string;
  /** Range of the match inside `snippet`, suitable for <mark> wrapping. */
  highlight: { start: number; end: number };
  /** Weighted score — title hits outrank body hits, earlier hits outrank later. */
  score: number;
  /** Title of the chapter (for the result row header). */
  chapterTitle: string;
}

const SNIPPET_RADIUS = 30;
const MAX_RESULTS = 50;
/** Max accepted query length — shared with the search dialog's input cap. */
export const MAX_QUERY_LENGTH = 100;

// Minimum query length for CJK queries — a lone ideograph matches inside too
// many unrelated compounds. Latin queries keep their effective 1-char floor.
const MIN_CJK_QUERY_CHARS = 2;

/** True when `value` contains at least one CJK ideograph (mirrors recall.ts). */
function containsCjk(value: string): boolean {
  return /[㐀-鿿豈-﫿]/u.test(value);
}
// Cap matches per chapter so a query like "the" against a 100-chapter book
// doesn't dump 10k results before the slice. Title matches still go through.
const MAX_BODY_MATCHES_PER_CHAPTER = 10;

/** Build a snippet around `offset` with the matched range inside it. */
function buildSnippet(source: string, offset: number, matchLength: number): {
  snippet: string;
  highlight: { start: number; end: number };
} {
  const start = Math.max(0, offset - SNIPPET_RADIUS);
  const end = Math.min(source.length, offset + matchLength + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  const snippet = prefix + source.slice(start, end) + suffix;
  // highlight offset inside the snippet
  const highlightStart = prefix.length + (offset - start);
  return {
    snippet,
    highlight: { start: highlightStart, end: highlightStart + matchLength },
  };
}

export function searchManuscriptSync(
  chapters: SearchInputChapter[],
  rawQuery: string,
): SearchResult[] {
  const query = (rawQuery ?? '').trim();
  if (!query) return [];
  if (query.length > MAX_QUERY_LENGTH) return [];

  const normalizedQuery = normalizeSearchText(query);
  const matchLength = normalizedQuery.length;
  if (matchLength === 0) return [];
  // A single CJK ideograph is too noisy (no word boundaries), so require ≥2
  // characters for CJK queries — matching recall's `containsName` heuristic.
  if (containsCjk(normalizedQuery) && Array.from(normalizedQuery).length < MIN_CJK_QUERY_CHARS) {
    return [];
  }

  const out: SearchResult[] = [];

  for (const chapter of chapters) {
    const title = chapter.title ?? '';
    const body = chapter.content ?? '';
    const titleIndex = buildNormalizedTextIndex(title);
    const bodyIndex = buildNormalizedTextIndex(body);

    // Title — single best hit (first occurrence) with a 1.5x weight
    const titleHit = titleIndex.normalized.indexOf(normalizedQuery);
    if (titleHit >= 0) {
      const range = originalRangeForNormalizedMatch(titleIndex, titleHit, matchLength, title.length);
      const { snippet, highlight } = buildSnippet(title, range.offset, range.length);
      out.push({
        chapterNumber: chapter.chapterNumber,
        field: 'title',
        offset: range.offset,
        snippet,
        highlight,
        score: 1.5,
        chapterTitle: title,
      });
    }

    // Body — collect all matches up to per-chapter cap
    let cursor = 0;
    let count = 0;
    while (count < MAX_BODY_MATCHES_PER_CHAPTER) {
      const hit = bodyIndex.normalized.indexOf(normalizedQuery, cursor);
      if (hit < 0) break;
      const range = originalRangeForNormalizedMatch(bodyIndex, hit, matchLength, body.length);
      const { snippet, highlight } = buildSnippet(body, range.offset, range.length);
      // Decay score by position so early matches sort first.
      const positionDecay = 1 / (1 + hit / Math.max(body.length, 1));
      out.push({
        chapterNumber: chapter.chapterNumber,
        field: 'body',
        offset: range.offset,
        snippet,
        highlight,
        score: positionDecay,
        chapterTitle: title,
      });
      cursor = hit + matchLength;
      count++;
    }
  }

  // Sort: higher score first; ties broken by lower chapterNumber, then offset.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.chapterNumber !== b.chapterNumber) return a.chapterNumber - b.chapterNumber;
    return a.offset - b.offset;
  });

  return out.slice(0, MAX_RESULTS);
}

// ---- Worker request/response wire types ----

export interface SearchRequest {
  id: number;
  chapters: SearchInputChapter[];
  query: string;
}

export interface SearchResponse {
  id: number;
  results: SearchResult[];
}
