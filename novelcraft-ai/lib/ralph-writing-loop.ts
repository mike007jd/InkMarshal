import type { ChapterQualityIssue } from '@/lib/db-types';

export const RALPH_LOOP_MIN_SCORE = 88;
export const RALPH_LOOP_MAX_REVISIONS = 1;

export interface RalphLoopDecisionInput {
  issues: ChapterQualityIssue[] | null;
  score: number | null;
}

export function shouldReviseChapterInRalphLoop(input: RalphLoopDecisionInput): boolean {
  const issues = input.issues ?? [];
  return (
    issues.some(issue => issue.severity === 'major') ||
    (typeof input.score === 'number' && input.score < RALPH_LOOP_MIN_SCORE)
  );
}

export function formatRalphRevisionBrief(input: {
  issues: ChapterQualityIssue[] | null;
  score: number | null;
  targetWords: number;
}): string {
  const issues = input.issues ?? [];
  const issueLines = issues.length > 0
    ? issues.map((issue, index) => `${index + 1}. [${issue.severity}/${issue.type}] ${issue.description}`)
    : ['No specific issues returned; tighten continuity and execution against the chapter plan.'];
  const scoreLine = typeof input.score === 'number' ? `Quality score: ${input.score}/100` : 'Quality score: unavailable';
  return [
    scoreLine,
    `Target chapter length: approximately ${input.targetWords} words.`,
    'Fix the issues below while preserving the chapter as much as possible:',
    ...issueLines,
  ].join('\n');
}
