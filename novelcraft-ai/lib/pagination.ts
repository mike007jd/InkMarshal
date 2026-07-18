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
    return { page: content.trim(), rest: '' };
  }

  const safeLimit = limit > 0 && /[\uD800-\uDBFF]/.test(content.charAt(limit - 1)) && /[\uDC00-\uDFFF]/.test(content.charAt(limit))
    ? limit - 1
    : limit;
  const candidate = content.slice(0, safeLimit);
  const breakAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));

  if (breakAt <= Math.floor(limit * 0.45)) {
    return {
      page: candidate.trim(),
      rest: content.slice(safeLimit).trimStart(),
    };
  }

  return {
    page: candidate.slice(0, breakAt).trim(),
    rest: content.slice(breakAt).trimStart(),
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

    if (!rest) {
      pages.push({
        id: `${chapter.id}-page-1`,
        pageNumber: pages.length + 1,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title,
        content: '',
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
      const { page, rest: nextRest } = takePageSlice(rest, available);

      pages.push({
        id: `${chapter.id}-page-${isFirstPage ? 1 : pages.length + 1}`,
        pageNumber: pages.length + 1,
        chapterNumber: chapter.chapterNumber,
        title: isFirstPage ? chapter.title : null,
        content: page,
        isFirstOfChapter: isFirstPage,
        isLastOfChapter: false,
        fillRatio: Math.min(1, page.length / available),
      });

      rest = nextRest;
      isFirstPage = false;
    }

    // Mark the chapter's final page. The early `continue` above guarantees the
    // while loop ran at least once, so the chapter always has a trailing page.
    pages[pages.length - 1].isLastOfChapter = true;
  }

  return pages;
}
