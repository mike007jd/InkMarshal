// Token-budget estimator + context-pressure thresholds.
//
// Pure helpers (no DB / no engine I/O). Used by `buildAIContext` to size the
// memory + knowledge + conversation blocks before they're stuffed into the
// system prompt, and by routes to emit `X-Context-Pressure` headers.
//
// Estimator is intentionally rough — see `estimateTokens` below.

/** Threshold above which a request is treated as `pressure: 'warn'`. */
const PRESSURE_WARN_RATIO = 0.6;
/** Threshold above which a request is treated as `pressure: 'over'`. */
const PRESSURE_OVER_RATIO = 0.9;
/**
 * Fallback ctxTokens when the engine-reported context window is unavailable.
 * 32k (not 8k) because the bundled local engines and modern cloud models all
 * have ≥32k windows; an 8k fallback made editor/chat/outline ops (which often
 * don't thread the real window) classify `warn`/`over` and compress context
 * the actual model could hold, hurting output quality for no reason.
 */
export const FALLBACK_CTX_TOKENS = 32768;

const CJK_CHAR_RE = /[一-鿿㐀-䶿　-〿＀-￯]/g;

// Per-character split (CJK ~1.0 tokens, latin ~0.25 tokens). Rough heuristic,
// not a real tokenizer. The CJK factor was 1.5, which over-estimated Chinese by
// ~50% on modern BPE tokenizers (Llama/Qwen/GPT run ~0.6–1.1 tokens/char) and
// systematically tripped `classifyPressure` into warn/over too early for the
// Chinese-first audience — needlessly compressing context that fit. 1.0 stays
// mildly conservative (never under-budget) while removing the bias.
export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  const cjk = s.match(CJK_CHAR_RE)?.length ?? 0;
  return Math.ceil(cjk * 1.0 + (s.length - cjk) * 0.25);
}

export type ContextPressure = 'ok' | 'warn' | 'over';

export function classifyPressure(estTokens: number, ctxTokens: number): ContextPressure {
  if (!ctxTokens || ctxTokens <= 0) return 'over';
  const ratio = estTokens / ctxTokens;
  if (ratio >= PRESSURE_OVER_RATIO) return 'over';
  if (ratio >= PRESSURE_WARN_RATIO) return 'warn';
  return 'ok';
}

/** Format the `X-Context-Tokens: est/ctx` header value. */
export function formatTokensHeader(estTokens: number, ctxTokens: number): string {
  return `${estTokens}/${ctxTokens}`;
}
