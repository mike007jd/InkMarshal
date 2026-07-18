export interface ExportNovelLike {
  title: string;
  genre: string;
  storySummary: string;
  characterSummary: string;
  arcSummary: string;
}

export interface ExportChapterLike {
  chapterNumber: number;
  title: string;
  content: string;
}

/** Collapse CRLF/CR to LF so CRLF input never leaves stray `\r` in exported lines. */
export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

export function buildNovelTxt(
  novel: ExportNovelLike,
  chapters: ExportChapterLike[]
): string {
  const parts = [
    novel.title,
    novel.genre ? `Genre: ${novel.genre}` : '',
    novel.storySummary ? `Story Summary\n${normalizeLineEndings(novel.storySummary)}` : '',
    novel.characterSummary
      ? `Character Summary\n${normalizeLineEndings(novel.characterSummary)}`
      : '',
    novel.arcSummary ? `Plot Arc\n${normalizeLineEndings(novel.arcSummary)}` : '',
  ].filter(Boolean);

  for (const chapter of chapters) {
    parts.push(
      `Chapter ${chapter.chapterNumber}: ${chapter.title}`,
      '',
      normalizeLineEndings(chapter.content),
      '',
    );
  }

  return `${parts.join('\n')}\n`;
}

export function buildChapterTxt(chapter: ExportChapterLike): string {
  return `Chapter ${chapter.chapterNumber}: ${chapter.title}\n\n${normalizeLineEndings(chapter.content)}\n`;
}
