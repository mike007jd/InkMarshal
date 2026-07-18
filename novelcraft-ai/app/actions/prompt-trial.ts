'use server';

// Trial-run server actions for the workflow editor (W3-2).
//
//   dryRender — pure, no-LLM render of a template against sample variables.
//     This is the DEFAULT comparison surface: it renders both the `default`
//     variant and a custom variant and lets the UI diff the two prompts. No
//     token is spent.
//
//   runTrial — the explicit "really run the model" escape hatch. The client
//     forwards its capability-binding headers (the same `x-im-*` set every AI
//     fetch carries) as a plain object; we rebuild a loopback Request so
//     `resolveModelForRole` can resolve the bound model, then call generateText
//     once. Reuses the existing model-resolution + provider seam — no second
//     binding system.

import { generateText } from 'ai';
import { getUser } from '@/lib/local-auth';
import { renderTemplate, getPromptTemplate, TemplateNotFoundError } from '@/lib/prompt-template';
import { resolveTemplate } from '@/lib/ai/prompt-runner';
import { resolveModelForRole } from '@/lib/model-supply/server-resolve';
import { OPERATION_ROLE, type OperationKind } from '@/lib/model-supply/types';
import { KNOWN_STAGES, PROMPT_LOCALES, PROMPT_ROLES, type KnownStage } from '@/lib/prompt-pack-io';

type Role = (typeof PROMPT_ROLES)[number];
type Locale = (typeof PROMPT_LOCALES)[number];

const knownStageSet: ReadonlySet<string> = new Set(KNOWN_STAGES);

/**
 * Stage → the AI operation it runs as (drives capability-role resolution).
 * `chapter_ralph_revise` has no dedicated OperationKind; it runs as a rewrite,
 * so it maps to `polish` (the rewrite-role operation).
 */
const STAGE_OPERATION: Record<KnownStage, OperationKind> = {
  greenlight_pack: 'outline',
  book_blueprint: 'outline',
  chapter_write: 'chapter',
  chapter_continuation: 'chapter',
  chapter_summarize: 'summarize',
  chapter_validate: 'validate',
  unification: 'unify',
  chapter_edit: 'polish',
  interview_system: 'chat',
  chapter_ralph_revise: 'polish',
};

async function requireUser(): Promise<void> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
}

function assertStage(stage: string): asserts stage is KnownStage {
  if (!knownStageSet.has(stage)) throw new Error(`Unknown stage: ${stage}`);
}

export interface DryRenderResult {
  /** Rendered prompt for the default variant (null when default has no row). */
  defaultText: string | null;
  /** Rendered prompt for the requested variant. */
  variantText: string;
  /** Variables referenced in the template but missing from sampleVars. */
  missingVars: string[];
}

/**
 * Render a custom variant and the default side by side against sample vars.
 * Pure — no model call. The renderer fills `{{var}}` from sampleVars; an empty
 * value renders as the empty string (we surface the missing keys separately
 * rather than throwing, so the editor can preview an incomplete form).
 */
export async function dryRender(input: {
  stage: string;
  role: string;
  locale?: string;
  variant: string;
  sampleVars: Record<string, string>;
}): Promise<DryRenderResult> {
  await requireUser();
  const { stage, role, variant } = input;
  assertStage(stage);
  if (!(PROMPT_ROLES as readonly string[]).includes(role)) throw new Error('Invalid role');
  const locale = (input.locale ?? 'en') as Locale;
  if (!(PROMPT_LOCALES as readonly string[]).includes(locale)) throw new Error('Invalid locale');

  const vars = input.sampleVars ?? {};

  // Variant text (fall back through resolveTemplate's catch to default if the
  // variant has no row, so a half-cloned variant still previews).
  const variantTemplate = resolveTemplate(stage, role as Role, locale, '', variant);
  const { rendered: variantText, missing } = renderForgiving(variantTemplate, vars);

  // Default text for the diff (may be absent if the seed was wiped).
  let defaultText: string | null = null;
  try {
    const def = getPromptTemplate({ stage, role: role as Role, locale, variant: 'default' });
    defaultText = renderForgiving(def.templateText, vars).rendered;
  } catch (e) {
    if (!(e instanceof TemplateNotFoundError)) throw e;
  }

  return { defaultText, variantText, missingVars: missing };
}

/** Like renderTemplate but records missing vars instead of throwing. */
function renderForgiving(
  template: string,
  vars: Record<string, unknown>,
): { rendered: string; missing: string[] } {
  const missing = new Set<string>();
  const rendered = template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, name: string) => {
    const value = name.split('.').reduce<unknown>((acc, key) => {
      if (acc === null || acc === undefined) return undefined;
      return (acc as Record<string, unknown>)[key];
    }, vars);
    if (value === undefined || value === null || value === '') {
      missing.add(name);
      return typeof value === 'string' ? value : '';
    }
    return String(value);
  });
  return { rendered, missing: Array.from(missing) };
}

export interface RunTrialResult {
  ok: boolean;
  /** Model output text (on success). */
  text?: string;
  /** Human-readable error (on failure — e.g. no model bound). */
  error?: string;
  /** Rendered prompt actually sent (for transparency in the UI). */
  prompt?: string;
  modelName?: string;
}

/**
 * Really run the model against a rendered variant prompt. The client passes the
 * `x-im-*` capability headers (built by lib/streaming-client's
 * buildModelHeaders for this stage's operation); we reconstruct a loopback
 * Request to drive the existing resolveModelForRole seam.
 *
 * Returns a structured `{ ok, error }` instead of throwing for the common
 * "no model bound" case so the UI can show a calm hint rather than a crash.
 */
export async function runTrial(input: {
  stage: string;
  role: string;
  locale?: string;
  variant: string;
  sampleVars: Record<string, string>;
  /** The `x-im-*` headers the client built for this stage's operation. */
  modelHeaders: Record<string, string>;
}): Promise<RunTrialResult> {
  await requireUser();
  const { stage, role, variant, modelHeaders } = input;
  assertStage(stage);
  if (!(PROMPT_ROLES as readonly string[]).includes(role)) throw new Error('Invalid role');
  const locale = (input.locale ?? 'en') as Locale;
  if (!(PROMPT_LOCALES as readonly string[]).includes(locale)) throw new Error('Invalid locale');

  const template = resolveTemplate(stage, role as Role, locale, '', variant);
  const { rendered: prompt } = renderForgiving(template, input.sampleVars ?? {});
  if (!prompt.trim()) {
    return { ok: false, error: 'The rendered prompt is empty — fill the variables first.' };
  }

  // Rebuild a loopback Request carrying the forwarded capability headers so the
  // shared resolver (which only honors local runtimes) can resolve the model.
  const headers = new Headers();
  for (const [k, v] of Object.entries(modelHeaders ?? {})) {
    if (typeof v === 'string') headers.set(k, v);
  }
  const syntheticReq = new Request('http://127.0.0.1/internal/prompt-trial', { headers });

  const operation = STAGE_OPERATION[stage];
  const capabilityRole = OPERATION_ROLE[operation];

  let resolved;
  try {
    resolved = await resolveModelForRole(syntheticReq, capabilityRole);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Model resolution failed' };
  }
  if (!resolved) {
    return {
      ok: false,
      error: `No model is bound for the "${capabilityRole}" role. Bind one in the Model binding tab.`,
    };
  }

  try {
    const result = await generateText({
      model: resolved.model,
      prompt,
      // Keep trials cheap and bounded — this is a preview, not a full chapter.
      maxOutputTokens: 600,
      temperature: 0.7,
    });
    return {
      ok: true,
      text: result.text,
      prompt,
      modelName: resolved.runtimeModel?.name,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Trial run failed', prompt };
  }
}
