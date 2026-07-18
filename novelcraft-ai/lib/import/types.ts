// Manuscript-import domain types (W2-1).
//
// The import pipeline is staged and deterministic:
//   1. A native file pick yields raw bytes (base64) — see desktop-runtime
//      `readLocalFile(['txt','md','docx'])`.
//   2. A parser (`parse-text` / `parse-docx`) turns those bytes into a
//      `RawDocument`: a flat ordered list of structural blocks (heading levels
//      + paragraphs) plus the detected source kind.
//   3. `detect-chapters` runs a PURE, AI-free heuristic over the blocks to
//      produce `ChapterCandidate[]` — the volume/chapter tree the user previews
//      and hand-corrects before anything is written.
//   4. The corrected candidates become an `ImportPlan` the server action
//      transacts into a new (or existing) novel.
//
// No type here imports DB, native, or AI modules — keep this storage-adapter
// neutral so the pure detector + dedupe stay trivially unit-testable.

export type ImportSource = 'txt' | 'md' | 'docx';

/**
 * One structural block of a parsed manuscript. `heading` blocks carry a `level`
 * (1 = volume-class, 2 = chapter-class, 3+ = sub-section) lifted from Markdown
 * `#`/`##`, DOCX `Heading1`/`Heading2` styles, or the TXT regex heuristic.
 * `paragraph` blocks are body prose. Order is document order.
 */
export interface DocBlock {
  kind: 'heading' | 'paragraph';
  /** 1-based heading depth; only meaningful when `kind === 'heading'`. */
  level?: number;
  text: string;
  /**
   * Set by parsers that *inferred* a heading from formatting rather than a real
   * heading style — e.g. a short fully-bold standalone line in a DOCX, or a TXT
   * line matched only by the chapter regex. The detector trusts these but the
   * preview surfaces them as "auto-detected" so the user double-checks.
   */
  inferred?: boolean;
}

export interface RawDocument {
  source: ImportSource;
  /** Original filename (for importMeta + a fallback novel title). */
  filename: string;
  blocks: DocBlock[];
}

/**
 * A single detected chapter, ready for preview + correction. `volumeTitle` is
 * the nearest preceding volume heading (null for chapters before any volume).
 * `content` is the joined body prose (paragraphs separated by a blank line).
 */
export interface ChapterCandidate {
  /** Stable per-detection id so the preview editor can key/track rows across
   *  merge/split edits without relying on array index. */
  id: string;
  /** 1-based running chapter number assigned by the detector. */
  chapterNumber: number;
  title: string;
  volumeTitle: string | null;
  content: string;
  wordCount: number;
  /** True when the chapter boundary came from an inferred (non-style) heading —
   *  drives the "auto-detected, please verify" affordance in the preview. */
  inferred: boolean;
}

/** Per-chapter merge decision the user makes after dedupe flags a collision. */
export type DedupeAction = 'skip' | 'overwrite' | 'append';

export type DedupeStatus = 'new' | 'duplicate' | 'conflict';

/**
 * One row of the merge dedupe report: how an incoming candidate compares to the
 * chapters already in the target novel.
 *
 * - `new`        — no existing chapter matches (title + fingerprint both miss).
 * - `duplicate`  — same normalized title AND same body fingerprint → almost
 *                  certainly the same chapter re-imported.
 * - `conflict`   — same normalized title but DIFFERENT body, OR same body under
 *                  a different title → the user must choose what to do.
 */
export interface DedupeResult {
  candidateId: string;
  status: DedupeStatus;
  /** chapter_number of the matched existing chapter, when one was found. */
  matchedChapterNumber: number | null;
  matchedTitle: string | null;
  /** Default action proposed for this row (user can override). */
  defaultAction: DedupeAction;
}

/** A chapter the target novel already has, used as the dedupe comparison set. */
export interface ExistingChapterRef {
  chapterNumber: number;
  title: string;
  /** Body content (used to build the fingerprint). */
  content: string;
}

/**
 * The fully-corrected import payload the wizard sends to the server action. The
 * server never re-detects — the candidate list IS the source of truth, so a
 * user's manual boundary fixes are never silently overridden.
 */
export interface ImportPlan {
  source: ImportSource;
  filename: string;
  novelTitle: string;
  chapters: ImportPlanChapter[];
}

export interface ImportPlanChapter {
  chapterNumber: number;
  title: string;
  content: string;
}

/** Per-candidate dedupe decision keyed by chapter number (merge mode only). */
export interface DedupeDecision {
  chapterNumber: number;
  action: DedupeAction;
}
