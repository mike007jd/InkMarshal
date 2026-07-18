import { z } from 'zod';
import type { LanguageModel, ModelMessage } from 'ai';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function toModelMessages(history: ChatMessage[]): ModelMessage[] {
  return history
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content })) as ModelMessage[];
}

export interface ChapterBlueprint {
  chapterNumber: number;
  title: string;
  summary: string;
}

export interface UsageMeta {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type OnFinish = (args: { text: string; usage?: UsageMeta; finishReason?: string }) => void | Promise<void>;
export type OnFinishObject<T> = (args: { object?: T; usage?: UsageMeta }) => void | Promise<void>;

// ── Greenlight schema ───────────────────────────────────────────────────────
export const GREENLIGHT_PACK_LIMITS = {
  title: 200,
  genre: 100,
  storySummary: 4000,
  characterSummary: 4000,
  arcSummary: 4000,
} as const;

// Enforce non-empty business rules, not just upper bounds: the greenlight pack
// becomes the novel's persisted title/genre/summaries that every downstream
// blueprint + chapter prompt interpolates. A model returning "" for genre/title
// previously passed validation and silently degraded the whole pipeline.
export const GreenlightPackSchema = z.object({
  title: z.string().trim().min(1).max(GREENLIGHT_PACK_LIMITS.title),
  genre: z.string().trim().min(1).max(GREENLIGHT_PACK_LIMITS.genre),
  storySummary: z.string().trim().min(1).max(GREENLIGHT_PACK_LIMITS.storySummary),
  characterSummary: z.string().trim().min(1).max(GREENLIGHT_PACK_LIMITS.characterSummary),
  arcSummary: z.string().trim().min(1).max(GREENLIGHT_PACK_LIMITS.arcSummary),
});
export type GreenlightPack = z.infer<typeof GreenlightPackSchema>;

// ── Blueprint schemas ───────────────────────────────────────────────────────
export const MIN_CHAPTER_COUNT = 3;
export const MAX_CHAPTER_COUNT = 500;
export const MAX_TARGET_WORDS = 2_000_000;
export const CHAPTER_BLUEPRINT_LIMITS = {
  title: 200,
  summary: 2000,
} as const;

export const ChapterBlueprintSchema = z.object({
  chapterNumber: z.number().int().min(1),
  title: z.string().trim().max(CHAPTER_BLUEPRINT_LIMITS.title),
  summary: z.string().trim().max(CHAPTER_BLUEPRINT_LIMITS.summary),
});

export const BookBlueprintSchema = z.object({
  chapters: z.array(ChapterBlueprintSchema).min(MIN_CHAPTER_COUNT).max(MAX_CHAPTER_COUNT),
}).superRefine((value, ctx) => {
  value.chapters.forEach((chapter, index) => {
    const expected = index + 1;
    if (chapter.chapterNumber !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chapters', index, 'chapterNumber'],
        message: `chapterNumber must be sequential starting at 1; expected ${expected}`,
      });
    }
  });
});

// ── Chapter summary / quality / unification schemas ─────────────────────────
export const CHAPTER_POST_GENERATION_LIMITS = {
  // The summarize prompt asks for a 200–400 word digest. A 400-word English
  // summary runs ~2400 chars, so the previous 1200 cap rejected valid output
  // (NoObjectGeneratedError), silently poisoning the rolling digest with the
  // raw chapter-tail fallback. 3000 covers 400 words with margin; the zh path
  // ("200–400 字" ≈ ≤400 chars) stays far under it.
  summary: 3000,
  keyFactText: 200,
  qualityIssueDescription: 1000,
  qualityIssues: 20,
} as const;

const chapterKeyFactTextSchema = z.string().max(CHAPTER_POST_GENERATION_LIMITS.keyFactText);

export const ChapterSummarySchema = z.object({
  summary: z
    .string()
    .min(40)
    .max(CHAPTER_POST_GENERATION_LIMITS.summary)
    .describe('A 200–400 word digest of what happened in the chapter.'),
  keyFacts: z.object({
    characters: z.array(chapterKeyFactTextSchema).max(20).describe('Named characters present in the chapter.'),
    locations: z.array(chapterKeyFactTextSchema).max(10).describe('Named locations/settings used.'),
    items: z.array(chapterKeyFactTextSchema).max(10).describe('Named objects/items that mattered to the plot.'),
    plotMoves: z.array(chapterKeyFactTextSchema).min(1).max(10).describe('1–10 short bullets describing what advanced.'),
  }),
});
export type ChapterSummaryResult = z.infer<typeof ChapterSummarySchema>;

export const ChapterQualitySchema = z.object({
  consistencyIssues: z.array(z.object({
    type: z.enum(['character_name', 'setting', 'timeline', 'pov', 'length', 'other']),
    description: z.string().max(CHAPTER_POST_GENERATION_LIMITS.qualityIssueDescription),
    severity: z.enum(['minor', 'major']),
  })).max(CHAPTER_POST_GENERATION_LIMITS.qualityIssues),
  overallScore: z.number().int().min(0).max(100),
});
export type ChapterQualityResult = z.infer<typeof ChapterQualitySchema>;

export const UNIFICATION_REPORT_LIMITS = {
  edits: 1000,
  original: 20_000,
  replacement: 20_000,
  rationale: 2000,
  summary: 4000,
} as const;

const nonBlankVerbatimString = (max: number) =>
  z.string()
    .max(max)
    .refine(value => value.trim().length > 0, {
      message: 'Must contain non-whitespace text.',
    });

export const UnificationReportSchema = z.object({
  edits: z.array(z.object({
    chapterNumber: z.number().int().min(1),
    // Must be non-empty: an empty `original` makes the verbatim find/replace
    // (split('').join(replacement)) explode the whole chapter into per-character
    // inserts — total corruption. Check non-blank without trimming because
    // leading/trailing whitespace can be part of the exact replacement target.
    original: nonBlankVerbatimString(UNIFICATION_REPORT_LIMITS.original).describe('exact verbatim substring from the chapter that should be replaced'),
    replacement: z.string().max(UNIFICATION_REPORT_LIMITS.replacement).describe('new text replacing the original'),
    rationale: z.string().max(UNIFICATION_REPORT_LIMITS.rationale).describe('why this edit fixes a cross-chapter inconsistency'),
    severity: z.enum(['minor', 'major']),
  })).max(UNIFICATION_REPORT_LIMITS.edits),
  summary: z.string().max(UNIFICATION_REPORT_LIMITS.summary).describe('1–3 sentences describing the cross-chapter issues found.'),
});
export type UnificationReportResult = z.infer<typeof UnificationReportSchema>;

// ── Chapter edit schemas ────────────────────────────────────────────────────
export const CHAPTER_EDIT_LIMITS = {
  changes: 100,
  original: 20_000,
  replacement: 20_000,
  summary: 1000,
} as const;

export const ChapterEditChangeSchema = z.object({
  // Non-empty for the same reason as UnificationReportSchema.original — the
  // chapter-edit apply path runs the same verbatim find/replace. Preserve
  // boundary whitespace because it can disambiguate the exact target.
  original: nonBlankVerbatimString(CHAPTER_EDIT_LIMITS.original).describe('exact verbatim substring from the chapter that should be replaced'),
  replacement: z.string().max(CHAPTER_EDIT_LIMITS.replacement).describe('new text replacing the original'),
});
export const ChapterEditSchema = z.object({
  changes: z.array(ChapterEditChangeSchema).max(CHAPTER_EDIT_LIMITS.changes),
  summary: z.string().max(CHAPTER_EDIT_LIMITS.summary).describe('1-2 sentences describing what changed and why'),
});
export type ChapterEdit = z.infer<typeof ChapterEditSchema>;
export type ChapterEditChange = z.infer<typeof ChapterEditChangeSchema>;

// ── Rolling-digest sources ─────────────────────────────────────────────────
export interface RollingDigestSource {
  chapterNumber: number;
  title: string;
  content: string;
  summary: string;
  /** True when the chapter content changed after `summary` was generated —
   *  the digest substitutes a live-content excerpt for the stale summary. */
  summaryStale?: boolean;
  keyFacts?: {
    characters?: string[];
    locations?: string[];
    items?: string[];
    plotMoves?: string[];
  } | null;
}

export interface RollingDigest {
  recentTails: string;
  earlierDigest: string;
}

// ── Volume summary (B.4 adaptive digest, kicks in past 100 chapters) ───────
export const VolumeSummarySchema = z.object({
  start: z.number().int().min(1),
  end: z.number().int().min(1),
  summary: z.string(),
});
export type VolumeSummary = z.infer<typeof VolumeSummarySchema>;

// Re-export shape for the AI provider integration
export type { LanguageModel };
