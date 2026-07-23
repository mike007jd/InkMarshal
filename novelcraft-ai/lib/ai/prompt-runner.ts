// Shared helpers for resolving prompt templates inside the ai/* modules.
//
// The seeded `prompt_templates` table is the single prompt truth.
// getPromptTemplate resolves the requested variant across the locale chain,
// then repeats that chain for `default`; only a missing default fails closed.

import type { Locale } from '@/lib/i18n';
import type { NovelSettings } from '@/lib/db-types';
import {
  getPromptTemplate,
  type PromptRole,
} from '@/lib/prompt-template';

export function resolveTemplate(
  stage: string,
  role: PromptRole,
  locale: Locale,
  variant?: string,
): string {
  return getPromptTemplate({ stage, role, locale, variant }).templateText;
}

/**
 * W3-2: pick the prompt variant a generation op should resolve against.
 *
 * Per-novel selection lives in `novels.settings` (a JSON bag, no DDL): a
 * whole-novel `promptVariant` selection plus an optional per-stage override map
 * `promptVariants`. The stage override wins, then the whole-novel selection.
 * During template lookup, a selected variant with no row falls back to the
 * seeded `'default'` variant; `undefined` selects `'default'` directly.
 *
 * Returning the empty string the same as `undefined` prevents a stray `''`
 * from selecting a nonexistent variant.
 */
export function variantForStage(
  settings: NovelSettings | null | undefined,
  stage: string,
): string | undefined {
  if (!settings) return undefined;
  const perStage = settings.promptVariants?.[stage];
  if (typeof perStage === 'string' && perStage.length > 0) return perStage;
  const whole = settings.promptVariant;
  if (typeof whole === 'string' && whole.length > 0) return whole;
  return undefined;
}
