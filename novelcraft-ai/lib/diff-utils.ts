function normalizeForMatch(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2026/g, '...')
    .replace(/\u3002\u3002\u3002/g, '...');
}

export function locateOriginalText(
  fullText: string,
  original: string
): { start: number; end: number } | null {
  // Level 1: Exact match
  const exactIdx = fullText.indexOf(original);
  if (exactIdx !== -1) {
    return { start: exactIdx, end: exactIdx + original.length };
  }

  // Level 2: Whitespace-normalized match
  const normOriginal = original.trim().replace(/\s+/g, ' ');
  const normFull = fullText.replace(/\s+/g, ' ');
  const wsIdx = normFull.indexOf(normOriginal);
  if (wsIdx !== -1) {
    const start = mapNormalizedOffset(fullText, wsIdx);
    const end = mapNormalizedOffset(fullText, wsIdx + normOriginal.length);
    return { start, end };
  }

  // Level 3: Punctuation-normalized sliding window
  // Cap total comparisons to avoid freezing on very long texts
  const puncNormOriginal = normalizeForMatch(original);
  const MAX_COMPARISONS = 50_000;
  let comparisons = 0;
  for (let i = 0; i < fullText.length; i++) {
    for (const len of [original.length - 1, original.length, original.length + 1, original.length + 2]) {
      if (i + len > fullText.length) continue;
      if (++comparisons > MAX_COMPARISONS) {
        console.warn('[diff-utils] locateOriginalText level 3 comparison cap reached', {
          fullTextLength: fullText.length,
          originalLength: original.length,
          maxComparisons: MAX_COMPARISONS,
        });
        return null;
      }
      const substr = fullText.slice(i, i + len);
      if (normalizeForMatch(substr) === puncNormOriginal) {
        return { start: i, end: i + len };
      }
    }
  }

  return null;
}

function mapNormalizedOffset(original: string, normalizedOffset: number): number {
  if (normalizedOffset <= 0) return 0;
  let normIdx = 0;
  let origIdx = 0;
  while (normIdx < normalizedOffset && origIdx < original.length) {
    const char = original[origIdx];
    if (/\s/.test(char)) {
      while (origIdx + 1 < original.length && /\s/.test(original[origIdx + 1])) {
        origIdx++;
      }
    }
    normIdx++;
    origIdx++;
  }
  return Math.min(origIdx, original.length);
}

export interface ChangeItem {
  id: string;
  original: string;
  replacement: string;
  status: 'pending' | 'accepted' | 'rejected';
  location: { start: number; end: number } | null;
  insertAfterOriginal?: boolean;
}

export interface ApplyChangesResult {
  /** Text with every non-conflicting accepted change applied. */
  text: string;
  /** How many accepted changes were actually written. */
  appliedCount: number;
  /** Accepted changes dropped because they couldn't be located or overlapped
   *  an already-applied change. Surfaced to the user so a "0 applied" or
   *  partial apply is never silent. */
  skipped: number;
}

export function applyChanges(fullText: string, changes: ChangeItem[]): ApplyChangesResult {
  const acceptedWithLocation = changes.filter(c => c.status === 'accepted' && c.location);
  const acceptedTotal = acceptedWithLocation.length;

  const located = acceptedWithLocation
    .map(change => {
      const hinted = change.location;
      if (!hinted) return null;
      if (hinted.start < 0 || hinted.end < hinted.start || hinted.end > fullText.length) {
        return null;
      }
      const hintedText = fullText.slice(hinted.start, hinted.end);
      if (hintedText === change.original) return { ...change, location: hinted };
      const relocated = locateOriginalText(fullText, change.original);
      if (!relocated) return null;
      return { ...change, location: relocated };
    })
    .filter((c): c is ChangeItem & { location: { start: number; end: number } } => c !== null)
    .sort((a, b) => {
      if (b.location.start !== a.location.start) return b.location.start - a.location.start;
      return b.location.end - a.location.end;
    }); // reverse order

  // Greedily keep a non-overlapping set instead of bailing on the whole batch:
  // a single overlap used to drop every accepted edit and return the original
  // text unchanged with only a console.warn, so the writer believed all their
  // accepted edits landed when zero did. Now we apply what we safely can and
  // report the rest as skipped.
  const kept: Array<ChangeItem & { location: { start: number; end: number } }> = [];
  for (const change of located) {
    const last = kept[kept.length - 1];
    if (last && change.location.end > last.location.start) {
      console.warn('[diff-utils] skipped overlapping accepted change', {
        skipped: change.id,
        keptNeighbor: last.id,
      });
      continue;
    }
    kept.push(change);
  }

  let result = fullText;
  for (const change of kept) {
    const { start, end } = change.location;
    if (change.insertAfterOriginal) {
      result = result.slice(0, end) + change.replacement + result.slice(end);
    } else {
      result = result.slice(0, start) + change.replacement + result.slice(end);
    }
  }

  return { text: result, appliedCount: kept.length, skipped: acceptedTotal - kept.length };
}
