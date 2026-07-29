import {
  generateText,
  jsonSchema,
  Output,
  type LanguageModel,
  type ModelMessage,
  type Schema,
} from 'ai';
import { z } from 'zod';
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

/**
 * llama.cpp compiles response_format JSON Schema into a grammar. Large
 * maxLength/maxItems values become huge bounded repetitions and can exceed its
 * grammar safety limit, causing a silent fallback to unconstrained freeform.
 *
 * Strip only those wire hints for every structured operation. The original Zod
 * schema remains the authoritative validator, so persisted/output business
 * bounds are unchanged for hosted providers and local engines alike.
 */
export function grammarSafeStructuredSchema<T>(schema: z.ZodType<T>): Schema<T> {
  const stripWireBounds = <Value>(value: Value): Value => {
    if (Array.isArray(value)) return value.map(stripWireBounds) as Value;
    if (!value || typeof value !== 'object') return value;

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'maxLength' || key === 'maxItems') continue;
      out[key] = stripWireBounds(child);
    }
    return out as Value;
  };

  // Zod and AI SDK both emit draft-07-compatible objects, but their bundled
  // JSONSchema type packages disagree on the legacy boolean form of
  // exclusiveMaximum. Keep the cast isolated at this library boundary.
  const wireSchema = stripWireBounds(
    z.toJSONSchema(schema, { target: 'draft-7' }),
  ) as unknown as Parameters<typeof jsonSchema>[0];

  return jsonSchema<T>(
    wireSchema,
    {
      validate: value => {
        const result = schema.safeParse(value);
        return result.success
          ? { success: true, value: result.data }
          : { success: false, error: result.error };
      },
    },
  );
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
    output: Output.object({ schema: grammarSafeStructuredSchema(schema) }),
  };

  const result = messages
    ? await generateText({ ...common, messages })
    : await generateText({ ...common, prompt: prompt ?? '' });

  return {
    object: result.output,
    usage: result.usage,
  };
}
