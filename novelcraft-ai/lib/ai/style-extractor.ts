// Style notes auto-extraction (wave 4 commit F).
//
// Given a short user-pasted prose sample, ask the recall-bound model to
// distill a compact style profile that the system prompt can later inject as
// "writing style reference". This is INTENTIONALLY a tiny, low-stakes call —
// we use the lightweight recall-class model and tolerate failures by
// returning an empty profile so the user can hand-fill the notes.
//
// The schema is deliberately shallow + bounded:
//   voice            — one-line tonal descriptor ("dry, ironic, plain")
//   sentenceLength   — short label ("short clipped", "long flowing", etc.)
//   vocabularyHints  — 3-8 representative word choices / register cues
//   povTendency      — "first" / "third-limited" / "omniscient" or a phrase
//
// We DO NOT try to capture plot, character, or content — that's the
// knowledge base's job. Style only.

import { type LanguageModel } from 'ai';
import { OUTPUT_TOKEN_CEILING } from '@/lib/ai/output-budget';
import { generateStructuredObject } from '@/lib/ai/structured-output';
import { z } from 'zod';

export const StyleNotesSchema = z.object({
  voice: z.string().max(200).default(''),
  sentenceLength: z.string().max(80).default(''),
  vocabularyHints: z.array(z.string().max(60)).max(8).default([]),
  povTendency: z.string().max(80).default(''),
});

export type StyleNotes = z.infer<typeof StyleNotesSchema>;

export interface StyleNotesExtractionResult {
  notes: StyleNotes;
  ok: boolean;
}

/** Empty/neutral profile — used as the fallback shape on any failure. */
export const EMPTY_STYLE_NOTES: StyleNotes = {
  voice: '',
  sentenceLength: '',
  vocabularyHints: [],
  povTendency: '',
};

export interface ExtractStyleNotesArgs {
  /** User-pasted prose. The longer the better, but we cap inputs to keep the
   *  call snappy and never starve the model with a giant chapter. */
  sampleText: string;
  /** AI SDK language model — typically the `recall` role's bound model. */
  model: LanguageModel;
  /** Optional locale hint. Affects the prompt language so the model produces
   *  notes in the user's language; the JSON schema fields are not localized. */
  locale?: 'en' | 'zh-CN' | 'zh-TW' | string;
  signal?: AbortSignal;
}

const SAMPLE_TEXT_CAP = 4_000;

/**
 * Run the extraction. On success returns the structured profile; on any
 * failure (abort, model error, validation) returns {@link EMPTY_STYLE_NOTES}
 * so the caller can degrade to "user fills the notes manually" without
 * needing a try/catch at every call site.
 *
 * Inputs shorter than ~80 chars are too thin to learn from — we short-circuit
 * to the empty profile rather than burning a model call on a single sentence.
 */
export async function extractStyleNotes(args: ExtractStyleNotesArgs): Promise<StyleNotes> {
  return (await extractStyleNotesResult(args)).notes;
}

export async function extractStyleNotesResult(
  args: ExtractStyleNotesArgs,
): Promise<StyleNotesExtractionResult> {
  const sample = (args.sampleText ?? '').trim();
  if (sample.length < 80) return { notes: { ...EMPTY_STYLE_NOTES }, ok: false };

  const capped = sample.slice(0, SAMPLE_TEXT_CAP);
  const isZh = (args.locale ?? '').startsWith('zh');

  const system = isZh
    ? '你是一位专注于风格学习的文学编辑。阅读用户的写作样本后，提炼写作风格特征。保持客观、具体，不评价好坏，只描述风格。'
    : 'You are a literary editor focused on style analysis. Read the user\'s prose sample and extract their stylistic fingerprint. Be specific and observational — do not judge quality, only describe style.';

  const prompt = isZh
    ? `请从以下样本中提炼出写作风格特征，按下列字段输出：
- voice：一句话描述语气与作者声音（如"克制冷峻、略带反讽"）
- sentenceLength：句长倾向的简短标签（如"短促分行""长句铺陈"）
- vocabularyHints：3-8 个代表性的词汇/用词倾向（短词组）
- povTendency：常用视角（如"第三人称限知""第一人称内省"）

--- 样本 ---
${capped}
--- 样本结束 ---`
    : `Distill the stylistic fingerprint of this sample. Output:
- voice: one-line description of tone and authorial voice
- sentenceLength: a short label for cadence (e.g. "short clipped", "long flowing", "mixed varied")
- vocabularyHints: 3-8 representative word/register cues (short phrases)
- povTendency: typical POV (e.g. "third-person limited", "first-person introspective")

--- SAMPLE ---
${capped}
--- END SAMPLE ---`;

  try {
    const { object } = await generateStructuredObject({
      model: args.model,
      system,
      prompt,
      schema: StyleNotesSchema,
      // Style extraction is a "find the deterministic signal" task — keep
      // temperature low so two runs on the same sample don't disagree
      // wildly. Not exposed via the creativity picker — this is internal.
      temperature: 0.3,
      maxOutputTokens: OUTPUT_TOKEN_CEILING,
      abortSignal: args.signal,
    });
    return { notes: StyleNotesSchema.parse(object), ok: true };
  } catch (err) {
    // Propagate user-initiated cancellation rather than returning an empty
    // stub as if extraction had merely failed.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return { notes: { ...EMPTY_STYLE_NOTES }, ok: false };
  }
}

/**
 * Compose the structured notes into the single-string `styleNotes` field
 * stored on a `style_reference` knowledge entry. Drops empty fields so the
 * stored notes don't carry section headers with no content.
 */
export function formatStyleNotes(notes: StyleNotes, locale?: string): string {
  const isZh = (locale ?? '').startsWith('zh');
  const lines: string[] = [];
  if (notes.voice) lines.push(isZh ? `语气：${notes.voice}` : `Voice: ${notes.voice}`);
  if (notes.sentenceLength) lines.push(isZh ? `句长：${notes.sentenceLength}` : `Sentence length: ${notes.sentenceLength}`);
  if (notes.vocabularyHints.length) {
    lines.push(
      isZh
        ? `用词：${notes.vocabularyHints.join('、')}`
        : `Vocabulary: ${notes.vocabularyHints.join(', ')}`,
    );
  }
  if (notes.povTendency) lines.push(isZh ? `视角：${notes.povTendency}` : `POV: ${notes.povTendency}`);
  return lines.join('\n');
}
