// W3-1 — outline aggregation. "Show me every scene where Alice appears" /
// "...set in the Tower" / "...on the Rebellion plotline". Pure functions over an
// already-loaded outline node list (the API route loads rows, parses them, and
// hands the parsed list here) so this is trivially unit-testable and reusable by
// the client-side filter bar without a round-trip.

import type { OutlineLevel, SceneMeta } from '@/lib/types/knowledge';

export type AggregateBy = 'character' | 'location' | 'plotline';

const AGGREGATE_BY_VALUES: readonly AggregateBy[] = ['character', 'location', 'plotline'];

export function isAggregateBy(value: unknown): value is AggregateBy {
  return typeof value === 'string' && (AGGREGATE_BY_VALUES as readonly string[]).includes(value);
}

/** Node shape the aggregator scans. Mirrors the parsed `OutlineEntry` but only
 *  the fields aggregation needs, so callers can pass a slim projection. */
export interface AggregateNode {
  id: string;
  title: string;
  level: OutlineLevel;
  parentId: string;
  synopsis: string;
  characters: string[];
  plotlineTags: string[];
  characterArcTags: string[];
  sceneMeta: SceneMeta;
  chapterNumber?: number;
}

export interface AggregateMatch {
  id: string;
  title: string;
  level: OutlineLevel;
  parentId: string;
  synopsis: string;
  /** Why this node matched (the concrete value, e.g. the character name). */
  matchedValue: string;
  /** Scene POV/time/location surfaced for the aggregate card. */
  sceneMeta: SceneMeta;
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * All scene-level nodes that reference `value` along the requested axis.
 *   - character: `data.characters[]` OR `sceneMeta.pov`
 *   - location:  `sceneMeta.location`
 *   - plotline:  `data.plotlineTags[]`
 * Matching is case-insensitive and whitespace-trimmed. Only `level==='scene'`
 * rows are scanned — the spec aggregates at the scene level (volumes/chapters
 * carry no POV/location of their own; beats inherit their scene's context).
 */
export function aggregateScenes(
  nodes: AggregateNode[],
  by: AggregateBy,
  value: string,
): AggregateMatch[] {
  const target = norm(value);
  if (!target) return [];

  const matches: AggregateMatch[] = [];
  for (const node of nodes) {
    if (node.level !== 'scene') continue;

    let matchedValue: string | null = null;
    if (by === 'character') {
      const hit = node.characters.find(c => norm(c) === target);
      if (hit) matchedValue = hit;
      else if (node.sceneMeta.pov && norm(node.sceneMeta.pov) === target) matchedValue = node.sceneMeta.pov;
    } else if (by === 'location') {
      if (node.sceneMeta.location && norm(node.sceneMeta.location) === target) {
        matchedValue = node.sceneMeta.location;
      }
    } else {
      const hit = node.plotlineTags.find(p => norm(p) === target);
      if (hit) matchedValue = hit;
    }

    if (matchedValue !== null) {
      matches.push({
        id: node.id,
        title: node.title,
        level: node.level,
        parentId: node.parentId,
        synopsis: node.synopsis,
        matchedValue,
        sceneMeta: node.sceneMeta,
      });
    }
  }
  return matches;
}

/**
 * Distinct facet values present across all scene nodes for an axis, with a
 * per-value scene count. Powers the aggregate view's value picker (so the user
 * sees "Alice (12 scenes)" without typing a name). Sorted by count desc then
 * value asc.
 */
export function collectAggregateValues(
  nodes: AggregateNode[],
  by: AggregateBy,
): { value: string; count: number }[] {
  const counts = new Map<string, { value: string; count: number }>();
  const bump = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = norm(trimmed);
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { value: trimmed, count: 1 });
  };

  for (const node of nodes) {
    if (node.level !== 'scene') continue;
    if (by === 'character') {
      node.characters.forEach(bump);
      if (node.sceneMeta.pov) bump(node.sceneMeta.pov);
    } else if (by === 'location') {
      if (node.sceneMeta.location) bump(node.sceneMeta.location);
    } else {
      node.plotlineTags.forEach(bump);
    }
  }

  return [...counts.values()].sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.value < b.value ? -1 : 1,
  );
}
