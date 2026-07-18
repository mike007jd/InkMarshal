import { generateText, Output, type LanguageModel, type ModelMessage } from 'ai';
import type { z } from 'zod';
import type { OperationKind } from '@/lib/model-supply/types';
import { resolvePreset, type CreativityLevel } from '@/lib/ai/generation-presets';

export interface GenerateStructuredObjectArgs<T> {
  model: LanguageModel;
  schema: z.ZodType<T>;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  /**
   * The writing operation this structured call belongs to. When set (and
   * `temperature` is not explicitly provided), the sampling temperature
   * defaults to the operation's creativity preset — so summarize/validate/
   * unify/outline resolve to `conservative` (0.5) instead of silently running
   * at the provider default (~1.0). Pass `creativity` to honour a per-request
   * override; otherwise the operation default applies.
   */
  operation?: OperationKind;
  /** Optional creativity override (e.g. parsed from the `x-im-creativity` header). */
  creativity?: CreativityLevel | null;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

export async function generateStructuredObject<T>(
  args: GenerateStructuredObjectArgs<T>,
) {
  const { model, schema, system, prompt, messages, operation, creativity, temperature, maxOutputTokens, abortSignal } = args;
  // Explicit `temperature` always wins; otherwise fall back to the operation's
  // creativity preset so structured QC/summary calls don't run at the provider
  // default. Only when neither is supplied do we leave it undefined.
  const resolvedTemperature =
    temperature ?? (operation ? resolvePreset(operation, creativity).temperature : undefined);
  const common = {
    model,
    system,
    temperature: resolvedTemperature,
    maxOutputTokens,
    abortSignal,
    output: Output.object({ schema }),
  };

  const result = messages
    ? await generateText({ ...common, messages })
    : await generateText({ ...common, prompt: prompt ?? '' });

  return {
    object: result.output,
    usage: result.usage,
  };
}
