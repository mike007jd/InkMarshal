import { describe, expect, it } from 'vitest';
import {
  aggregateScenes,
  collectAggregateValues,
  isAggregateBy,
  type AggregateNode,
} from '@/lib/outline/aggregate';
import type { SceneMeta } from '@/lib/types/knowledge';

function meta(partial: Partial<SceneMeta> = {}): SceneMeta {
  return { pov: '', time: '', location: '', conflict: '', outcome: '', ...partial };
}

function scene(
  id: string,
  opts: {
    characters?: string[];
    plotlineTags?: string[];
    sceneMeta?: Partial<SceneMeta>;
    level?: AggregateNode['level'];
  } = {},
): AggregateNode {
  return {
    id,
    title: id,
    level: opts.level ?? 'scene',
    parentId: '',
    synopsis: '',
    characters: opts.characters ?? [],
    plotlineTags: opts.plotlineTags ?? [],
    characterArcTags: [],
    sceneMeta: meta(opts.sceneMeta),
  };
}

describe('aggregateScenes', () => {
  const nodes: AggregateNode[] = [
    scene('s1', { characters: ['Alice', 'Bob'], sceneMeta: { location: 'Tower', pov: 'Alice' }, plotlineTags: ['Rebellion'] }),
    scene('s2', { characters: ['Bob'], sceneMeta: { location: 'Market' }, plotlineTags: ['Romance'] }),
    scene('s3', { characters: [], sceneMeta: { location: 'Tower', pov: 'Carol' }, plotlineTags: ['Rebellion'] }),
    scene('c1', { level: 'chapter', characters: ['Alice'], sceneMeta: { location: 'Tower' } }), // chapter, ignored
  ];

  it('matches by character (case-insensitive) and includes pov-only matches', () => {
    const alice = aggregateScenes(nodes, 'character', 'alice');
    expect(alice.map(m => m.id)).toEqual(['s1']);
    // Carol only appears as a POV, not in characters[].
    const carol = aggregateScenes(nodes, 'character', 'Carol');
    expect(carol.map(m => m.id)).toEqual(['s3']);
  });

  it('matches by location', () => {
    const tower = aggregateScenes(nodes, 'location', 'Tower');
    expect(tower.map(m => m.id)).toEqual(['s1', 's3']);
  });

  it('matches by plotline tag', () => {
    const reb = aggregateScenes(nodes, 'plotline', 'Rebellion');
    expect(reb.map(m => m.id)).toEqual(['s1', 's3']);
  });

  it('ignores non-scene rows even when they carry the value', () => {
    const tower = aggregateScenes(nodes, 'location', 'Tower');
    expect(tower.some(m => m.id === 'c1')).toBe(false);
  });

  it('returns [] for an empty value', () => {
    expect(aggregateScenes(nodes, 'character', '   ')).toEqual([]);
  });
});

describe('collectAggregateValues', () => {
  it('counts distinct facet values sorted by count desc', () => {
    const nodes: AggregateNode[] = [
      scene('s1', { characters: ['Alice', 'Bob'] }),
      scene('s2', { characters: ['Alice'] }),
      scene('s3', { characters: ['Carol'], sceneMeta: { pov: 'Alice' } }),
    ];
    const values = collectAggregateValues(nodes, 'character');
    expect(values[0]).toEqual({ value: 'Alice', count: 3 });
    expect(values.map(v => v.value)).toContain('Bob');
    expect(values.map(v => v.value)).toContain('Carol');
  });
});

describe('isAggregateBy', () => {
  it('validates the axis', () => {
    expect(isAggregateBy('character')).toBe(true);
    expect(isAggregateBy('plotline')).toBe(true);
    expect(isAggregateBy('nonsense')).toBe(false);
    expect(isAggregateBy(null)).toBe(false);
  });
});
