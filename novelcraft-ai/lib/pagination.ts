interface ManuscriptSourceChapter {
  id: string;
  chapterNumber: number;
  title: string;
  content: string;
}

export interface ManuscriptPage {
  id: string;
  pageNumber: number;
  chapterNumber: number;
  /** Set on the page that owns the chapter heading. Used by the renderer. */
  title: string | null;
  content: string;
  /** Character range in the chapter's trimmed source. Used to preserve the
   *  visible passage when responsive geometry re-paginates the manuscript. */
  sourceStart: number;
  sourceEnd: number;
  /** True when this page is the chapter's first content page (carries the title). */
  isFirstOfChapter: boolean;
  /** True when no further pages from the same chapter follow. */
  isLastOfChapter: boolean;
  /**
   * Roughly how full the page is — `actualChars / availableChars`. The reader
   * uses this to pad short tail pages with a "fin" ornament instead of leaving
   * obvious whitespace.
   */
  fillRatio: number;
}

interface PaginationOptions {
  charsPerPage: number;
  chapterTitleReserve?: number;
}

function takePageSlice(content: string, limit: number) {
  if (content.length <= limit) {
    return { page: content.trim(), rest: '', consumed: content.length };
  }

  const safeLimit = limit > 0 && /[\uD800-\uDBFF]/.test(content.charAt(limit - 1)) && /[\uDC00-\uDFFF]/.test(content.charAt(limit))
    ? limit - 1
    : limit;
  const candidate = content.slice(0, safeLimit);
  const breakAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));

  if (breakAt <= Math.floor(limit * 0.45)) {
    const rawRest = content.slice(safeLimit);
    const rest = rawRest.trimStart();
    return {
      page: candidate.trim(),
      rest,
      consumed: safeLimit + rawRest.length - rest.length,
    };
  }

  const rawRest = content.slice(breakAt);
  const rest = rawRest.trimStart();
  return {
    page: candidate.slice(0, breakAt).trim(),
    rest,
    consumed: breakAt + rawRest.length - rest.length,
  };
}

export function paginateManuscript(
  chapters: ManuscriptSourceChapter[],
  options: PaginationOptions
): ManuscriptPage[] {
  const pages: ManuscriptPage[] = [];
  const titleReserve = options.chapterTitleReserve ?? 120;

  for (const chapter of chapters) {
    let rest = chapter.content.trim();
    let isFirstPage = true;
    let sourceOffset = 0;

    if (!rest) {
      pages.push({
        id: `${chapter.id}-page-1`,
        pageNumber: pages.length + 1,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title,
        content: '',
        sourceStart: 0,
        sourceEnd: 0,
        isFirstOfChapter: true,
        isLastOfChapter: true,
        fillRatio: 0,
      });
      continue;
    }

    while (rest.length > 0) {
      const available = Math.max(
        120,
        options.charsPerPage - (isFirstPage ? titleReserve : 0)
      );
      const { page, rest: nextRest, consumed } = takePageSlice(rest, available);

      pages.push({
        id: `${chapter.id}-page-${isFirstPage ? 1 : pages.length + 1}`,
        pageNumber: pages.length + 1,
        chapterNumber: chapter.chapterNumber,
        title: isFirstPage ? chapter.title : null,
        content: page,
        sourceStart: sourceOffset,
        sourceEnd: sourceOffset + consumed,
        isFirstOfChapter: isFirstPage,
        isLastOfChapter: false,
        fillRatio: Math.min(1, page.length / available),
      });

      rest = nextRest;
      sourceOffset += consumed;
      isFirstPage = false;
    }

    // Mark the chapter's final page. The early `continue` above guarantees the
    // while loop ran at least once, so the chapter always has a trailing page.
    pages[pages.length - 1].isLastOfChapter = true;
  }

  return pages;
}

/**
 * Character-width budget used to estimate how many characters fit on one
 * rendered line. Latin averages about half an em; CJK and full-width
 * punctuation take a full em. Metrics scale with the live manuscript font
 * size (15 / 17 / 19px).
 *
 * The whole manuscript is scanned. Any full-width glyph forces the full-em
 * budget so Latin-leading / CJK-trailing novels cannot over-paginate early
 * pages and clip later CJK. Pure Latin keeps the half-em budget.
 */
const LATIN_EM_FRACTION = 9 / 17;
const DEFAULT_FONT_SIZE_PX = 17;
const FULLWIDTH_CHAR_PATTERN = /[\u2014\u2026\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\u3000-\u303F]/;

export function estimateManuscriptCharWidth(
  text: string,
  fontSizePx: number = DEFAULT_FONT_SIZE_PX,
): number {
  const size = Number.isFinite(fontSizePx) && fontSizePx > 0
    ? fontSizePx
    : DEFAULT_FONT_SIZE_PX;
  const latinWidth = size * LATIN_EM_FRACTION;
  const fullWidthBudget = size;

  let measured = 0;
  let hasFullWidth = false;
  for (const char of text) {
    if (/\s/.test(char)) continue;
    measured += 1;
    if (FULLWIDTH_CHAR_PATTERN.test(char)) {
      hasFullWidth = true;
      break;
    }
  }
  if (measured === 0) return latinWidth;
  return hasFullWidth ? fullWidthBudget : latinWidth;
}

export function findPageIndexForSourceOffset(
  pages: ManuscriptPage[],
  chapterNumber: number,
  sourceOffset: number,
): number {
  const exact = pages.findIndex(page => (
    page.chapterNumber === chapterNumber
    && sourceOffset >= page.sourceStart
    && (sourceOffset < page.sourceEnd || (page.isLastOfChapter && sourceOffset <= page.sourceEnd))
  ));
  if (exact >= 0) return exact;

  const chapterPages = pages
    .map((page, index) => ({ page, index }))
    .filter(entry => entry.page.chapterNumber === chapterNumber);
  if (chapterPages.length === 0) return -1;
  return sourceOffset < chapterPages[0].page.sourceStart
    ? chapterPages[0].index
    : chapterPages[chapterPages.length - 1].index;
}
