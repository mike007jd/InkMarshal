// Price resolution for the local cost panel. Looks up a per-million-token price
// for a (providerId, modelId) pair from the curated model metadata — the SAME
// freshness-tracked records the model manager uses (PROVIDER_PRESETS for BYOK,
// MODEL_CATALOG for local). No separate price table: prices live on the model
// metadata so they inherit `lastVerifiedAt` / source-URL discipline.
//
// CRITICAL: a missing price returns `null`, which the panel renders as
// "unknown" — never as 0. An expensive cloud model with no price on file must
// not look free, or it skews the per-kWord cost comparison the whole panel
// exists to provide. (estimateCostUsd applies the same rule.)

import { MODEL_CATALOG } from '@/lib/model-supply/catalog';
import { PROVIDER_PRESETS } from '@/lib/providers';
import type { ModelTokenPricing } from '@/lib/model-supply/types';

/**
 * Resolve the price for a model.
 *
 * `providerId` on a run is the runtime TRANSPORT (openai-compatible / anthropic
 * / ollama-native), not a BYOK provider id, so the lookup is keyed primarily on
 * `modelId` — which is globally specific enough across the curated records. We
 * scan BYOK provider presets first (where cloud prices live), then the local
 * catalog. A model id may appear under multiple provider presets (e.g. a raw
 * `claude-*` id and an `anthropic/claude-*` OpenRouter alias); the first
 * source-priced hit wins.
 *
 * Returns `null` when no curated price exists — the caller MUST treat that as
 * "unknown", not free.
 */
export function resolvePricing(
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): ModelTokenPricing | null {
  if (!modelId) return null;

  // BYOK provider presets — match by model id across every preset's metadata.
  for (const preset of PROVIDER_PRESETS) {
    const meta = preset.modelMetadata[modelId];
    if (meta?.pricing) return meta.pricing;
  }

  // Curated local catalog — match by catalog id or any known runtime alias
  // (ollama tag / GGUF repo / MLX repo), mirroring contextWindowForModel.
  const entry = MODEL_CATALOG.find(candidate =>
    candidate.id === modelId ||
    candidate.ollamaName === modelId ||
    candidate.gguf?.repo === modelId ||
    candidate.mlx?.repo === modelId,
  );
  if (entry?.pricing) return entry.pricing;

  return null;
}
