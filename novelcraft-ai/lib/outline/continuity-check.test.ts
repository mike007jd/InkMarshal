import { describe, expect, it } from 'vitest';
import { checkContinuity, type ContinuityNode } from '@/lib/outline/continuity-check';
import type { SceneMeta } from '@/lib/types/knowledge';

function meta(partial: Partial<SceneMeta> = {}): SceneMeta {
  return { pov: '', time: '', location: '', conflict: '', outcome: '', ...partial };
}

function scene(
  id: string,
  opts: { pov?: string; time?: string; plotlineTags?: string[]; level?: ContinuityNode['level'] } = {},
): ContinuityNode {
  return {
    id,
    title: id,
    level: opts.level ?? 'scene',
    sceneMeta: meta({ pov: opts.pov ?? '', time: opts.time ?? '' }),
    plotlineTags: opts.plotlineTags ?? [],
  };
}

describe('checkContinuity — time regression', () => {
  it('flags when a parseable time goes backwards', () => {
    const warnings = checkContinuity([
      scene('s1', { time: 'Day 3' }),
      scene('s2', { time: 'Day 1' }),
    ]);
    expect(warnings.filter(w => w.kind === 'time_regression')).toHaveLength(1);
    expect(warnings[0].nodeId).toBe('s2');
  });

  it('parses clock times', () => {
    const warnings = checkContinuity([
      scene('s1', { time: '14:30' }),
      scene('s2', { time: '09:00' }),
    ]);
    expect(warnings.some(w => w.kind === 'time_regression')).toBe(true);
  });

  it('does NOT flag prose timestamps (no false positives)', () => {
    const warnings = checkContinuity([
      scene('s1', { time: 'a quiet evening' }),
      scene('s2', { time: 'the next morning' }),
    ]);
    expect(warnings.some(w => w.kind === 'time_regression')).toBe(false);
  });

  it('does NOT flag a forward-moving timeline', () => {
    const warnings = checkContinuity([
      scene('s1', { time: 'Day 1' }),
      scene('s2', { time: 'Day 2' }),
    ]);
    expect(warnings.some(w => w.kind === 'time_regression')).toBe(false);
  });
});

describe('checkContinuity — pov whiplash', () => {
  it('flags a one-scene POV detour A->B->A', () => {
    const warnings = checkContinuity([
      scene('s1', { pov: 'Alice' }),
      scene('s2', { pov: 'Bob' }),
      scene('s3', { pov: 'Alice' }),
    ]);
    const wl = warnings.filter(w => w.kind === 'pov_whiplash');
    expect(wl).toHaveLength(1);
    expect(wl[0].nodeId).toBe('s2');
  });

  it('does NOT flag a sustained POV change', () => {
    const warnings = checkContinuity([
      scene('s1', { pov: 'Alice' }),
      scene('s2', { pov: 'Bob' }),
      scene('s3', { pov: 'Bob' }),
    ]);
    expect(warnings.some(w => w.kind === 'pov_whiplash')).toBe(false);
  });
});

describe('checkContinuity — plotline gap', () => {
  it('flags a thread that resumes after a gap', () => {
    const warnings = checkContinuity([
      scene('s1', { plotlineTags: ['Rebellion'] }),
      scene('s2', { plotlineTags: ['Romance'] }),
      scene('s3', { plotlineTags: ['Rebellion'] }),
    ]);
    const gaps = warnings.filter(w => w.kind === 'plotline_gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].nodeId).toBe('s3');
  });

  it('does NOT flag a contiguous thread', () => {
    const warnings = checkContinuity([
      scene('s1', { plotlineTags: ['Rebellion'] }),
      scene('s2', { plotlineTags: ['Rebellion'] }),
    ]);
    expect(warnings.some(w => w.kind === 'plotline_gap')).toBe(false);
  });
});

describe('checkContinuity — scope', () => {
  it('only considers scene-level nodes', () => {
    const warnings = checkContinuity([
      scene('c1', { time: 'Day 9', level: 'chapter' }),
      scene('s1', { time: 'Day 1' }),
      scene('s2', { time: 'Day 2' }),
    ]);
    // The chapter row's Day 9 must not seed a regression against s1's Day 1.
    expect(warnings.some(w => w.kind === 'time_regression')).toBe(false);
  });

  it('never throws on empty input', () => {
    expect(checkContinuity([])).toEqual([]);
  });
});
