const CHAPTER_POST_GENERATION_TIMEOUT_MS = 90_000;

/**
 * Give optional chapter post-processing a firm ceiling without cancelling the
 * parent writing run. Slow/hung summarize, validate, polish, or volume calls
 * may fail independently; the already-saved chapter can then finalize with
 * the existing deterministic fallbacks instead of leaving Writing stuck.
 */
export function postGenerationAbortSignal(
  parent: AbortSignal | undefined,
  timeoutMs = CHAPTER_POST_GENERATION_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
