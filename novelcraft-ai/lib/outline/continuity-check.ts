// W3-1 — deterministic (non-AI) continuity check run after a reorder. Pure
// structural comparison over the flattened scene reading order: no model call,
// no token spend, instant + unit-testable. Surfaces non-blocking warnings the UI
// shows in a banner; the reorder itself always succeeds.

import type { OutlineLevel, SceneMeta } from '@/lib/types/knowledge';

type ContinuityWarningKind = 'time_regression' | 'pov_whiplash' | 'plotline_gap';

export interface ContinuityNode {
  id: string;
  title: string;
  level: OutlineLevel;
  sceneMeta: SceneMeta;
  plotlineTags: string[];
}

export interface ContinuityWarning {
  kind: ContinuityWarningKind;
  /** The scene the warning is anchored on (the later of the two for ordering
   *  issues) so the UI can scroll to it. */
  nodeId: string;
  title: string;
  message: string;
}

/** Reading order of scene-level nodes only. Beats/chapters/volumes are skipped:
 *  continuity is a scene-to-scene property. */
function sceneSequence(orderedNodes: ContinuityNode[]): ContinuityNode[] {
  return orderedNodes.filter(n => n.level === 'scene');
}

/**
 * Parse a free-text `time` field into a comparable number when it is purely
 * numeric-ish (e.g. "Day 3", "Chapter 12", "1999", "07:30"). Returns null when
 * the field has no leading number we can trust — we only flag a regression when
 * BOTH adjacent scenes expose a parseable ordinal, so prose timestamps never
 * produce false positives.
 */
function parseTimeOrdinal(time: string): number | null {
  const trimmed = time.trim();
  if (!trimmed) return null;
  // "07:30" / "7:30" → minutes since midnight.
  const clock = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h <= 23 && m <= 59) return h * 60 + m;
  }
  // First standalone integer anywhere in the string ("Day 3", "第3天", "1999").
  const match = /(-?\d+(?:\.\d+)?)/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Produce the warning list for a candidate scene reading order. Three rules:
 *   1. time_regression — an adjacent scene pair where both expose a parseable
 *      time ordinal and the later scene's ordinal is strictly smaller (the
 *      timeline went backwards without an intervening reset).
 *   2. pov_whiplash — three consecutive scenes A,B,C where pov(A)===pov(C) but
 *      pov(B) differs (a one-scene POV detour that often reads as an editing
 *      slip after a reorder). Only fires when all three POVs are set.
 *   3. plotline_gap — a plotline that appears, disappears for ≥1 scenes, then
 *      reappears (a dangling thread). Reported once, anchored on the scene where
 *      the thread resumes.
 * All rules are advisory; the function never throws.
 */
export function checkContinuity(orderedNodes: ContinuityNode[]): ContinuityWarning[] {
  const scenes = sceneSequence(orderedNodes);
  const warnings: ContinuityWarning[] = [];

  // Rule 1 — time regression.
  for (let i = 1; i < scenes.length; i++) {
    const prev = parseTimeOrdinal(scenes[i - 1].sceneMeta.time);
    const curr = parseTimeOrdinal(scenes[i].sceneMeta.time);
    if (prev !== null && curr !== null && curr < prev) {
      warnings.push({
        kind: 'time_regression',
        nodeId: scenes[i].id,
        title: scenes[i].title,
        message: `Time goes backwards: "${scenes[i - 1].sceneMeta.time}" → "${scenes[i].sceneMeta.time}"`,
      });
    }
  }

  // Rule 2 — single-scene POV detour (whiplash).
  for (let i = 2; i < scenes.length; i++) {
    const a = scenes[i - 2].sceneMeta.pov.trim();
    const b = scenes[i - 1].sceneMeta.pov.trim();
    const c = scenes[i].sceneMeta.pov.trim();
    if (a && b && c && a === c && a !== b) {
      warnings.push({
        kind: 'pov_whiplash',
        nodeId: scenes[i - 1].id,
        title: scenes[i - 1].title,
        message: `POV detour: ${a} → ${b} → ${a} across three scenes`,
      });
    }
  }

  // Rule 3 — plotline gap (thread reappears after a break).
  const lastSeenIndex = new Map<string, number>();
  const reported = new Set<string>();
  scenes.forEach((scene, index) => {
    for (const rawTag of scene.plotlineTags) {
      const tag = rawTag.trim();
      if (!tag) continue;
      const last = lastSeenIndex.get(tag);
      if (last !== undefined && index - last > 1 && !reported.has(tag)) {
        warnings.push({
          kind: 'plotline_gap',
          nodeId: scene.id,
          title: scene.title,
          message: `Plotline "${tag}" resumes after a ${index - last - 1}-scene gap`,
        });
        reported.add(tag);
      }
      lastSeenIndex.set(tag, index);
    }
  });

  return warnings;
}
