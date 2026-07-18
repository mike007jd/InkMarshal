'use client';

// CLIENT module. Bounded Hugging Face hub access backing B.4's "find a GGUF"
// flow (NOT a generic model browser).
//
//   Desktop (Tauri): B.2's Rust `hf_search_models` / `hf_list_gguf_files`
//     (via the B.1 desktop wrappers) — same-process, no CORS, can use a token.
//   Web/non-Tauri: graceful fallback to the public HF API over fetch, mapped
//     into the SAME HfSearchResult[] / HfModelFile[] shapes so callers don't
//     branch on environment.

import {
  hfListGgufFiles,
  hfSearchModels,
  isTauriRuntime,
} from '@/lib/desktop-runtime';
import type { HfModelFile, HfSearchResult } from './types';

const HF_API = 'https://huggingface.co/api';
const HF_SEARCH_MAX_LIMIT = 50;
const HF_SEARCH_MAX_QUERY_LENGTH = 120;

/** Quant hint parsed from a GGUF filename, e.g. `...Q4_K_M.gguf` → `Q4_K_M`. */
function quantFromFilename(filename: string): string | undefined {
  const m = filename.match(/\.?(Q\d[0-9A-Z_]*|IQ\d[0-9A-Z_]*|F16|F32|BF16)\.gguf$/i);
  return m ? m[1].toUpperCase() : undefined;
}

interface HfApiModel {
  id?: string;
  modelId?: string;
  downloads?: number;
  /** HF returns `tags` as a flat array of strings (language codes, tasks,
   *  libraries, etc.). Used to derive {@link HfSearchResult.languageHint}. */
  tags?: string[];
  /** Some search payloads expose a parsed `library_name` / `pipeline_tag` —
   *  not used for the language hint but documented here for parity. */
  pipeline_tag?: string;
}

function clampHfSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.max(1, Math.min(Math.floor(limit), HF_SEARCH_MAX_LIMIT));
}

/**
 * Best-effort language inference from an HF repo's tags + repo id. Returns
 * `'zh'` when the listing clearly tags Chinese (tag `zh`, name containing
 * `chinese`/`中文`/`qwen`/`yi`/`baichuan` etc.). Never throws.
 *
 * Kept narrow and additive: we ONLY emit `'zh'` (vs the default of leaving
 * the hint undefined) so the UI badge doesn't lie. English is the implicit
 * fallback and not surfaced as a positive signal.
 */
function inferLanguageHint(
  repo: string,
  tags: string[] | undefined,
): 'zh' | undefined {
  const tagSet = new Set((tags ?? []).map(t => t.toLowerCase()));
  // Direct language tag — strongest signal.
  if (tagSet.has('zh') || tagSet.has('chinese') || tagSet.has('zh-cn') || tagSet.has('zh-tw')) {
    return 'zh';
  }
  const lower = repo.toLowerCase();
  // Repo-id heuristics — only the well-known Chinese model families. We're
  // intentionally conservative: a false positive paints a misleading badge.
  if (
    lower.includes('qwen') ||
    lower.includes('chinese') ||
    lower.includes('chatglm') ||
    lower.includes('baichuan') ||
    lower.includes('yi-1.5') ||
    lower.includes('yi-1_5') ||
    lower.includes('deepseek') ||
    lower.includes('internlm')
  ) {
    return 'zh';
  }
  return undefined;
}

interface HfApiTreeEntry {
  type?: string;
  path?: string;
  size?: number;
  lfs?: { size?: number; oid?: string } | null;
}

const MLX_SNAPSHOT_ROOT_SIDECARS = new Set([
  'chat_template.jinja',
  'config.json',
  'generation_config.json',
  'kv_config.json',
  'optiq_metadata.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer.model',
  'tokenizer_config.json',
]);

function isMlxSnapshotFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith('.safetensors') || lower.endsWith('.safetensors.index.json')) {
    return true;
  }
  if (lower.includes('/')) return false;
  return MLX_SNAPSHOT_ROOT_SIDECARS.has(lower);
}

/**
 * Curated-intent repo search. Desktop → Rust; web → public HF API. Returns at
 * most `limit` `{ repo, downloads, format }` hits sorted by the API's relevance.
 */
export async function searchHfModels(
  query: string,
  limit: number,
  format: 'gguf' | 'mlx' = 'gguf',
): Promise<HfSearchResult[]> {
  const trimmed = query.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, HF_SEARCH_MAX_QUERY_LENGTH);
  if (!trimmed) return [];
  const boundedLimit = clampHfSearchLimit(limit);

  if (isTauriRuntime()) {
    return hfSearchModels(trimmed, format, boundedLimit);
  }

  try {
    // `filter=` is the HF model-tag facet; `gguf` / `mlx` are valid tag values
    // (verified live against the public API: `filter=gguf` and `filter=mlx`
    // both return correctly-filtered repos, whereas `library=gguf`/`library=mlx`
    // do NOT filter). Keep `filter=${format}` — it matches the desktop Rust
    // path (`model_manager.rs` `hf_filter_for`) so web and desktop search
    // identically.
    const url = `${HF_API}/models?search=${encodeURIComponent(
      trimmed,
    )}&filter=${format}&limit=${encodeURIComponent(String(boundedLimit))}&sort=downloads&direction=-1`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as HfApiModel[];
    if (!Array.isArray(data)) {
      throw new Error('Unexpected Hugging Face response');
    }
    return data
      .map<HfSearchResult | null>(item => {
        const repo = item.id ?? item.modelId;
        if (!repo) return null;
        const languageHint = inferLanguageHint(repo, item.tags);
        const result: HfSearchResult = { repo, downloads: item.downloads ?? 0, format };
        if (languageHint) result.languageHint = languageHint;
        return result;
      })
      .filter((x): x is HfSearchResult => x !== null)
      .slice(0, boundedLimit);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Hugging Face search failed');
  }
}

/**
 * List the files in a repo (sizes/quant). Desktop → Rust; web → the repo
 * tree endpoint. `format` controls inclusion predicate: `gguf` keeps `*.gguf`;
 * `mlx` keeps the current MLX snapshot sidecars, tokenizer assets and model
 * weights. Current Qwen/MLX repos include auxiliary JSON sidecars such as
 * kv_config.json and optiq_metadata.json, plus chat_template.jinja.
 */
export async function listHfGgufFiles(
  repoId: string,
  format: 'gguf' | 'mlx' = 'gguf',
): Promise<HfModelFile[]> {
  const repo = repoId.trim();
  if (!repo) return [];

  if (isTauriRuntime()) {
    return hfListGgufFiles(repo, format);
  }

  try {
    const encodedRepo = repo.split('/').map(encodeURIComponent).join('/');
    const url = `${HF_API}/models/${encodedRepo}/tree/main?recursive=true`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as HfApiTreeEntry[];
    if (!Array.isArray(data)) {
      throw new Error('Unexpected Hugging Face response');
    }
    const filtered = data.filter(entry => {
      if (entry.type !== 'file' || typeof entry.path !== 'string') return false;
      const lower = entry.path.toLowerCase();
      if (format === 'mlx') {
        return isMlxSnapshotFile(entry.path);
      }
      return lower.endsWith('.gguf');
    });
    return filtered.map<HfModelFile>(entry => {
      const filename = entry.path as string;
      const sizeBytes = entry.lfs?.size ?? entry.size ?? 0;
      const file: HfModelFile = { repo, filename, sizeBytes, format };
      if (format === 'gguf') {
        const quant = quantFromFilename(filename);
        if (quant) file.quant = quant;
      }
      if (entry.lfs?.oid) file.sha256 = entry.lfs.oid;
      return file;
    });
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Hugging Face file listing failed');
  }
}
