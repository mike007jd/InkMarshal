import { MAX_CHAPTER_COUNT } from '@/lib/ai/types';
import { parsePositiveIntegerParam } from '@/lib/route-params';

export const MAX_START_WRITING_CHAPTERS_PER_REQUEST = 10;

export interface StartWritingBatchParams {
  chaptersLimit: number;
  untilChapter: number | null;
}

export interface StartWritingBatchStopInput extends StartWritingBatchParams {
  writtenThisBatch: number;
  chapterNumber: number;
}

export function missingChapterNumbers(
  blueprint: Array<{ chapterNumber: number }>,
  existingByNumber: ReadonlyMap<number, unknown>,
): number[] {
  return blueprint
    .map(chapter => chapter.chapterNumber)
    .filter(chapterNumber => !existingByNumber.has(chapterNumber));
}

export function parseStartWritingBatchParams(searchParams: URLSearchParams): StartWritingBatchParams | { error: string } {
  const chaptersRaw = searchParams.get('chapters');
  const untilChapterRaw = searchParams.get('untilChapter');
  const chaptersLimit = chaptersRaw === null ? 1 : parsePositiveIntegerParam(chaptersRaw);
  const untilChapter = untilChapterRaw === null ? null : parsePositiveIntegerParam(untilChapterRaw);

  if (chaptersLimit === null) {
    return { error: 'chapters must be a positive integer' };
  }
  if (chaptersLimit > MAX_START_WRITING_CHAPTERS_PER_REQUEST) {
    return { error: `chapters must be <= ${MAX_START_WRITING_CHAPTERS_PER_REQUEST}` };
  }
  if (untilChapterRaw !== null && untilChapter === null) {
    return { error: 'untilChapter must be a positive integer' };
  }
  if (untilChapter !== null && untilChapter > MAX_CHAPTER_COUNT) {
    return { error: `untilChapter must be <= ${MAX_CHAPTER_COUNT}` };
  }
  return { chaptersLimit, untilChapter };
}

export function shouldStopStartWritingBatch({
  writtenThisBatch,
  chapterNumber,
  chaptersLimit,
  untilChapter,
}: StartWritingBatchStopInput): boolean {
  if (writtenThisBatch >= MAX_START_WRITING_CHAPTERS_PER_REQUEST) return true;
  if (untilChapter !== null && chapterNumber > untilChapter) return true;
  if (untilChapter === null && writtenThisBatch >= chaptersLimit) return true;
  return false;
}
