// Real-generation probe for provider/custom connection setup.
//
// Reuses production model resolution (`resolveModelForRole`) so requestCompat
// and transport wiring match live writing paths. Returns only a generic ok or a
// user-safe failure category — never prompts, outputs, secrets, or HTTP detail.
// Callers must not persist probe artifacts; this module never logs request body
// content.

import { generateText } from 'ai';

import { classifyAIError } from '@/lib/ai-error';
import { requestAllowsUserRuntime } from '@/lib/ai-providers';
import type { Translations } from '@/lib/i18n';
import { resolveModelForRole } from './server-resolve';
import type { RuntimeConnectionKind, RuntimeTransport } from './types';

/** Synthetic probe prompt — never persisted or logged. */
const PROBE_PROMPT = 'Reply with OK.';
const PROBE_TIMEOUT_MS = 20_000;

export type GenerationProbeFailureCategory =
  | 'forbidden'
  | 'invalid-credentials'
  | 'plan-restricted'
  | 'unreachable'
  | 'empty-generation'
  | 'generation-failed';

const GENERATION_PROBE_FAILURE_CATEGORIES = [
  'forbidden',
  'invalid-credentials',
  'plan-restricted',
  'unreachable',
  'empty-generation',
  'generation-failed',
] as const satisfies readonly GenerationProbeFailureCategory[];

export function isGenerationProbeFailureCategory(
  value: unknown,
): value is GenerationProbeFailureCategory {
  return typeof value === 'string'
    && (GENERATION_PROBE_FAILURE_CATEGORIES as readonly string[]).includes(value);
}

export type GenerationProbeResult =
  | { ok: true }
  | { ok: false; category: GenerationProbeFailureCategory };

export interface GenerationProbeInput {
  kind: RuntimeConnectionKind;
  transport: RuntimeTransport;
  baseUrl: string;
  modelId: string;
  secret?: string | null;
}

/**
 * Classify a thrown probe error into a user-safe category. Never surfaces
 * status codes, temperature, or raw provider text to the UI.
 */
export function categorizeGenerationProbeFailure(error: unknown): GenerationProbeFailureCategory {
  const text = errorSearchText(error);
  // HighSpeed / plan gates commonly return 401/403 with entitlement wording.
  // Prefer plan-restricted over a generic invalid-credentials so the UI can
  // tell the user to upgrade rather than re-paste a key.
  if (/\b(allegretto|entitlement|membership|upgrade|highspeed|not allowed|plan)\b/.test(text)) {
    return 'plan-restricted';
  }

  const classified = classifyAIError(error);
  if (classified.category === 'invalid_credentials') return 'invalid-credentials';
  if (classified.category === 'quota_or_balance') return 'plan-restricted';
  if (classified.category === 'network') return 'unreachable';

  const status = classified.status;
  if (status === 404 || status === 502 || status === 503 || status === 504) {
    return 'unreachable';
  }
  return 'generation-failed';
}

function errorSearchText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value == null || seen.has(value)) return;
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['name', 'message', 'code', 'type', 'responseBody']) {
      visit(record[key], depth + 1);
    }
    visit(record.cause, depth + 1);
    visit(record.response, depth + 1);
    visit(record.error, depth + 1);
  };
  visit(error, 0);
  return parts.join(' ').toLowerCase();
}

/** Localized product copy for a probe failure — never raw backend text. */
export function generationProbeFailureMessage(
  category: GenerationProbeFailureCategory,
  t: Translations,
): string {
  switch (category) {
    case 'forbidden':
      return t.modelManagerProbeForbidden;
    case 'invalid-credentials':
      return t.modelManagerProbeInvalidCredentials;
    case 'plan-restricted':
      return t.modelManagerProbePlanRestricted;
    case 'unreachable':
      return t.runtimeHealthUnreachable;
    case 'empty-generation':
      return t.modelManagerProbeEmptyGeneration;
    default:
      return t.modelManagerProbeGenerationFailed;
  }
}

/**
 * Run a minimal real generation against the supplied endpoint. Honors the
 * shared localhost gate on `req` — non-loopback callers receive `forbidden`.
 */
export async function runGenerationProbe(
  req: Request,
  input: GenerationProbeInput,
): Promise<GenerationProbeResult> {
  if (!requestAllowsUserRuntime(req)) {
    return { ok: false, category: 'forbidden' };
  }

  const modelId = input.modelId.trim();
  const baseUrl = input.baseUrl.trim();
  if (!modelId || !baseUrl) {
    return { ok: false, category: 'generation-failed' };
  }

  const headers = new Headers(req.headers);
  headers.set('x-im-role', 'draft');
  headers.set('x-im-kind', input.kind);
  headers.set('x-im-transport', input.transport);
  headers.set('x-im-base-url', baseUrl);
  headers.set('x-im-model', modelId);
  const secret = typeof input.secret === 'string' ? input.secret.trim() : '';
  if (secret) headers.set('x-im-secret', secret);
  else headers.delete('x-im-secret');

  const probeReq = new Request(req.url, { method: 'POST', headers });

  let resolved;
  try {
    resolved = await resolveModelForRole(probeReq, 'draft');
  } catch (error) {
    return { ok: false, category: categorizeGenerationProbeFailure(error) };
  }
  if (!resolved) {
    return { ok: false, category: 'generation-failed' };
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), PROBE_TIMEOUT_MS);
  try {
    const result = await generateText({
      model: resolved.model,
      prompt: PROBE_PROMPT,
      // HighSpeed may spend the first tokens on reasoning; a budget of 16 can
      // finish before visible text and falsely report an empty generation.
      maxOutputTokens: 64,
      abortSignal: timeoutController.signal,
    });
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) {
      return { ok: false, category: 'empty-generation' };
    }
    return { ok: true };
  } catch (error) {
    if (timeoutController.signal.aborted) {
      return { ok: false, category: 'unreachable' };
    }
    return { ok: false, category: categorizeGenerationProbeFailure(error) };
  } finally {
    clearTimeout(timeout);
  }
}
