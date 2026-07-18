// Wave 2 commit C — best-effort embedding pipeline for vault entries.
//
// Embeddings are a fallback step in `recallKnowledgeForChapter`: when the
// structured matchers (title / alias / wikilink 1-hop / timeline chapter) leave
// budget on the table, we cosine-rank by query embedding to surface entries
// nobody mentioned explicitly.
//
// Design notes:
//  - The recall route already runs server-side. Most setups have the embedding
//    endpoint sitting on localhost (the bundled engine when a user picked
//    nomic-embed-text, or LM Studio / Ollama / a custom OpenAI-compat box).
//    Capability bindings live in client localStorage and can't be read here,
//    so callers thread an endpoint hint through `EmbeddingEndpointHint` —
//    typically resolved from request headers (`x-im-recall-base-url`) or, in
//    the queueMicrotask case, from the desktop orchestrator's loopback-only
//    embedding endpoint.
//  - Anything throwing in this module is converted to 'failed' / 'no_model' so
//    the recall pipeline degrades gracefully. The hot path must never crash
//    because a user hasn't installed a tiny embedding model.
//  - Vectors are stored as Float32Array BLOBs in `knowledge_embeddings`. SQLite
//    handles 4 KB / 6 KB blobs (nomic-embed-text is 768 floats × 4 bytes ≈ 3 KB)
//    without issue, and cosine over <500 entries runs in <10ms.

import {
  upsertKnowledgeEmbedding,
  getKnowledgeEmbedding,
  listKnowledgeEmbeddings,
  getKnowledgeEmbeddingStats,
  getKnowledgeIndexById,
} from '@/lib/db/queries-knowledge-vault';
import {
  parseUserRuntimeBaseUrl,
  requestAllowsUserRuntime,
  runtimeBaseUrlCanCarrySecret,
} from '@/lib/ai-providers';
import { isLoopbackHost } from '@/lib/loopback-hosts';

export interface EmbeddingEndpointHint {
  /** Base URL ending in `/v1` (we call `${baseUrl}/embeddings`). */
  baseUrl: string;
  /** Model id. Defaults to `nomic-embed-text` when omitted. */
  modelId?: string;
  /** API key (Bearer); usually empty for localhost. */
  apiKey?: string | null;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

export type UpsertResult = 'ok' | 'no_model' | 'failed' | 'skipped';

const DEFAULT_MODEL_ID = 'nomic-embed-text';

function isDesktopLoopbackEmbeddingEndpoint(baseUrl: string): boolean {
  if (process.env.INKMARSHAL_RUNTIME !== 'desktop') return false;
  try {
    const url = new URL(baseUrl);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve an embedding endpoint without a request context. Used by the
 * `queueMicrotask` post-save hook in `app/actions/knowledge.ts`, where the
 * server action has no access to client localStorage and no incoming `req`.
 *
 * Resolution order:
 *   1. `INKMARSHAL_EMBED_BASE_URL` env var, only when desktop runtime wires up
 *      a loopback nomic-embed-text endpoint.
 *   2. `null` → caller treats as 'no_model'.
 */
export function resolveAmbientEmbeddingEndpoint(): EmbeddingEndpointHint | null {
  const baseUrl = parseUserRuntimeBaseUrl(process.env.INKMARSHAL_EMBED_BASE_URL?.trim() ?? '');
  if (!baseUrl) return null;
  if (!isDesktopLoopbackEmbeddingEndpoint(baseUrl)) return null;
  const apiKey = process.env.INKMARSHAL_EMBED_API_KEY?.trim() || null;
  if (apiKey && !runtimeBaseUrlCanCarrySecret(baseUrl)) return null;
  return {
    baseUrl,
    modelId: process.env.INKMARSHAL_EMBED_MODEL_ID?.trim() || DEFAULT_MODEL_ID,
    apiKey,
  };
}

/**
 * Resolve embedding endpoint from request headers. The header set is the same
 * `x-im-*` family the recall role binding emits — we just rename `x-im-*` →
 * `x-im-recall-*` so the route can carry a recall connection independent of
 * the chat one. If neither prefix is present, falls back to the ambient
 * resolver above.
 */
export function resolveEmbeddingEndpointFromRequest(
  req: Request,
): EmbeddingEndpointHint | null {
  if (!requestAllowsUserRuntime(req)) return resolveAmbientEmbeddingEndpoint();
  const isRecallRole = req.headers.get('x-im-role')?.trim() === 'recall';
  const baseUrl =
    req.headers.get('x-im-recall-base-url')?.trim() ||
    (isRecallRole ? req.headers.get('x-im-base-url')?.trim() : null) ||
    null;
  if (!baseUrl) return resolveAmbientEmbeddingEndpoint();
  const parsedBaseUrl = parseUserRuntimeBaseUrl(baseUrl);
  if (!parsedBaseUrl) return resolveAmbientEmbeddingEndpoint();
  const apiKey =
    req.headers.get('x-im-recall-secret') ||
    (isRecallRole ? req.headers.get('x-im-secret') : null);
  if (apiKey && !runtimeBaseUrlCanCarrySecret(parsedBaseUrl)) {
    return resolveAmbientEmbeddingEndpoint();
  }
  return {
    baseUrl: parsedBaseUrl,
    modelId:
      req.headers.get('x-im-recall-model')?.trim() ||
      (isRecallRole ? req.headers.get('x-im-model')?.trim() : null) ||
      DEFAULT_MODEL_ID,
    apiKey,
  };
}

/**
 * Call an OpenAI-compatible `/v1/embeddings` endpoint. Returns one Float32Array
 * per input string. Throws on transport / parse failure so callers can decide
 * whether to surface or swallow.
 */
export async function embedTexts(
  texts: string[],
  hint: EmbeddingEndpointHint,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const baseUrl = parseUserRuntimeBaseUrl(hint.baseUrl);
  if (!baseUrl) throw new Error('embedTexts: invalid embedding endpoint URL');
  if (hint.apiKey && hint.apiKey.trim() && !runtimeBaseUrlCanCarrySecret(baseUrl)) {
    throw new Error('embedTexts: insecure embedding API key transport');
  }
  const url = baseUrl.replace(/\/+$/, '') + '/embeddings';
  const body = JSON.stringify({
    model: hint.modelId ?? DEFAULT_MODEL_ID,
    input: texts,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hint.apiKey && hint.apiKey.trim()) {
    headers['Authorization'] = `Bearer ${hint.apiKey.trim()}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body, signal: hint.signal });
  if (!res.ok) {
    throw new Error(`embedTexts: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  if (!Array.isArray(json.data)) {
    throw new Error('embedTexts: malformed response (missing data[])');
  }
  if (json.data.length !== texts.length) {
    throw new Error('embedTexts: response length mismatch');
  }
  return json.data.map(item => {
    const arr = Array.isArray(item.embedding) ? item.embedding : [];
    if (arr.length === 0) {
      throw new Error('embedTexts: empty embedding vector');
    }
    return Float32Array.from(arr);
  });
}

/**
 * Recompute and upsert the embedding for a single vault entry. Reads the
 * entry's frontmatter + summary from `knowledge_index`. Skips when the index
 * row is missing (entry was just deleted) or when content_hash matches the
 * stored vector. Never throws — failures resolve to 'failed' so the calling
 * `queueMicrotask` is silent.
 */
export async function upsertEntryEmbedding(
  entryId: string,
  hint?: EmbeddingEndpointHint | null,
): Promise<UpsertResult> {
  try {
    const indexRow = await getKnowledgeIndexById(entryId);
    if (!indexRow) return 'skipped';
    const endpoint = hint ?? resolveAmbientEmbeddingEndpoint();
    if (!endpoint) return 'no_model';
    const existing = await getKnowledgeEmbedding(entryId);
    if (existing && existing.contentHash === indexRow.contentHash) {
      return 'skipped';
    }
    const queryText = buildEntryQueryText(indexRow);
    if (!queryText) return 'skipped';
    const [vec] = await embedTexts([queryText], endpoint);
    if (!vec || vec.length === 0) return 'failed';
    await upsertKnowledgeEmbedding({
      id: indexRow.id,
      novelId: indexRow.novelId,
      modelId: endpoint.modelId ?? DEFAULT_MODEL_ID,
      dim: vec.length,
      vector: vec,
      contentHash: indexRow.contentHash,
      updatedAt: new Date().toISOString(),
    });
    invalidateEmbeddingCache(indexRow.novelId);
    return 'ok';
  } catch (err) {
    console.warn('[embedding] upsertEntryEmbedding failed', err);
    return 'failed';
  }
}

/**
 * Batch entrypoint for refreshing a novel's embeddings. Iterates entries with a
 * small concurrency cap so we do not pin the embedding server on a large vault.
 * Returns a coarse counter for logging only.
 */
export async function batchUpsertEmbeddingsForNovel(
  novelId: string,
  entryIds: string[],
  hint?: EmbeddingEndpointHint | null,
): Promise<{ ok: number; skipped: number; failed: number; noModel: number }> {
  const result = { ok: 0, skipped: 0, failed: 0, noModel: 0 };
  // Concurrency 3 — most local engines tolerate a few in-flight requests; tune later if needed.
  const concurrency = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < entryIds.length) {
      const i = cursor++;
      const r = await upsertEntryEmbedding(entryIds[i], hint);
      if (r === 'ok') result.ok++;
      else if (r === 'skipped') result.skipped++;
      else if (r === 'no_model') {
        result.noModel++;
        // No point hammering when there's no model — bail out the worker.
        cursor = entryIds.length;
        return;
      }
      else result.failed++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  void novelId;
  return result;
}

export interface SimilarHit {
  entryId: string;
  score: number;
}

/**
 * Cosine search for top-K most similar entries to a query. Returns at most
 * `k` hits; if no embeddings exist for the novel, returns []. Throws only on
 * a query-time embedding failure (callers wrap in try/catch and fall back).
 */
// Cache of (novelId → {version, rows}). Avoids re-reading + re-parsing the full
// embedding table for every AI call. The expensive full BLOB read is gated
// behind a cheap COUNT(*) + MAX(updated_at) probe so a cache hit costs one
// aggregate query, not a table scan + Float32 decode. Invalidated whenever
// upsertEntryEmbedding writes a fresher row.
interface EmbeddingCacheEntry {
  /** Collision-resistant version token: `${count}:${maxUpdatedAt}`. */
  version: string;
  rows: Awaited<ReturnType<typeof listKnowledgeEmbeddings>>;
}
const embeddingCache = new Map<string, EmbeddingCacheEntry>();

// `count` alone misses same-count edits; `maxUpdatedAt` alone misses a
// delete-then-insert in the same millisecond (count stays equal, max unchanged).
// Combining both makes that collision require an exactly-compensating churn,
// which the per-write `invalidateEmbeddingCache` already covers anyway.
function embeddingVersionKey(stats: { count: number; maxUpdatedAt: string }): string {
  return `${stats.count}:${stats.maxUpdatedAt}`;
}

export function invalidateEmbeddingCache(novelId?: string): void {
  if (novelId) embeddingCache.delete(novelId);
  else embeddingCache.clear();
}

// One-shot dedupe for the dim-mismatch warnings below so a recall pass over a
// stale vector store doesn't spam the log on every AI call. Keyed on
// `${novelId}:${storedDim}:${queryDim}`.
const dimMismatchWarned = new Set<string>();

async function getCachedEmbeddings(novelId: string) {
  const stats = await getKnowledgeEmbeddingStats(novelId);
  if (stats.count === 0) {
    embeddingCache.delete(novelId);
    return [];
  }
  const version = embeddingVersionKey(stats);
  const cached = embeddingCache.get(novelId);
  if (cached && cached.version === version) {
    return cached.rows;
  }
  // Cache miss — only now pay the full BLOB read + Float32 decode.
  const fresh = await listKnowledgeEmbeddings(novelId);
  embeddingCache.set(novelId, { version, rows: fresh });
  return fresh;
}

export async function searchSimilarEntries(
  novelId: string,
  query: string,
  k: number,
  hint?: EmbeddingEndpointHint | null,
): Promise<SimilarHit[]> {
  if (!query.trim()) return [];
  const endpoint = hint ?? resolveAmbientEmbeddingEndpoint();
  if (!endpoint) return [];
  const stored = await getCachedEmbeddings(novelId);
  if (stored.length === 0) return [];
  const [queryVec] = await embedTexts([query], endpoint).catch(() => []);
  if (!queryVec) return [];
  const hits: SimilarHit[] = [];
  let mismatched = 0;
  for (const row of stored) {
    if (row.dim !== queryVec.length) {
      // Dropping a stored vector whose dim differs from the current query model
      // (e.g. the user re-picked the embedding model: nomic-embed-text 768 →
      // bge-m3 1024). Warn once per (novel, storedDim, queryDim) so this is
      // diagnosable instead of silently degrading recall to keyword-only.
      const warnKey = `${novelId}:${row.dim}:${queryVec.length}`;
      if (!dimMismatchWarned.has(warnKey)) {
        dimMismatchWarned.add(warnKey);
        console.warn(
          '[embedding] dropping stored vector with mismatched dim',
          { novelId, storedDim: row.dim, queryDim: queryVec.length },
        );
      }
      mismatched++;
      continue;
    }
    const score = cosine(queryVec, row.vector);
    if (Number.isFinite(score)) {
      hits.push({ entryId: row.id, score });
    }
  }
  // The entire vector store is for a different model than the active query
  // model — recall just silently lost its dense layer until a reindex. Surface
  // a distinct signal (once per query-dim) so the caller / ops can react.
  if (mismatched > 0 && hits.length === 0) {
    const staleKey = `stale:${novelId}:${queryVec.length}`;
    if (!dimMismatchWarned.has(staleKey)) {
      dimMismatchWarned.add(staleKey);
      console.warn(
        '[embedding] embedding vector store is stale for the current model — reindex needed',
        { novelId, queryDim: queryVec.length, storedVectors: stored.length },
      );
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(0, k));
}

// ── pure helpers ──────────────────────────────────────────────────────────

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Compose the text we send to the embedder for one entry. Prefers the
 * frontmatter title + description + summary so the embedding represents
 * stable facts rather than narrative prose. Caps at ~1000 chars — nomic-embed
 * is happy with that and we keep latency tight.
 */
function buildEntryQueryText(row: {
  title: string;
  data: Record<string, unknown>;
}): string {
  const parts: string[] = [row.title];
  const description = row.data['description'];
  if (typeof description === 'string' && description.trim()) {
    parts.push(description.trim());
  }
  const synopsis = row.data['synopsis'];
  if (typeof synopsis === 'string' && synopsis.trim()) {
    parts.push(synopsis.trim());
  }
  const motivation = row.data['motivation'];
  if (typeof motivation === 'string' && motivation.trim()) {
    parts.push(motivation.trim());
  }
  const arc = row.data['arc'];
  if (typeof arc === 'string' && arc.trim()) {
    parts.push(arc.trim());
  }
  return parts.join('\n').slice(0, 1000);
}
