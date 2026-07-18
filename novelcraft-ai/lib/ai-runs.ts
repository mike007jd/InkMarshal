// Pure cost/outcome logic for the local AI-usage ledger (ai_runs). No DB, no I/O
// — unit-tested directly in ai-runs.test.ts. The session glue in lib/ai-usage.ts
// calls these to derive the est_cost_usd / outcome columns it writes per call.

import type { ProviderUsage } from '@/lib/ai-usage';
import type { RuntimeConnectionKind } from '@/lib/model-supply/types';

/**
 * Per-million-token prices for a single model, as carried on the curated model
 * metadata (`pricing?`). Currency defaults to USD; the panel surfaces the raw
 * currency when it is not USD rather than silently converting.
 */
export interface ModelPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  currency?: string;
}

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Estimate the BYOK dollar cost of a single call.
 *
 *  - **Local engines cost nothing.** A `connectionKind` of `'local'` always
 *    returns `0` — the user runs the model on their own hardware, so there is no
 *    per-token charge regardless of any (irrelevant) pricing row.
 *  - **No pricing → unknown, NOT free.** When `pricing` is null/undefined for a
 *    non-local call we return `null`. The panel renders this as "未知 / unknown"
 *    rather than `0`, so an expensive cloud model with no price on file never
 *    masquerades as free and skews the per-kWord comparison.
 *  - Otherwise: `input/1e6 * inPrice + output/1e6 * outPrice`. Missing token
 *    counts are treated as 0 (a partial usage payload still yields a partial,
 *    honest estimate rather than null).
 *
 * Returns USD (or the pricing row's own currency unit — the caller stores the
 * scalar; the panel labels the currency). `null` means "unknown".
 */
export function estimateCostUsd(
  usage: ProviderUsage | undefined,
  pricing: ModelPricing | null | undefined,
  connectionKind: RuntimeConnectionKind | null | undefined,
): number | null {
  if (connectionKind === 'local') return 0;
  if (!pricing) return null;

  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const inCost = (inputTokens / TOKENS_PER_MILLION) * pricing.inputPerMTokUsd;
  const outCost = (outputTokens / TOKENS_PER_MILLION) * pricing.outputPerMTokUsd;
  const total = inCost + outCost;
  return Number.isFinite(total) ? total : null;
}

/** The four terminal states a call can land in (matches the ai_runs CHECK). */
export type RunOutcome = 'success' | 'failed' | 'truncated' | 'cancelled';

/**
 * Classify a call's terminal outcome from the signals the session has when it
 * settles. Precedence, most authoritative first:
 *
 *  1. `cancelled` — the user aborted (lifecycle cancel / request abort). Even if
 *     a finishReason arrived, an abort is a cancel, not a success.
 *  2. `error` — the provider/stream threw. `failed`.
 *  3. `finishReason === 'length'` (or `'max_tokens'`) — the model hit the token
 *     ceiling mid-output. `truncated` (distinct from success so the panel can
 *     flag models that routinely run out of room).
 *  4. otherwise — `success` (includes the normal `'stop'` and an absent reason).
 */
export function classifyOutcome(args: {
  finishReason?: string | null;
  cancelled?: boolean;
  error?: boolean;
}): RunOutcome {
  if (args.cancelled) return 'cancelled';
  if (args.error) return 'failed';
  const reason = args.finishReason?.toLowerCase();
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max-tokens') {
    return 'truncated';
  }
  return 'success';
}
