import { type LanguageModel } from 'ai';
import { OUTPUT_TOKEN_CEILING } from '@/lib/ai/output-budget';
import {
  GreenlightPackSchema,
  type ChatMessage,
  type GreenlightPack,
  type UsageMeta,
} from '@/lib/ai/types';
import type { Locale } from '@/lib/i18n';
import type { NovelSettings } from '@/lib/db-types';
import { renderTemplate } from '@/lib/prompt-template';
import { resolveTemplate, variantForStage } from '@/lib/ai/prompt-runner';
import { generateStructuredObject } from '@/lib/ai/structured-output';

export interface GenerateGreenlightArgs {
  model: LanguageModel;
  novelContext: {
    title?: string;
    genre?: string;
    storySummary?: string;
    characterSummary?: string;
    arcSummary?: string;
    /** W3-2: when the full novel record is passed, its variant selection is read from here. */
    settings?: NovelSettings | null;
  };
  history: ChatMessage[];
  language?: Locale;
  signal?: AbortSignal;
  /** W3-2: per-novel prompt variant (falls back to novelContext.settings, then 'default'). */
  promptVariant?: string;
}

const FALLBACK_TEMPLATE = `Based on the following conversation between the user and the AI novel producer, generate a comprehensive Writing Plan (Greenlight Pack).

CONVERSATION:
{{conversationText}}

Current novel metadata:
Title: {{title}}
Genre: {{genre}}
Story Direction: {{storySummary}}
Characters: {{characterSummary}}
Arc: {{arcSummary}}

Extract and synthesize all story information from the conversation to produce the greenlight pack.`;


export async function generateGreenlightPack(args: GenerateGreenlightArgs): Promise<{
  pack: GreenlightPack;
  usage?: UsageMeta;
}> {
  const { model, novelContext, history, language = 'en', signal, promptVariant } = args;
  const variant = promptVariant ?? variantForStage(novelContext.settings, 'greenlight_pack');
  const conversationText = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
    .join('\n\n');

  const template = resolveTemplate('greenlight_pack', 'user', language, FALLBACK_TEMPLATE, variant);
  const prompt = renderTemplate(template, {
    conversationText,
    title: novelContext.title ?? '',
    genre: novelContext.genre ?? '',
    storySummary: novelContext.storySummary ?? '',
    characterSummary: novelContext.characterSummary ?? '',
    arcSummary: novelContext.arcSummary ?? '',
  });

  const result = await generateStructuredObject({
    model,
    schema: GreenlightPackSchema,
    // Distilling the interview into a story bible is a planning operation →
    // conservative preset (0.5) rather than the provider default.
    operation: 'outline',
    prompt,
    maxOutputTokens: OUTPUT_TOKEN_CEILING,
    abortSignal: signal,
  });

  return { pack: result.object, usage: result.usage };
}
