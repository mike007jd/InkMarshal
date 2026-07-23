import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { type Locale, isZhLocale } from '@/lib/i18n';
import {
  CHAPTER_POST_GENERATION_LIMITS,
  ChapterQualitySchema,
  ChapterSummarySchema,
  type ChapterBlueprint,
  type ChapterQualityResult,
  type ChapterSummaryResult,
  type RollingDigest,
  type RollingDigestSource,
  type UsageMeta,
  type VolumeSummary,
} from '@/lib/ai/types';
import type { NovelSettings } from '@/lib/db-types';
import { renderTemplate } from '@/lib/prompt-template';
import { resolveTemplate as tryResolveTemplate, variantForStage } from '@/lib/ai/prompt-runner';
import { OUTPUT_TOKEN_CEILING, maxOutputTokensForWords } from '@/lib/ai/output-budget';
import { generateStructuredObject } from '@/lib/ai/structured-output';
import { countWords } from '@/lib/utils';

// ── summarizeChapter ───────────────────────────────────────────────────────

export interface SummarizeChapterArgs {
  model: LanguageModel;
  chapterContent: string;
  chapterTitle: string;
  blueprint: ChapterBlueprint;
  language?: Locale;
  systemPrompt?: string;
  signal?: AbortSignal;
  /** W3-2: per-novel prompt variant (falls back to 'default'). */
  promptVariant?: string;
}

export async function summarizeChapter(args: SummarizeChapterArgs): Promise<{
  result: ChapterSummaryResult;
  usage?: UsageMeta;
}> {
  const { model, chapterContent, chapterTitle, blueprint, language = 'en', systemPrompt, signal, promptVariant } = args;
  const langNote = isZhLocale(language)
    ? '用中文输出 summary 字段。keyFacts 中的角色/地点/物品也用中文记录。'
    : 'Write the summary in English; use English names in keyFacts when present.';

  const template = tryResolveTemplate('chapter_summarize', 'user', language, promptVariant);
  const prompt = renderTemplate(template, {
    chapterNumber: blueprint.chapterNumber,
    chapterTitle,
    chapterContent,
    blueprintSummary: blueprint.summary,
    langNote,
  });

  const result = await generateStructuredObject({
    model,
    schema: ChapterSummarySchema,
    operation: 'summarize',
    system: systemPrompt,
    prompt,
    maxOutputTokens: OUTPUT_TOKEN_CEILING,
    abortSignal: signal,
  });
  return { result: result.object, usage: result.usage };
}

// ── summarizeVolume (B.4 adaptive digest, every 10 chapters past 100ch) ────

export interface SummarizeVolumeArgs {
  model: LanguageModel;
  chapters: Array<{ chapterNumber: number; summary: string; title: string }>;
  language?: Locale;
  systemPrompt?: string;
  signal?: AbortSignal;
}

export async function summarizeVolume(args: SummarizeVolumeArgs): Promise<{
  result: VolumeSummary;
  usage?: UsageMeta;
}> {
  const { model, chapters, language = 'en', systemPrompt, signal } = args;
  if (chapters.length === 0) {
    throw new Error('summarizeVolume requires at least one chapter');
  }
  const start = chapters[0].chapterNumber;
  const end = chapters[chapters.length - 1].chapterNumber;
  const langNote = isZhLocale(language)
    ? '用中文产出 400–800 字的卷摘要。'
    : 'Write a 400–800 word volume summary in English.';

  const joined = chapters
    .map(ch => `Ch.${ch.chapterNumber} ${ch.title}: ${ch.summary}`)
    .join('\n\n');

  const prompt = `${langNote}

The following is the chapter-by-chapter digest of chapters ${start} through ${end} of a novel. Compress them into a single coherent volume summary that preserves the most load-bearing facts (characters, locations, decisions, turning points). Do not invent details. Keep it tight enough to feed back into a future chapter's context without dominating the prompt.

${joined}`;

  const VolumeSchema = z.object({
    summary: z
      .string()
      .min(80)
      // Prompt asks for 400–800 words; 800 English words ≈ 4800 chars, so a
      // 4000 cap rejected the upper half of the requested range and stalled
      // volume folding (the digest then never compacts and grows unbounded).
      .max(6000)
      .describe('A 400–800 word digest covering this batch of chapters.'),
  });
  const result = await generateStructuredObject({
    model,
    schema: VolumeSchema,
    operation: 'summarize',
    system: systemPrompt,
    prompt,
    maxOutputTokens: OUTPUT_TOKEN_CEILING,
    abortSignal: signal,
  });
  return {
    result: {
      start,
      end,
      summary: result.object.summary,
    },
    usage: result.usage,
  };
}

// ── validateChapter ────────────────────────────────────────────────────────

export interface ValidateChapterArgs {
  model: LanguageModel;
  chapterContent: string;
  chapterTitle: string;
  knowledgeContext?: string;
  previousFactsSummary?: string;
  targetWords?: number;
  language?: Locale;
  systemPrompt?: string;
  signal?: AbortSignal;
  /** W3-2: per-novel prompt variant (falls back to 'default'). */
  promptVariant?: string;
}

export async function validateChapter(args: ValidateChapterArgs): Promise<{
  result: ChapterQualityResult;
  usage?: UsageMeta;
}> {
  const { model, chapterContent, chapterTitle, knowledgeContext, previousFactsSummary, targetWords, language = 'en', systemPrompt, signal, promptVariant } = args;
  const langNote = isZhLocale(language)
    ? '问题描述请用中文。'
    : 'Describe issues in English.';

  const template = tryResolveTemplate('chapter_validate', 'user', language, promptVariant);
  const prompt = renderTemplate(template, {
    chapterTitle,
    chapterContent,
    knowledgeSection: knowledgeContext
      ? `Canonical world / character reference (must match):\n${knowledgeContext}\n`
      : '',
    previousFactsSection: previousFactsSummary
      ? `Established facts from earlier chapters:\n${previousFactsSummary}\n`
      : '',
    targetWordsSection:
      typeof targetWords === 'number' ? `Target word count for this chapter: ~${targetWords}.\n` : '',
    langNote,
  });

  const result = await generateStructuredObject({
    model,
    schema: ChapterQualitySchema,
    operation: 'validate',
    system: systemPrompt,
    prompt,
    maxOutputTokens: OUTPUT_TOKEN_CEILING,
    abortSignal: signal,
  });
  return { result: result.object, usage: result.usage };
}

// ── reviseChapterForRalphLoop ─────────────────────────────────────────────

export interface ReviseChapterForRalphLoopArgs {
  model: LanguageModel;
  novelContext: { title?: string; genre?: string; settings?: NovelSettings | null };
  chapterContent: string;
  chapterTitle: string;
  blueprint: ChapterBlueprint;
  revisionBrief: string;
  language?: Locale;
  systemPrompt?: string;
  signal?: AbortSignal;
  /** W3-2: per-novel prompt variant (falls back to novelContext.settings, then 'default'). */
  promptVariant?: string;
}

function cleanRevisedChapter(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  return (fenceMatch?.[1] ?? trimmed).trim();
}

export async function reviseChapterForRalphLoop(args: ReviseChapterForRalphLoopArgs): Promise<{
  text: string;
  usage?: UsageMeta;
}> {
  const {
    model,
    novelContext,
    chapterContent,
    chapterTitle,
    blueprint,
    revisionBrief,
    language = 'en',
    systemPrompt,
    signal,
    promptVariant,
  } = args;
  const variant = promptVariant ?? variantForStage(novelContext.settings, 'chapter_ralph_revise');
  const langNote = isZhLocale(language)
    ? '请用中文输出完整修订后章节正文。'
    : 'Return the complete revised chapter in English.';
  const template = tryResolveTemplate('chapter_ralph_revise', 'user', language, variant);
  const prompt = renderTemplate(template, {
    novelTitle: novelContext.title ?? '',
    genre: novelContext.genre ?? '',
    chapterNumber: blueprint.chapterNumber,
    chapterTitle,
    blueprintSummary: blueprint.summary,
    revisionBrief,
    chapterContent,
    langNote,
  });

  // Size the budget to the chapter we're revising: Ralph asks the model to
  // return the FULL revised prose, so an output cap below the input length
  // turns the revision loop into a length-regression engine. MUST use the
  // CJK-aware countWords — a plain whitespace split collapses a 5000-char
  // Chinese chapter to ~1 "word", clamping the cap to its 1024 floor and
  // truncating the revision into a few-hundred-char stub.
  const currentWordCount = countWords(chapterContent);
  const result = await generateText({
    model,
    system: systemPrompt,
    prompt,
    temperature: 0.45,
    maxOutputTokens: maxOutputTokensForWords(currentWordCount),
    abortSignal: signal,
  });

  return { text: cleanRevisedChapter(result.text), usage: result.usage };
}

// ── Rolling digest with adaptive parameters (B.4) ──────────────────────────

export interface AdaptiveDigestParams {
  tailCharsPerChapter: number;
  maxBatchChars: number;
  recentWindow: number;
}

/**
 * Picks tail size, batch budget, and recency window based on novel length so
 * a 1M-word web novel doesn't blow the context window and a short novella
 * still gets meaningful continuity.
 */
export function adaptiveDigestParams(
  targetWords: number,
  chapterCount: number,
): AdaptiveDigestParams {
  const safeChapters = Math.max(1, chapterCount);
  const avgChapterWords = targetWords / safeChapters;
  const tailCharsPerChapter = Math.min(
    3000,
    Math.max(800, Math.round(avgChapterWords * 0.3 * 1.5)),
  );
  const maxBatchChars =
    targetWords <= 100_000 ? 100_000 : targetWords <= 500_000 ? 80_000 : 60_000;
  const recentWindow = avgChapterWords < 2000 ? 3 : 2;
  return { tailCharsPerChapter, maxBatchChars, recentWindow };
}

function clampFactText(value: string): string {
  return value.slice(0, CHAPTER_POST_GENERATION_LIMITS.keyFactText);
}

function clampFactList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map(value => clampFactText(value.trim()))
    .filter(Boolean);
}

function dedup(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = clampFactText(v.trim());
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Model-facing volume memory: one `Volumes X-Y: …` line per folded volume,
 *  chronological. Shared by the empty-history and main digest paths so the
 *  wording the model reads can't drift between them. */
function formatVolumeDigest(volumes: VolumeSummary[]): string {
  return [...volumes]
    .sort((a, b) => a.start - b.start)
    .map(v => `Volumes ${v.start}-${v.end}: ${v.summary}`)
    .join('\n');
}

/** Excerpt substituted for a summary that no longer matches the chapter
 *  content (see RollingDigestSource.summaryStale). */
const STALE_SUMMARY_EXCERPT_CHARS = 240;
function staleSummaryExcerpt(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= STALE_SUMMARY_EXCERPT_CHARS) return normalized;
  return `${normalized.slice(0, STALE_SUMMARY_EXCERPT_CHARS)}…`;
}

export function buildRollingDigest(
  history: RollingDigestSource[],
  recentWindow: number = 2,
  tailCharsPerChapter: number = 1500,
  options: { volumeSummaries?: VolumeSummary[] } = {},
): RollingDigest {
  const volumeSummaries = options.volumeSummaries ?? [];
  // Don't short-circuit when history is empty BUT folded volume summaries exist:
  // chat / outline / unify ops intentionally skip loading per-chapter tails yet
  // still need the long-novel volume memory. Returning early here silently
  // dropped every volume summary for those ops.
  if (history.length === 0) {
    if (volumeSummaries.length === 0) return { recentTails: '', earlierDigest: '' };
    return { recentTails: '', earlierDigest: formatVolumeDigest(volumeSummaries) };
  }

  const sorted = [...history].sort((a, b) => a.chapterNumber - b.chapterNumber);
  const recentStart = Math.max(0, sorted.length - recentWindow);
  const earlier = sorted.slice(0, recentStart);
  const recent = sorted.slice(recentStart);

  const earliestRecentChapter = recent[0]?.chapterNumber ?? Number.POSITIVE_INFINITY;
  const usableVolumes = volumeSummaries
    .filter(v => v.end < earliestRecentChapter)
    .sort((a, b) => a.start - b.start);

  let earlierDigest = '';
  let earlierBoundary = 0;
  if (usableVolumes.length > 0) {
    earlierDigest = formatVolumeDigest(usableVolumes);
    earlierBoundary = usableVolumes[usableVolumes.length - 1].end;
  }

  const remainingEarlier = earlier.filter(ch => ch.chapterNumber > earlierBoundary);
  if (remainingEarlier.length > 0) {
    const aggregateChars: string[] = [];
    const aggregateLocs: string[] = [];
    const aggregateItems: string[] = [];
    for (const ch of remainingEarlier) {
      aggregateChars.push(...(ch.keyFacts?.characters ?? []));
      aggregateLocs.push(...(ch.keyFacts?.locations ?? []));
      aggregateItems.push(...(ch.keyFacts?.items ?? []));
    }
    const dedupedChars = dedup(aggregateChars);
    const dedupedLocs = dedup(aggregateLocs);
    const dedupedItems = dedup(aggregateItems);

    const chapterLines = remainingEarlier.map(ch => {
      const facts = ch.keyFacts;
      const factParts: string[] = [];
      const characters = clampFactList(facts?.characters);
      const locations = clampFactList(facts?.locations);
      const plotMoves = clampFactList(facts?.plotMoves);
      if (characters.length) factParts.push(`chars: ${characters.join(', ')}`);
      if (locations.length) factParts.push(`places: ${locations.join(', ')}`);
      if (plotMoves.length) factParts.push(`moves: ${plotMoves.join('; ')}`);
      const factLine = factParts.length ? `\n  facts — ${factParts.join(' | ')}` : '';
      // A stale summary describes text the user has since rewritten — feeding
      // it forward would steer the next chapter off the real story. Substitute
      // a live-content excerpt until a fresh summary lands.
      const summaryLine = ch.summaryStale
        ? `(summary outdated after edits; opening excerpt) ${staleSummaryExcerpt(ch.content)}`
        : ch.summary;
      return `Ch.${ch.chapterNumber} ${ch.title}: ${summaryLine}${factLine}`;
    });

    const rollupLines: string[] = [];
    if (dedupedChars.length) rollupLines.push(`Characters seen: ${dedupedChars.join(', ')}`);
    if (dedupedLocs.length) rollupLines.push(`Places seen: ${dedupedLocs.join(', ')}`);
    if (dedupedItems.length) rollupLines.push(`Items seen: ${dedupedItems.join(', ')}`);

    const detailBlock = chapterLines.join('\n');
    const block = rollupLines.length > 0 ? `${rollupLines.join('\n')}\n${detailBlock}` : detailBlock;
    earlierDigest = earlierDigest ? `${earlierDigest}\n${block}` : block;
  }

  const recentTails = recent
    .map(ch => {
      const text = ch.content || '';
      const tail = text.length > tailCharsPerChapter ? text.slice(-tailCharsPerChapter) : text;
      return `Ch.${ch.chapterNumber} ${ch.title} (tail):\n${tail}`;
    })
    .join('\n\n');

  return { recentTails, earlierDigest };
}
