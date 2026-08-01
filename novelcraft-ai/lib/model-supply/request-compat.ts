// Metadata-driven request compatibility. Wraps fetch so openai-compatible
// (and anthropic) bodies pick up ProviderModelMetadata.requestCompat without
// provider-specific conditionals at each generate/stream call site.

import { applyProviderRequestCompatToBody } from '@/lib/providers';

/**
 * Compose fetch wrappers left-to-right (outermost first). A missing wrapper is
 * skipped so callers can optionally layer disableThinking + requestCompat.
 */
export function composeFetch(
  ...wrappers: Array<((base: typeof fetch) => typeof fetch) | undefined | null>
): typeof fetch {
  return wrappers.reduceRight(
    (inner, wrap) => (wrap ? wrap(inner) : inner),
    fetch,
  );
}

/**
 * Rewrite chat-completions JSON bodies according to curated model metadata.
 * No-ops when the (baseUrl, modelId) pair has no requestCompat.
 */
export function requestCompatFetch(
  baseUrl: string,
  modelId: string,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const next = applyProviderRequestCompatToBody(
            baseUrl,
            modelId,
            parsed as Record<string, unknown>,
          );
          if (next !== parsed) {
            init = { ...init, body: JSON.stringify(next) };
          }
        }
      } catch {
        // Non-JSON body — leave untouched.
      }
    }
    return baseFetch(input, init);
  }) as typeof fetch;
}
