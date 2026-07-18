// Curated local-model catalog (spec §2: "curated local model discovery and
// download. It should NOT expose the full Hugging Face catalog as an
// unfiltered model search surface"). This is a hand-picked, real, modest list
// — NOT an HF search dump (spec Non-Goals).
//
// Each entry gains roleFit, an Ollama tag when verified, a GGUF repo (only
// where a well-known public GGUF exists - omitted rather than guessed), an MLX
// repo only when the bundled MLX engine is verified to load that architecture,
// and a rough minRamGb.

import type { CapabilityRole, CuratedModelEntry } from './types';

export const MODEL_CATALOG_LAST_VERIFIED_AT = '2026-07-03';
const MODEL_CATALOG_STALE_AFTER_DAYS = 45;

const HF_QWEN_ORG = 'https://huggingface.co/Qwen';
const HF_UNSLOTH_ORG = 'https://huggingface.co/unsloth';

export const MODEL_CATALOG: CuratedModelEntry[] = [
  {
    id: 'qwen-3-5-4b',
    name: 'Qwen3.5 4B',
    lifecycle: 'recommended',
    role: ['draft', 'recall'],
    category: 'Fast draft model',
    ollamaName: 'qwen3.5:4b',
    gguf: {
      repo: 'unsloth/Qwen3.5-4B-GGUF',
      recommendedQuant: 'Q4_K_M',
    },
    lastVerifiedAt: MODEL_CATALOG_LAST_VERIFIED_AT,
    sourceUrls: [
      `${HF_QWEN_ORG}/Qwen3.5-4B`,
      `${HF_UNSLOTH_ORG}/Qwen3.5-4B-GGUF`,
      'https://registry.ollama.com/library/qwen3.5',
      'https://huggingface.co/docs/transformers/model_doc/qwen3_5',
    ],
    minRamGb: 6,
    sizeHint: '~2.7 GB',
    contextLengthTokens: 262_144,
    languages: ['zh', 'en', 'multi'],
    prosePreset: 'general',
    paramsB: 4,
  },
  {
    id: 'qwen-3-5-9b',
    name: 'Qwen3.5 9B',
    lifecycle: 'recommended',
    role: ['draft', 'rewrite', 'planning'],
    category: 'Rewrite/editor model',
    ollamaName: 'qwen3.5:9b',
    gguf: {
      repo: 'unsloth/Qwen3.5-9B-GGUF',
      recommendedQuant: 'Q4_K_M',
    },
    lastVerifiedAt: MODEL_CATALOG_LAST_VERIFIED_AT,
    sourceUrls: [
      `${HF_QWEN_ORG}/Qwen3.5-9B`,
      `${HF_UNSLOTH_ORG}/Qwen3.5-9B-GGUF`,
      'https://registry.ollama.com/library/qwen3.5',
      'https://huggingface.co/docs/transformers/model_doc/qwen3_5',
    ],
    minRamGb: 10,
    sizeHint: '~5.7 GB',
    contextLengthTokens: 262_144,
    languages: ['zh', 'en', 'multi'],
    prosePreset: 'general',
    paramsB: 9,
  },
  {
    id: 'qwen-3-6-27b',
    name: 'Qwen3.6 27B',
    lifecycle: 'recommended',
    role: ['planning', 'rewrite'],
    category: 'Planning and long-context writing',
    gguf: {
      repo: 'unsloth/Qwen3.6-27B-GGUF',
      recommendedQuant: 'Q4_K_M',
    },
    lastVerifiedAt: MODEL_CATALOG_LAST_VERIFIED_AT,
    sourceUrls: [
      `${HF_QWEN_ORG}/Qwen3.6-27B`,
      `${HF_UNSLOTH_ORG}/Qwen3.6-27B-GGUF`,
      'https://huggingface.co/docs/transformers/model_doc/qwen3_6',
    ],
    minRamGb: 24,
    sizeHint: '~16.8 GB',
    contextLengthTokens: 262_144,
    languages: ['zh', 'en', 'multi'],
    prosePreset: 'general',
    paramsB: 27,
  },
  {
    id: 'nomic-embed-text',
    name: 'Nomic Embed Text',
    lifecycle: 'current',
    role: 'recall',
    category: 'Embedding model',
    ollamaName: 'nomic-embed-text',
    lastVerifiedAt: MODEL_CATALOG_LAST_VERIFIED_AT,
    sourceUrls: [
      'https://ollama.com/library/nomic-embed-text',
      'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5',
    ],
    lifecycleNote: 'Current local embedding default; not a chat/writing starter model.',
    minRamGb: 2,
    sizeHint: '~274 MB',
    contextLengthTokens: 8192,
    languages: ['multi'],
    paramsB: 0.137,
  },
];

export function isCatalogEntryStale(
  entry: Pick<CuratedModelEntry, 'lastVerifiedAt'>,
  now: Date = new Date(),
): boolean {
  const verified = Date.parse(`${entry.lastVerifiedAt}T00:00:00.000Z`);
  if (!Number.isFinite(verified)) return true;
  const ageDays = (now.getTime() - verified) / 86_400_000;
  return ageDays > MODEL_CATALOG_STALE_AFTER_DAYS;
}

/** Catalog entries whose roleFit includes the given role. */
export function catalogForRole(role: CapabilityRole): CuratedModelEntry[] {
  return MODEL_CATALOG.filter(entry =>
    Array.isArray(entry.role) ? entry.role.includes(role) : entry.role === role,
  );
}

export type EnginePlatform = 'macos' | 'windows';

/** Recommended starter shelf, filtered to what the platform's bundled engine
 * can run. Windows: GGUF-capable entries only. macOS: all (GGUF and/or MLX). */
export function recommendedForPlatform(p: EnginePlatform): CuratedModelEntry[] {
  return MODEL_CATALOG.filter(e =>
    e.lifecycle === 'recommended' &&
    (p === 'windows' ? Boolean(e.gguf) : Boolean(e.gguf || e.mlx)),
  );
}
