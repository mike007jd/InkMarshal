import { describe, expect, it } from 'vitest';
import {
  formatRalphRevisionBrief,
  RALPH_LOOP_MIN_SCORE,
  shouldReviseChapterInRalphLoop,
} from '@/lib/ralph-writing-loop';

describe('ralph writing loop decision', () => {
  it('revises chapters with major consistency issues', () => {
    expect(shouldReviseChapterInRalphLoop({
      score: 96,
      issues: [{ type: 'timeline', description: 'Event order contradicts chapter 2.', severity: 'major' }],
    })).toBe(true);
  });

  it('revises low-scoring chapters even when issues are minor', () => {
    expect(shouldReviseChapterInRalphLoop({
      score: RALPH_LOOP_MIN_SCORE - 1,
      issues: [{ type: 'pov', description: 'Brief POV drift.', severity: 'minor' }],
    })).toBe(true);
  });

  it('does not revise clean high-scoring chapters', () => {
    expect(shouldReviseChapterInRalphLoop({ score: 94, issues: null })).toBe(false);
  });

  it('formats a compact repair brief for the rewrite model', () => {
    const brief = formatRalphRevisionBrief({
      score: 72,
      targetWords: 5000,
      issues: [{ type: 'setting', description: 'Wrong city name.', severity: 'major' }],
    });

    expect(brief).toContain('Quality score: 72/100');
    expect(brief).toContain('[major/setting] Wrong city name.');
    expect(brief).toContain('approximately 5000 words');
  });
});
