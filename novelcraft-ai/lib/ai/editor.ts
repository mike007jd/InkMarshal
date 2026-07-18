import { Output, streamText, type LanguageModel, type ModelMessage } from 'ai';
import { OUTPUT_TOKEN_CEILING } from '@/lib/ai/output-budget';
import { type Locale, isZhLocale } from '@/lib/i18n';
import {
  ChapterEditSchema,
  toModelMessages,
  type ChapterEdit,
  type ChatMessage,
  type OnFinishObject,
  type UsageMeta,
} from '@/lib/ai/types';
import type { GenerationPreset } from '@/lib/ai/generation-presets';
import { renderTemplate } from '@/lib/prompt-template';
import { resolveTemplate as tryResolveTemplate, variantForStage } from '@/lib/ai/prompt-runner';
import type { NovelSettings } from '@/lib/db-types';

// ── buildNovelLanguageSignals ──────────────────────────────────────────────

export function buildNovelLanguageSignals(
  novelContext: Partial<{
    title: string;
    genre: string;
    storySummary: string;
    characterSummary: string;
    arcSummary: string;
  }>,
  history: Array<{ content: string }>,
): string[] {
  return [
    ...history.map(message => message.content),
    novelContext.title,
    novelContext.genre,
    novelContext.storySummary,
    novelContext.characterSummary,
    novelContext.arcSummary,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

// ── streamEdit ─────────────────────────────────────────────────────────────

const EDIT_SYSTEM_FALLBACK = `You are a professional novel editor. The user will give you an editing instruction for a chapter.

Rules:
- Each "original" must be an exact verbatim substring from the chapter text — copy it character-for-character so it can be located by string match.
- Make minimal targeted edits — only change what is necessary.
- If the user selected specific text (marked with <<<SELECTED>>>...<<<END_SELECTED>>>), focus edits on that region.
- "summary" should be 1-2 sentences describing what was changed and why.
{{langNote}}`;

const EDIT_USER_FALLBACK = `Novel: {{novelTitle}} ({{genre}})

Chapter text:
---
{{markedText}}
---

Editing instruction: {{instruction}}`;

export interface StreamEditArgs {
  model: LanguageModel;
  novelContext: { title?: string; genre?: string; settings?: NovelSettings | null };
  chapterText: string;
  instruction: string;
  selectedText?: string;
  chatHistory?: ChatMessage[];
  language?: Locale;
  signal?: AbortSignal;
  onFinish?: OnFinishObject<ChapterEdit>;
  /**
   * Optional pre-built novel system prompt (knowledge + memory) prefixed
   * before streamEdit's own editor system instructions. Routes call
   * `buildAIContext({op: 'edit'})` and pass `result.systemPrompt` here so the
   * editor model sees consistent world/character context.
   */
  novelSystemPrompt?: string;
  /** Sampling preset from the `x-im-creativity` header (defaults to 0.7 when omitted). */
  preset?: GenerationPreset;
  /** W3-2: per-novel prompt variant (falls back to novelContext.settings, then 'default'). */
  promptVariant?: string;
}

export function streamEdit(args: StreamEditArgs) {
  const {
    model,
    novelContext,
    chapterText,
    instruction,
    selectedText,
    chatHistory = [],
    language = 'en',
    signal,
    onFinish,
    novelSystemPrompt,
    preset,
    promptVariant,
  } = args;
  const variant = promptVariant ?? variantForStage(novelContext.settings, 'chapter_edit');

  const langNote = isZhLocale(language)
    ? '请用中文回复，summary字段也用中文。'
    : 'Reply in English.';

  // `String.replace(str, …)` marks only the FIRST occurrence, so if the
  // selection text also appears earlier in the chapter the wrong region gets
  // marked and the edit focuses the wrong text. Only mark when the selection
  // is unambiguous (exactly one occurrence); otherwise fall back to the whole
  // chapter rather than risk steering the editor to the wrong span.
  const firstIdx = selectedText ? chapterText.indexOf(selectedText) : -1;
  const isUnambiguous =
    !!selectedText &&
    firstIdx !== -1 &&
    chapterText.indexOf(selectedText, firstIdx + selectedText.length) === -1;
  const markedText =
    selectedText && isUnambiguous
      ? `${chapterText.slice(0, firstIdx)}<<<SELECTED>>>${selectedText}<<<END_SELECTED>>>${chapterText.slice(firstIdx + selectedText.length)}`
      : chapterText;

  const sysTemplate = tryResolveTemplate('chapter_edit', 'system', language, EDIT_SYSTEM_FALLBACK, variant);
  const editorSystem = renderTemplate(sysTemplate, { langNote });
  const system = novelSystemPrompt
    ? `${novelSystemPrompt}\n\n--- Editor rules ---\n${editorSystem}`
    : editorSystem;

  const userTemplate = tryResolveTemplate('chapter_edit', 'user', language, EDIT_USER_FALLBACK, variant);
  const userMessage = renderTemplate(userTemplate, {
    novelTitle: novelContext.title ?? '',
    genre: novelContext.genre ?? '',
    markedText,
    instruction,
  });

  const messages: ModelMessage[] = [
    ...toModelMessages(chatHistory.slice(-5)),
    { role: 'user', content: userMessage },
  ];

  const result = streamText({
    model,
    output: Output.object({ schema: ChapterEditSchema }),
    system,
    messages,
    temperature: 0.7,
    maxOutputTokens: OUTPUT_TOKEN_CEILING,
    ...(preset ?? {}),
    abortSignal: signal,
  });

  // When onFinish is set, `output` resolves only AFTER onFinish settles, so usage
  // is recorded before the caller sees the final object.
  const finalOutput = onFinish
    ? Promise.all([result.output, result.usage]).then(async ([object, usage]) => {
      await onFinish({ object, usage });
      return object;
    })
    : result.output;
  // Avoid an unhandled rejection on the onFinish chain when the caller consumes
  // partialOutputStream first and awaits output only later.
  if (onFinish) void Promise.resolve(finalOutput).catch(() => undefined);

  // Return an OWN adapter instead of mutating the AI SDK result. The old path
  // rewrote a third-party object's configurable `output` property, binding us to
  // its internals; this exposes a stable surface (partial stream + output +
  // usage) the callers consume without ever touching the raw SDK result object.
  return {
    partialOutputStream: result.partialOutputStream,
    output: finalOutput,
    usage: result.usage,
  };
}

export { toModelMessages };
export type { ChatMessage, UsageMeta };
