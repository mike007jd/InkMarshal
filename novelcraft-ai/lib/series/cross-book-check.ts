// W3-3 series / shared worldbuilding — cross-book consistency checker.
//
// Scans the shared knowledge entries of a series and, for each one, compares
// the per-member-novel state (`data.crossBookState[novelId]` and the explicit
// `data.perNovelOverrides[novelId]` patches) to surface continuity errors a
// writer working across several books would otherwise miss:
//   - age regression   — a character is younger in a later book than in an
//                         earlier one (per the member ordering passed in);
//   - status conflict   — two member books assert mutually-exclusive statuses
//                         for the same entity (e.g. "dead" vs an active status);
//   - relation conflict — two member books record contradictory relations
//                         deltas for the same entity.
//
// Pure + deterministic: it takes already-loaded shared entries + the member
// ordering and returns findings. DB access lives in app/actions/series.ts,
// which loads the inputs and calls this. Findings reuse the
// `ChapterQualityIssue` severity vocabulary so the report panel can render them
// with the same affordances as the unification / quality surfaces.

import type { ChapterQualityIssue } from '@/lib/db-types';
import type { CrossBookState, CrossBookStateEntry } from '@/lib/types/knowledge';

/** One ordered member novel of the series (order = in-world reading order). */
export interface SeriesMemberOrder {
  novelId: string;
  title: string;
  /** Position in the series (0-based). Lower = earlier in-world. */
  order: number;
}

/** A shared entry as the checker needs it (data already parsed). */
export interface SharedEntryForCheck {
  id: string;
  type: string;
  title: string;
  data: Record<string, unknown>;
}

/** A single cross-book conflict. Shape mirrors `ChapterQualityIssue` (severity
 *  vocabulary reused) plus the locating fields the report panel renders. */
export interface CrossBookConflict {
  entryId: string;
  entryTitle: string;
  entryType: string;
  kind: 'age_regression' | 'status_conflict' | 'relation_conflict';
  severity: ChapterQualityIssue['severity'];
  description: string;
  /** The member novels involved, in the order they conflict. */
  novelIds: string[];
}

/** Statuses that are terminal — once one book asserts it, a later book asserting
 *  an "alive/active" status is a contradiction (and vice versa). Matched
 *  case-insensitively against both en + zh authoring vocab. */
const TERMINAL_STATUS = /(dead|deceased|killed|死亡|已死|去世|阵亡)/i;
const ACTIVE_STATUS = /(alive|active|living|存活|在世|健在|活着)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCrossBookState(data: Record<string, unknown>): CrossBookState {
  return isPlainObject(data.crossBookState)
    ? (data.crossBookState as CrossBookState)
    : undefined;
}

/** Parse an age value (number or numeric string like "17 years") to a number,
 *  or null when it isn't comparable. */
function parseAge(raw: CrossBookStateEntry['age']): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.match(/-?\d+(?:\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function statusKind(status: string | undefined): 'terminal' | 'active' | 'other' | null {
  if (!status || !status.trim()) return null;
  if (TERMINAL_STATUS.test(status)) return 'terminal';
  if (ACTIVE_STATUS.test(status)) return 'active';
  return 'other';
}

/**
 * Run the cross-book consistency check for one series.
 *
 * @param sharedEntries shared knowledge entries (data parsed)
 * @param members       member novels with in-world ordering
 */
export function checkSeriesConsistency(
  sharedEntries: SharedEntryForCheck[],
  members: SeriesMemberOrder[],
): CrossBookConflict[] {
  const conflicts: CrossBookConflict[] = [];
  const orderByNovel = new Map(members.map(m => [m.novelId, m.order]));
  // Members that actually carry state for an entry, sorted by in-world order.
  const orderedMembers = [...members].sort((a, b) => a.order - b.order);

  for (const entry of sharedEntries) {
    const cb = readCrossBookState(entry.data);
    if (!cb) continue;

    // Collect this entry's per-member state in in-world order.
    const states: { novelId: string; state: CrossBookStateEntry }[] = [];
    for (const member of orderedMembers) {
      const state = cb[member.novelId];
      if (isPlainObject(state)) states.push({ novelId: member.novelId, state });
    }
    if (states.length < 2) continue;

    // ── age regression: age must be non-decreasing along in-world order ──
    let lastAge: { novelId: string; age: number } | null = null;
    for (const { novelId, state } of states) {
      const age = parseAge(state.age);
      if (age === null) continue;
      if (lastAge && age < lastAge.age) {
        conflicts.push({
          entryId: entry.id,
          entryTitle: entry.title,
          entryType: entry.type,
          kind: 'age_regression',
          severity: 'major',
          description:
            `Age regresses across the series: ${lastAge.age} (earlier book) → ${age} (later book).`,
          novelIds: [lastAge.novelId, novelId],
        });
      }
      // Track the latest non-null age (only advance when this book is later).
      if (!lastAge || (orderByNovel.get(novelId) ?? 0) >= (orderByNovel.get(lastAge.novelId) ?? 0)) {
        lastAge = { novelId, age };
      }
    }

    // ── status conflict: a terminal status followed by an active one ──
    let terminalAt: string | null = null;
    for (const { novelId, state } of states) {
      const kind = statusKind(state.status);
      if (kind === 'terminal' && terminalAt === null) {
        terminalAt = novelId;
      } else if (kind === 'active' && terminalAt !== null) {
        conflicts.push({
          entryId: entry.id,
          entryTitle: entry.title,
          entryType: entry.type,
          kind: 'status_conflict',
          severity: 'major',
          description:
            `Status contradiction: marked terminal in an earlier book but active again in a later one.`,
          novelIds: [terminalAt, novelId],
        });
      }
    }

    // Also flag two distinct non-empty "other" statuses on the same in-world
    // beat as a minor inconsistency (e.g. "captured" vs "free" with no ordering
    // implied), pairwise across members.
    const otherStatuses = states
      .map(s => ({ novelId: s.novelId, status: (s.state.status ?? '').trim() }))
      .filter(s => statusKind(s.status) === 'other' && s.status);
    for (let i = 0; i < otherStatuses.length; i++) {
      for (let j = i + 1; j < otherStatuses.length; j++) {
        if (otherStatuses[i].status.toLowerCase() !== otherStatuses[j].status.toLowerCase()) {
          conflicts.push({
            entryId: entry.id,
            entryTitle: entry.title,
            entryType: entry.type,
            kind: 'status_conflict',
            severity: 'minor',
            description:
              `Different statuses recorded across books: "${otherStatuses[i].status}" vs "${otherStatuses[j].status}".`,
            novelIds: [otherStatuses[i].novelId, otherStatuses[j].novelId],
          });
        }
      }
    }

    // ── relation conflict: two non-empty, differing relationsDelta strings ──
    const deltas = states
      .map(s => ({ novelId: s.novelId, delta: (s.state.relationsDelta ?? '').trim() }))
      .filter(s => s.delta);
    for (let i = 0; i < deltas.length; i++) {
      for (let j = i + 1; j < deltas.length; j++) {
        if (deltas[i].delta.toLowerCase() !== deltas[j].delta.toLowerCase()) {
          conflicts.push({
            entryId: entry.id,
            entryTitle: entry.title,
            entryType: entry.type,
            kind: 'relation_conflict',
            severity: 'minor',
            description:
              `Conflicting relationship notes across books: "${deltas[i].delta}" vs "${deltas[j].delta}".`,
            novelIds: [deltas[i].novelId, deltas[j].novelId],
          });
        }
      }
    }
  }

  return conflicts;
}

/** Summary counts for the report header (major/minor split). */
export function summarizeConflicts(conflicts: CrossBookConflict[]): {
  total: number;
  major: number;
  minor: number;
} {
  let major = 0;
  let minor = 0;
  for (const c of conflicts) {
    if (c.severity === 'major') major++;
    else minor++;
  }
  return { total: conflicts.length, major, minor };
}
