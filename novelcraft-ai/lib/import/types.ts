// Manuscript-import domain types.
//
// Opaque session pipeline:
//   1. Native `stageManuscriptImport` copies the picked file under
//      `import-sessions/{token}/` and returns only `{ token, basename }`.
//   2. Node opens the session: parses the staged file, retains full prose
//      server-side, and returns bounded preview snippets + stable segment ids.
//   3. The client corrects boundaries via rename / merge-adjacent /
//      split-at-paragraph while tracking compact `parts` references.
//   4. Confirm sends only compact metadata/parts/dedupe decisions; the server
//      reconstructs exact prose and writes atomically.

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
 * A single detected chapter with full prose (server-side only after open).
 * Never returned to the client in the opaque session pipeline.
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

/** Contiguous coverage of one stored segment's paragraphs (half-open range). */
export interface ImportChapterPart {
  segmentId: string;
  /** Inclusive start paragraph index (0-based). */
  fromParagraph: number;
  /** Exclusive end paragraph index. */
  toParagraph: number;
}

/**
 * Client-facing chapter preview. Full prose stays server-side; the UI edits
 * titles / boundaries while retaining `parts` for exact reconstruction.
 */
export interface ImportPreviewChapter {
  /** Stable UI row id (may be regenerated on renumber; parts are authoritative). */
  id: string;
  chapterNumber: number;
  title: string;
  volumeTitle: string | null;
  wordCount: number;
  inferred: boolean;
  /** Bounded body preview (not full prose). */
  snippet: string;
  /** Bounded per-paragraph snippets for split-at-paragraph. */
  paragraphs: string[];
  /** Exact reconstruction references into the server-side segment store. */
  parts: ImportChapterPart[];
}

/** Compact chapter descriptor sent on confirm / dedupe (no prose). */
export interface ImportChapterRef {
  title: string;
  parts: ImportChapterPart[];
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

/** Internal reconstruction shape after the server expands compact refs to prose. */
export interface ImportPlanChapter {
  chapterNumber: number;
  title: string;
  content: string;
}

/** Per-candidate dedupe decision keyed by chapter number (merge mode only). */
export interface DedupeDecision {
  chapterNumber: number;
  action: DedupeAction;
  /** Existing target reported by server dedupe; null when no match exists. */
  matchedChapterNumber: number | null;
}
