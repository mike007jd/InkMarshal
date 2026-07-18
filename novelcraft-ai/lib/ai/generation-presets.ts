// Creativity presets — central knob for `temperature`/`topP`/penalty values
// emitted to the AI SDK. The intent is to surface a tiny user-visible choice
// (保守/平衡/放飞) per operation rather than scattering numeric literals across
// every generateText/streamText call. Keep this file pure (no imports from
// `ai`, no React) — both server routes and client UI import it.

import type { OperationKind } from '@/lib/model-supply/types';

/** Three-step creativity choice surfaced in the UI. */
export type CreativityLevel = 'conservative' | 'balanced' | 'wild';

/** Ordered list — stable for UI rendering (segmented control left→right). */
export const CREATIVITY_LEVELS: readonly CreativityLevel[] = [
  'conservative',
  'balanced',
  'wild',
] as const;

/**
 * Sampling parameters passed through to AI SDK text and structured-output calls.
 *
 * We deliberately steer on **temperature only**. The AI SDK Core settings docs
 * recommend setting either `temperature` *or* `topP`, not both — sending both
 * is provider-dependent and some local engines (llama-server) apply them in
 * sequence with surprising results. `topP`/penalty fields stay optional on the
 * type so a caller *can* opt in, but the baseline presets don't set them, which
 * also sidesteps the older-llama-server `presence_penalty` 422 entirely (no
 * penalty sent ⇒ nothing to reject).
 */
export interface GenerationPreset {
  temperature: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
}

/**
 * The three baseline presets. Numbers chosen so:
 *  - `conservative` keeps the model on-rails (good for outline/polish/validate
 *    where determinism matters more than spice);
 *  - `balanced` is the all-rounder default for chat + chapter drafting;
 *  - `wild` lets the model explore (variant generation, brainstorming).
 *
 * Only `temperature` is set (see {@link GenerationPreset}). Penalties are off by
 * default; {@link withoutPenalties} remains available for any caller that opts
 * into penalties and then needs to strip them for a penalty-rejecting engine.
 */
export const CREATIVITY_PRESETS: Record<CreativityLevel, GenerationPreset> = {
  conservative: { temperature: 0.5 },
  balanced:     { temperature: 0.75 },
  wild:         { temperature: 0.95 },
};

/**
 * Per-operation default creativity. Picked so the natural state of each route
 * matches the user's likely intent without them touching the picker:
 *
 *  - outline / polish / summarize / validate / unify → conservative (stay on
 *    structure / change as little as possible / produce a deterministic
 *    summary or QC).
 *  - chat / chapter → balanced (typical drafting energy).
 *
 * Routes resolve via {@link resolvePreset} which lets a request-header
 * override pin a non-default level for a single call.
 */
export const OPERATION_DEFAULT_CREATIVITY: Record<OperationKind, CreativityLevel> = {
  chat: 'balanced',
  outline: 'conservative',
  chapter: 'balanced',
  polish: 'conservative',
  summarize: 'conservative',
  validate: 'conservative',
  unify: 'conservative',
};

/** Type-guard helper used by routes parsing the `x-im-creativity` header. */
export function isCreativityLevel(value: unknown): value is CreativityLevel {
  return value === 'conservative' || value === 'balanced' || value === 'wild';
}

/**
 * Read the `x-im-creativity` header off a Request (or any Headers-like)
 * and narrow it to a CreativityLevel. Returns `null` when missing/invalid,
 * which {@link resolvePreset} then maps to the operation default.
 */
export function readCreativityHeader(req: Request | { headers: Headers }): CreativityLevel | null {
  const raw = req.headers.get('x-im-creativity');
  return isCreativityLevel(raw) ? raw : null;
}

/**
 * Resolve a `GenerationPreset` for a given operation, honouring an optional
 * override (typically the value of the `x-im-creativity` header parsed at the
 * route boundary). Falls back to {@link OPERATION_DEFAULT_CREATIVITY}.
 *
 * Returns a fresh object every call — callers may safely add `seed` etc.
 * without mutating the shared {@link CREATIVITY_PRESETS}.
 */
export function resolvePreset(
  op: OperationKind,
  override?: CreativityLevel | null,
): GenerationPreset {
  const level: CreativityLevel = override ?? OPERATION_DEFAULT_CREATIVITY[op];
  return { ...CREATIVITY_PRESETS[level] };
}

/**
 * Strip penalty fields from a preset. Use as a 422-fallback when the runtime
 * engine (older llama-server builds; some openai-compatible proxies) rejects
 * `presence_penalty`/`frequency_penalty`. The numeric core (temperature, topP,
 * seed) is preserved so we don't silently flip the model back to its default
 * temperature when the penalty is what actually fails.
 */
export function withoutPenalties(preset: GenerationPreset): GenerationPreset {
  // Intentionally drop presencePenalty / frequencyPenalty; keep the rest.
  return {
    temperature: preset.temperature,
    topP: preset.topP,
    seed: preset.seed,
  };
}
