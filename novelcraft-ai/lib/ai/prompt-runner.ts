// Shared helpers for resolving prompt templates inside the ai/* modules.
//
// Each ai/* module owns a hard-coded fallback string so that a wiped or
// missing `prompt_templates` row never blocks generation. `resolveTemplate`
// centralises the lookup-with-fallback so the variation lives in the table,
// not in five copies of the same try/catch.

import type { Locale } from '@/lib/i18n';
import type { NovelSettings } from '@/lib/db-types';
import {
  getPromptTemplate,
  TemplateNotFoundError,
  type PromptRole,
} from '@/lib/prompt-template';

export function resolveTemplate(
  stage: string,
  role: PromptRole,
  locale: Locale,
  fallback: string,
  variant?: string,
): string {
  try {
    return getPromptTemplate({ stage, role, locale, variant }).templateText;
  } catch (e) {
    if (e instanceof TemplateNotFoundError) return fallback;
    throw e;
  }
}

/**
 * W3-2: pick the prompt variant a generation op should resolve against.
 *
 * Per-novel selection lives in `novels.settings` (a JSON bag, no DDL): a
 * whole-novel `promptVariant` default plus an optional per-stage override map
 * `promptVariants`. The stage override wins; otherwise the whole-novel default
 * applies; otherwise `undefined` resolves to the seeded `'default'` variant.
 *
 * Returning the empty string the same as `undefined` keeps a stray `''` written
 * by an older settings blob from selecting a nonexistent variant (which would
 * otherwise force `resolveTemplate` down its TemplateNotFoundError fallback).
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
