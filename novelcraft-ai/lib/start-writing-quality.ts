import type { ChapterQualityIssue } from '@/lib/db-types';

const LENGTH_RETRY_RATIO = 0.7;

export function minimumRetryWords(targetWords: number): number {
  return Math.floor(targetWords * LENGTH_RETRY_RATIO);
}

// Append a synthetic "length" quality issue when the final chapter is under
// target, unless one is already present. The dedup-by-type lives here so both
// the pre-Ralph and post-Ralph validation branches share the same rule.
export function ensureLengthIssue(
  issues: ChapterQualityIssue[] | null,
  actualWords: number,
  targetWords: number,
): ChapterQualityIssue[] | null {
  if (actualWords >= minimumRetryWords(targetWords)) return issues;
  if (issues?.some(issue => issue.type === 'length')) return issues;
  return [
    ...(issues ?? []),
    {
      type: 'length',
      description: `Chapter wrote ${actualWords} words against target ${targetWords}.`,
      severity: 'minor',
    },
  ];
}
