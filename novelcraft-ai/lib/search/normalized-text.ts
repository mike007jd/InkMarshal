export interface NormalizedTextIndex {
  normalized: string;
  originalStartByNormalizedOffset: number[];
  originalEndByNormalizedOffset: number[];
}

export interface OriginalTextRange {
  offset: number;
  length: number;
}

export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export function buildNormalizedTextIndex(source: string): NormalizedTextIndex {
  let normalized = '';
  const originalStartByNormalizedOffset: number[] = [];
  const originalEndByNormalizedOffset: number[] = [];
  let originalOffset = 0;

  for (const char of source) {
    const normalizedChar = normalizeSearchText(char);
    const originalStart = originalOffset;
    const originalEnd = originalOffset + char.length;
    for (let i = 0; i < normalizedChar.length; i += 1) {
      originalStartByNormalizedOffset.push(originalStart);
      originalEndByNormalizedOffset.push(originalEnd);
    }
    normalized += normalizedChar;
    originalOffset = originalEnd;
  }

  return { normalized, originalStartByNormalizedOffset, originalEndByNormalizedOffset };
}

export function originalRangeForNormalizedMatch(
  index: NormalizedTextIndex,
  normalizedOffset: number,
  normalizedLength: number,
  sourceLength: number,
): OriginalTextRange {
  const start = index.originalStartByNormalizedOffset[normalizedOffset] ?? sourceLength;
  const lastNormalizedOffset = normalizedOffset + normalizedLength - 1;
  const end = index.originalEndByNormalizedOffset[lastNormalizedOffset] ?? start;
  return { offset: start, length: Math.max(0, end - start) };
}

export function findNormalizedSearchMatch(
  source: string,
  rawQuery: string,
): { normalizedOffset: number; range: OriginalTextRange } | null {
  const normalizedQuery = normalizeSearchText(rawQuery);
  if (!normalizedQuery) return null;

  const index = buildNormalizedTextIndex(source);
  const normalizedOffset = index.normalized.indexOf(normalizedQuery);
  if (normalizedOffset < 0) return null;

  return {
    normalizedOffset,
    range: originalRangeForNormalizedMatch(
      index,
      normalizedOffset,
      normalizedQuery.length,
      source.length,
    ),
  };
}
