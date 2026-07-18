// Merge dedupe (W2-1) — PURE, NO AI, NO DB.
//
// When importing INTO an existing novel, we must not silently clobber chapters
// the author already has. This compares each incoming candidate against the
// target novel's existing chapters on two axes:
//
//   - normalized title   — case/space/punctuation-folded; CJK-aware.
//   - body fingerprint    — a normalized prefix of the first N significant
//                           characters of the content.
//
// and classifies the pair as `new` / `duplicate` / `conflict`, proposing a
// default action the user can override:
//   - new        → append   (write as a fresh chapter)
//   - duplicate  → skip      (identical content already present)
//   - conflict   → overwrite (same title, changed body — most likely an update;
//                  user can flip to skip/append)
//
// The DECISION is always the user's — this only proposes. The server action's
// merge path captures a safety snapshot before any overwrite (see import.ts).

import type {
  ChapterCandidate,
  DedupeAction,
  DedupeResult,
  DedupeStatus,
  ExistingChapterRef,
} from '@/lib/import/types';

/** First N significant chars of the body used as the dup fingerprint. Long
 *  enough to distinguish chapters, short enough that a trailing edit to a long
 *  chapter doesn't break the match. */
export const FINGERPRINT_CHARS = 200;

/**
 * Normalize a title for comparison: strip a leading "第X章 / Chapter N" marker
 * so "第三章 启程" and "启程" match, lowercase, drop all whitespace + most
 * punctuation. CJK is preserved verbatim (it carries the signal).
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    // Strip a leading chapter/volume ordinal marker so the human title is what
    // we compare ("第3章：启程" → "启程"); a bare ordinal with no title folds
    // to '' and falls through to the fingerprint comparison.
    //
    // No trailing `\b` after the CJK marker (章/卷 are not `\w`, so `\b` would
    // never match) — instead consume an optional separator run after the marker.
    .replace(
      /^\s*(?:第\s*[0-9零一二三四五六七八九十百千两]+\s*[章节回折卷]|chapter\s+[0-9ivxlcdm]+|volume\s+[0-9ivxlcdm]+)[\s:：、.\-—]*/i,
      '',
    )
    .replace(/[\s　]+/g, '')
    .replace(/[.,;:!?'"`~@#$%^&*()\[\]{}<>/\\|+=_\-—–。，、；：！？「」『』（）【】《》·~]/g, '')
    .trim();
}

/**
 * Build the body fingerprint: NFKC-normalize, collapse whitespace, drop
 * punctuation, lowercase, then take the first FINGERPRINT_CHARS chars. Two
 * chapters with the same opening prose collide even if later paragraphs differ
 * slightly — that's intentional for "is this the same chapter" detection.
 *
 * Returns '' for a body that is entirely whitespace/punctuation (e.g. a stub
 * placeholder chapter). Such candidates fall through to {@link fallbackKey}
 * below so they still dedup instead of being appended as duplicates.
 */
export function fingerprintBody(content: string): string {
  return content
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[.,;:!?'"`~@#$%^&*()\[\]{}<>/\\|+=_\-—–。，、；：！？「」『』（）【】《》·~]/g, '')
    .slice(0, FINGERPRINT_CHARS);
}

/**
 * Last-resort identity key for chapters whose normalized title AND body
 * fingerprint both collapse to '' (all-punctuation/whitespace stub chapters,
 * common in serial outlines). Uses the raw (only whitespace-trimmed, NFKC'd)
 * title + opening characters so two identical stubs still match. Without this,
 * re-importing the same stub appended a duplicate every time.
 */
function fallbackKey(title: string, content: string): string {
  const rawTitle = title.normalize('NFKC').trim();
  const rawBody = content.normalize('NFKC').replace(/[\s　]+/g, ' ').trim().slice(0, FINGERPRINT_CHARS);
  return `fb:${rawTitle}::${rawBody}`;
}

const ACTION_FOR_STATUS: Record<DedupeStatus, DedupeAction> = {
  new: 'append',
  duplicate: 'skip',
  conflict: 'overwrite',
};

interface IndexedExisting {
  ref: ExistingChapterRef;
  normTitle: string;
  fingerprint: string;
  fallback: string;
}

/**
 * Compare incoming candidates against existing chapters. Returns one
 * `DedupeResult` per candidate, in candidate order.
 */
export function dedupeCandidates(
  candidates: ChapterCandidate[],
  existing: ExistingChapterRef[],
): DedupeResult[] {
  const indexed: IndexedExisting[] = existing.map(ref => ({
    ref,
    normTitle: normalizeTitle(ref.title),
    fingerprint: fingerprintBody(ref.content),
    fallback: fallbackKey(ref.title, ref.content),
  }));

  // Lookup maps. A normalized title or fingerprint can in theory repeat across
  // chapters; first match wins (lowest chapter_number), which is the stable,
  // predictable choice for the user.
  const byTitle = new Map<string, IndexedExisting>();
  const byFingerprint = new Map<string, IndexedExisting>();
  const byFallback = new Map<string, IndexedExisting>();
  for (const item of indexed) {
    if (item.normTitle && !byTitle.has(item.normTitle)) byTitle.set(item.normTitle, item);
    if (item.fingerprint && !byFingerprint.has(item.fingerprint)) {
      byFingerprint.set(item.fingerprint, item);
    }
    if (!byFallback.has(item.fallback)) byFallback.set(item.fallback, item);
  }

  return candidates.map(candidate => {
    const normTitle = normalizeTitle(candidate.title);
    const fingerprint = fingerprintBody(candidate.content);

    const titleMatch = normTitle ? byTitle.get(normTitle) ?? null : null;
    const fpMatch = fingerprint ? byFingerprint.get(fingerprint) ?? null : null;
    // Stub/placeholder chapters (empty normalized title AND empty fingerprint)
    // still dedup via the raw fallback key so re-importing the same stub does
    // not append a duplicate.
    const fallbackMatch = !normTitle && !fingerprint
      ? byFallback.get(fallbackKey(candidate.title, candidate.content)) ?? null
      : null;

    let status: DedupeStatus;
    let matched: IndexedExisting | null;

    if (titleMatch && fpMatch && titleMatch.ref.chapterNumber === fpMatch.ref.chapterNumber) {
      // Same chapter on both axes → an exact re-import.
      status = 'duplicate';
      matched = titleMatch;
    } else if (titleMatch && fpMatch) {
      // Title points at one chapter, body at another → ambiguous, let the user
      // decide. Surface the title match as the primary (that's the slot the
      // overwrite default would target).
      status = 'conflict';
      matched = titleMatch;
    } else if (titleMatch) {
      // Same title, different (or no) body → almost always an edited version of
      // the same chapter.
      status = 'conflict';
      matched = titleMatch;
    } else if (fpMatch) {
      // Same body under a different title → likely the same chapter renamed.
      status = 'conflict';
      matched = fpMatch;
    } else if (fallbackMatch) {
      // Both normalized title and fingerprint collapsed to '' (stub/placeholder
      // chapter) but the raw fallback key matched an existing stub → treat as a
      // duplicate so re-importing the same stub does not append it again.
      status = 'duplicate';
      matched = fallbackMatch;
    } else {
      status = 'new';
      matched = null;
    }

    return {
      candidateId: candidate.id,
      status,
      matchedChapterNumber: matched?.ref.chapterNumber ?? null,
      matchedTitle: matched?.ref.title ?? null,
      defaultAction: ACTION_FOR_STATUS[status],
    } satisfies DedupeResult;
  });
}
