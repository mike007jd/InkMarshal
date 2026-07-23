import { streamText, type LanguageModel } from 'ai';
import { type Locale, isZhLocale } from '@/lib/i18n';
import {
  BookBlueprintSchema,
  MAX_CHAPTER_COUNT,
  MAX_TARGET_WORDS,
  MIN_CHAPTER_COUNT,
  type ChapterBlueprint,
  type OnFinish,
  type UsageMeta,
} from '@/lib/ai/types';
import type { GenerationPreset } from '@/lib/ai/generation-presets';
import { renderTemplate } from '@/lib/prompt-template';
import { resolveTemplate as tryResolveTemplate, variantForStage } from '@/lib/ai/prompt-runner';
import type { NovelSettings } from '@/lib/db-types';

/**
 * W3-2: the ai/* generators resolve prompts against a per-novel variant. The
 * variant is selected from `novels.settings` — callers either pass the explicit
 * `promptVariant` (preferred) or hand the full novel record as `novelContext`
 * (the start-writing usecase does), in which case its `.settings` is read here.
 * `undefined` resolves to the seeded `'default'` template, so existing callers
 * that pass neither are unchanged.
 */
function pickVariant(
  explicit: string | undefined,
  novelContext: { settings?: NovelSettings | null } | undefined,
  stage: string,
): string | undefined {
  if (explicit) return explicit;
  return variantForStage(novelContext?.settings, stage);
}
import { OUTPUT_TOKEN_CEILING, maxOutputTokensForWords } from '@/lib/ai/output-budget';
import { generateStructuredObject } from '@/lib/ai/structured-output';

// Default per-chapter target used when chapter count is unknown.
const TARGET_WORDS_PER_CHAPTER = 5_000;
// Hard per-chapter ceiling. Deliberately equal to the default: 5000 words is
// both our typical target and the most we want a single chapter to grow to, so
// `getTargetWordsPerChapter`'s `Math.min` caps a sparse blueprint (few chapters
// over a huge word target) back down to 5000 rather than asking for 6000+-word
// chapters. Kept as a distinct named constant because the two roles (default vs
// ceiling) are conceptually separate even though the value coincides today.
const MAX_TARGET_WORDS_PER_CHAPTER = 5_000;

// How much of an in-progress chapter to feed back as context for a
// "continue from here" pass. Only the tail matters for a seamless seam; the
// blueprint summary (passed separately) carries the plot beat to cover.
const CONTINUATION_CONTEXT_TAIL_CHARS = 2_000;

// Per-chapter target scales with novel length so a 1M-word web novel doesn't
// get squeezed into 50×20k-word mega-chapters and an 80k novella doesn't get
// fragmented into tiny scenes.
function pickWordsPerChapterForLength(targetWords: number): number {
  if (targetWords <= 300_000) return 5_000;
  if (targetWords <= 800_000) return 4_000;
  return 3_500;
}

export function getTargetChapterCount(targetWords: number = 80_000): number {
  if (!Number.isFinite(targetWords) || targetWords <= 0) {
    return MIN_CHAPTER_COUNT;
  }
  if (targetWords > MAX_TARGET_WORDS) {
    targetWords = MAX_TARGET_WORDS;
  }
  const wordsPerChapter = pickWordsPerChapterForLength(targetWords);
  const count = Math.round(targetWords / wordsPerChapter);
  return Math.min(Math.max(count, MIN_CHAPTER_COUNT), MAX_CHAPTER_COUNT);
}

export function getTargetWordsPerChapter(
  targetWords: number = 80_000,
  chapterCount: number = getTargetChapterCount(targetWords),
): number {
  if (chapterCount <= 0) return TARGET_WORDS_PER_CHAPTER;
  return Math.min(MAX_TARGET_WORDS_PER_CHAPTER, Math.max(800, Math.round(targetWords / chapterCount)));
}

export function selectChapterPlansToWrite(
  blueprint: ChapterBlueprint[],
  existingChapters: Array<{ chapterNumber: number }>,
): ChapterBlueprint[] {
  const existingNumbers = new Set(existingChapters.map(ch => ch.chapterNumber));
  return blueprint.filter(chapter => !existingNumbers.has(chapter.chapterNumber));
}

// ── generateBookBlueprint ──────────────────────────────────────────────────

export interface GenerateBookBlueprintArgs {
  model: LanguageModel;
  novelContext: {
    title?: string;
    genre?: string;
    storySummary?: string;
    characterSummary?: string;
    arcSummary?: string;
    targetWords?: number;
    /** W3-2: when the full novel record is passed, its variant selection is read from here. */
    settings?: NovelSettings | null;
  };
  language?: Locale;
  systemPrompt?: string;
  signal?: AbortSignal;
  /** W3-2: per-novel prompt variant (falls back to novelContext.settings, then 'default'). */
  promptVariant?: string;
}

export async function generateBookBlueprint(args: GenerateBookBlueprintArgs): Promise<{
  chapters: ChapterBlueprint[];
  usage?: UsageMeta;
}> {
  const { model, novelContext, language = 'en', systemPrompt, signal, promptVariant } = args;
  const variant = pickVariant(promptVariant, novelContext, 'book_blueprint');
  const langNote = isZhLocale(language)
    ? 'Generate titles and summaries in Chinese.'
    : 'Generate titles and summaries in English.';
  const targetWords = Number(novelContext.targetWords) || 80_000;
  const chapterCount = getTargetChapterCount(targetWords);

  const template = tryResolveTemplate('book_blueprint', 'user', language, variant);
  const prompt = renderTemplate(template, {
    title: novelContext.title ?? '',
    genre: novelContext.genre ?? '',
    targetWords,
    storySummary: novelContext.storySummary ?? '',
    characterSummary: novelContext.characterSummary ?? '',
    arcSummary: novelContext.arcSummary ?? '',
    langNote,
    chapterCount,
  });

  const result = await generateStructuredObject({
    model,
    schema: BookBlueprintSchema,
    // Blueprint is a planning/outline operation → conservative preset (0.5),
    // not the provider default. See generation-presets.OPERATION_DEFAULT_CREATIVITY.
    operation: 'outline',
    system: systemPrompt,
    prompt,
    // Cap output explicitly so a runaway outline can't blow the window, and so
    // the Anthropic provider doesn't silently cap this at its 4096 default.
    maxOutputTokens: OUTPUT_TOKEN_CEILING,
    abortSignal: signal,
  });

  const chapters = result.object.chapters;
  return {
    chapters: chapters.map((chapter, index) => ({
      chapterNumber: chapter.chapterNumber || index + 1,
      title: chapter.title || `Chapter ${index + 1}`,
      summary: chapter.summary || '',
    })),
    usage: result.usage,
  };
}

// ── streamChapter ──────────────────────────────────────────────────────────

export interface StreamChapterArgs {
  model: LanguageModel;
  novelContext: {
    title?: string;
    genre?: string;
    storySummary?: string;
    characterSummary?: string;
    arcSummary?: string;
    targetWords?: number;
    /** W3-2: when the full novel record is passed, its variant selection is read from here. */
    settings?: NovelSettings | null;
  };
  blueprint: ChapterBlueprint;
  language?: Locale;
  signal?: AbortSignal;
  targetWordsPerChapter?: number;
  onFinish?: OnFinish;
  /**
   * Surfaces an in-stream provider error. The AI SDK drops the error part from
   * `textStream` (it never throws to the consumer) and skips `onFinish` when no
   * step completed, so callers relying on a zero-delta `finalText` promise must
   * settle it here or they deadlock waiting on a promise that never resolves.
   */
  onError?: (event: { error: unknown }) => void;
  systemPrompt?: string;
  recentChapterTails?: string;
  earlierChapterDigest?: string;
  /**
   * Optional creativity preset (temperature/topP/penalties/seed). When omitted
   * `streamText` falls back to the model's defaults — callers passing in a
   * preset should resolve it via {@link resolvePreset} from the route so the
   * `x-im-creativity` header drives the actual sampling parameters.
   */
  preset?: GenerationPreset;
  /** W3-2: per-novel prompt variant (falls back to novelContext.settings, then 'default'). */
  promptVariant?: string;
}

export function streamChapter(args: StreamChapterArgs) {
  const {
    model,
    novelContext,
    blueprint,
    language = 'en',
    signal,
    targetWordsPerChapter,
    onFinish,
    onError,
    systemPrompt,
    recentChapterTails,
    earlierChapterDigest,
    preset,
    promptVariant,
  } = args;
  const variant = pickVariant(promptVariant, novelContext, 'chapter_write');

  // `?? ` would let a 0 through (0 ?? x === 0); a projected blueprint can carry
  // targetWordsPerChapter === 0, which must fall back to the floored default
  // rather than telling the model to "aim for ~0 words".
  const targetWords = targetWordsPerChapter && targetWordsPerChapter > 0
    ? targetWordsPerChapter
    : getTargetWordsPerChapter(Number(novelContext.targetWords) || 80_000);
  const langNote = isZhLocale(language)
    ? `用中文写作，文风流畅自然，适合中文读者。本章目标约 ${targetWords} 字。`
    : `Write in English with a fluid, engaging literary style. Aim for approximately ${targetWords} words in this chapter.`;

  const memorySections: string[] = [];
  if (earlierChapterDigest && earlierChapterDigest.trim()) {
    memorySections.push(
      isZhLocale(language)
        ? `更早章节的摘要（按时间顺序）：\n${earlierChapterDigest.trim()}`
        : `Digest of earlier chapters (chronological):\n${earlierChapterDigest.trim()}`,
    );
  }
  if (recentChapterTails && recentChapterTails.trim()) {
    memorySections.push(
      isZhLocale(language)
        ? `最近章节的实际原文片段（请保持语气/视角/事实一致）：\n${recentChapterTails.trim()}`
        : `Actual prose tails from the most recent chapters (maintain voice/POV/facts):\n${recentChapterTails.trim()}`,
    );
  }
  if (memorySections.length === 0) {
    memorySections.push(
      isZhLocale(language) ? '这是开篇章节。' : 'This is the opening chapter.',
    );
  }

  const sysTemplate = tryResolveTemplate('chapter_write', 'system', language, variant);
  const baseSystem = systemPrompt && systemPrompt.trim().length > 0 ? systemPrompt : sysTemplate;

  const userTemplate = tryResolveTemplate('chapter_write', 'user', language, variant);
  const prompt = renderTemplate(userTemplate, {
    chapterNumber: blueprint.chapterNumber,
    title: blueprint.title,
    novelTitle: novelContext.title ?? '',
    genre: novelContext.genre ?? '',
    storySummary: novelContext.storySummary ?? '',
    characterSummary: novelContext.characterSummary ?? '',
    blueprintSummary: blueprint.summary,
    memorySections: memorySections.join('\n\n'),
    langNote,
  });

  // Default kept at 0.85 to match the previous hard-coded value so callers
  // that don't pass a preset see identical behaviour. New routes pass
  // `preset` resolved from the `x-im-creativity` header.
  return streamText({
    model,
    system: baseSystem,
    prompt,
    temperature: 0.85,
    ...(preset ?? {}),
    // Explicit cap derived from the chapter target — without it the Anthropic
    // provider defaults to 4096 and truncates long chapters mid-sentence.
    maxOutputTokens: maxOutputTokensForWords(targetWords),
    abortSignal: signal,
    // Forward finishReason so the caller can detect a 'length' cap-truncation
    // (chapter cut off mid-scene under the output ceiling) and force a
    // continuation pass — a cut-off chapter can clear the length floor yet
    // still end mid-sentence.
    onFinish: onFinish ? ({ text, usage, finishReason }) => onFinish({ text, usage, finishReason }) : undefined,
    onError,
  });
}

// ── streamChapterContinuation ──────────────────────────────────────────────

export interface ContinueChapterArgs {
  model: LanguageModel;
  novelContext: { title?: string; genre?: string; settings?: NovelSettings | null };
  blueprint: ChapterBlueprint;
  existingContent: string;
  targetExtraWords: number;
  language?: Locale;
  signal?: AbortSignal;
  systemPrompt?: string;
  onFinish?: OnFinish;
  /** Same contract as `streamChapter.onError`. */
  onError?: (event: { error: unknown }) => void;
  /** Same contract as `streamChapter.preset`. */
  preset?: GenerationPreset;
  /** Same contract as `streamChapter.promptVariant`. */
  promptVariant?: string;
}

export function streamChapterContinuation(args: ContinueChapterArgs) {
  const {
    model,
    novelContext,
    blueprint,
    existingContent,
    targetExtraWords,
    language = 'en',
    signal,
    systemPrompt,
    onFinish,
    onError,
    preset,
    promptVariant,
  } = args;
  const variant = pickVariant(promptVariant, novelContext, 'chapter_write');
  const langNote = isZhLocale(language)
    ? `用中文继续写，自然衔接已有结尾，预计再写 ${targetExtraWords} 字。`
    : `Continue in English, picking up seamlessly from the existing ending; aim for about ${targetExtraWords} more words.`;

  const sysTemplate = tryResolveTemplate('chapter_write', 'system', language, variant);
  const baseSystem = systemPrompt && systemPrompt.trim().length > 0 ? systemPrompt : sysTemplate;

  // The continuation user prompt has its own stage, so a variant pack can tune
  // it independently of the chapter_write body.
  const continuationVariant = pickVariant(promptVariant, novelContext, 'chapter_continuation');

  // Only the tail of the draft matters for a seamless "continue from here" —
  // feeding the whole growing chapter back each pass is O(n²) tokens and
  // pushes the seam into the lost-in-the-middle zone. The blueprint summary
  // (passed separately) carries the plot beat the continuation must cover.
  const contentTail =
    existingContent.length > CONTINUATION_CONTEXT_TAIL_CHARS
      ? existingContent.slice(-CONTINUATION_CONTEXT_TAIL_CHARS)
      : existingContent;

  const template = tryResolveTemplate('chapter_continuation', 'user', language, continuationVariant);
  const prompt = renderTemplate(template, {
    chapterNumber: blueprint.chapterNumber,
    title: blueprint.title,
    novelTitle: novelContext.title ?? '',
    genre: novelContext.genre ?? '',
    blueprintSummary: blueprint.summary,
    existingContent: contentTail,
    langNote,
  });

  return streamText({
    model,
    system: baseSystem,
    prompt,
    temperature: 0.8,
    ...(preset ?? {}),
    // Cap derived from the remaining word target so the continuation isn't
    // itself truncated at the provider's 4096 default.
    maxOutputTokens: maxOutputTokensForWords(targetExtraWords),
    abortSignal: signal,
    onFinish: onFinish ? ({ text, usage, finishReason }) => onFinish({ text, usage, finishReason }) : undefined,
    onError,
  });
}
