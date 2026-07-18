// Client-safe leaf so callers transitively imported by the React bundle
// don't drag in `lib/prompt-template` → `lib/db/connection` → better-sqlite3.

const TARGET_WORDS_PER_CHAPTER_FALLBACK = 5_000;

/**
 * Cross-provider-safe output ceiling. The Anthropic provider defaults
 * `maxOutputTokens` to 4096 when unset (vercel/ai #9540), which silently
 * truncates a ~5000-word chapter at roughly half the target. 8192 sits above
 * that default, comfortably covers a 5000-word chapter (~6500–7500 tokens),
 * and is within the documented output limit of every model this app binds
 * (modern Claude 4.x / OpenAI / DeepSeek / local llama.cpp + MLX).
 */
export const OUTPUT_TOKEN_CEILING = 8_192;

/**
 * Derive an explicit `maxOutputTokens` from a target word count so long-form
 * generation isn't capped at a provider default. ~1.6 tokens/word + a 512
 * buffer, clamped to [1024, {@link OUTPUT_TOKEN_CEILING}].
 */
export function maxOutputTokensForWords(words: number): number {
  const safeWords = Number.isFinite(words) && words > 0 ? words : TARGET_WORDS_PER_CHAPTER_FALLBACK;
  const estimate = Math.ceil(safeWords * 1.6) + 512;
  return Math.min(OUTPUT_TOKEN_CEILING, Math.max(1024, estimate));
}
