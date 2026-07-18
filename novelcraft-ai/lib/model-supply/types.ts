// Model Supply Layer — locked cross-task type contract (WS-B).
//
// This file is the SINGLE SOURCE OF TRUTH for the data shapes shared by:
//   - B.2 (Rust command I/O — serde structs must match these shapes)
//   - B.3 (operation → capability role → connection resolution)
//   - B.4 (model-management UI)
//
// CROSS-TASK CONTRACTS LOCKED HERE (do NOT silently diverge in B.2/B.3/B.4):
//
//  1. `RuntimeTransport` enum (below) — the minimal precise set the broker and
//     Rust health/probe code branch on. `ollama-native` vs `openai-compatible`
//     is the load-bearing distinction: `openai-compatible` baseUrl ends in
//     `/v1`; `ollama-native` talks to Ollama's native `/api/*` endpoints
//     (used by ollama pull/list/tags). `anthropic` is the Messages API.
//
//  2. Keychain account namespace: the desktop keychain (A.1) is ONE shared
//     keyring service (`co.inkmarshal.studio`) keyed only by `account`. To
//     avoid collisions every secret MUST use a namespaced account. The
//     connection-secret convention is `connection:<connectionId>` produced by
//     `connectionSecretAccount()` below — secret-store derives accounts from
//     this, never from a raw id. (Addresses the A.1 single-service review
//     concern.)
//
//  3. Rust → TS field casing for streaming/health payloads is **camelCase**.
//     B.2's serde structs that back `runtime_health`, `ollama_pull`,
//     `hf_download_gguf`, `hf_search_models`, `hf_list_gguf_files` MUST use
//     `#[serde(rename_all = "camelCase")]` so the wire shape matches
//     `ConnectionHealth` / `PullProgress` / `DownloadProgress` /
//     `HfSearchResult` / `HfModelFile` exactly as declared here.

/**
 * The four writing capability roles the broker routes by. Every writing
 * operation maps onto exactly one of these (see {@link OPERATION_ROLE}).
 *
 * - `draft`    — fast generative drafting (chat, chapter prose).
 * - `rewrite`  — editorial rewrite / polish / whole-book unification.
 * - `planning` — outline / structural reasoning.
 * - `recall`   — summarize / validate / knowledge recall (embeddings-adjacent).
 */
export type CapabilityRole = 'draft' | 'rewrite' | 'planning' | 'recall';

/** All capability roles, iteration order stable for UI listing. */
export const CAPABILITY_ROLES: readonly CapabilityRole[] = [
  'draft',
  'rewrite',
  'planning',
  'recall',
] as const;

/**
 * The writing operations the runtime broker dispatches. These are the EXACT
 * keys of {@link OPERATION_ROLE}. B.3 may add operations later — adding one is
 * a one-line addition to both this union and the `OPERATION_ROLE` map. Do NOT
 * invent extra operations in B.1.
 */
export type OperationKind =
  | 'chat'
  | 'outline'
  | 'chapter'
  | 'polish'
  | 'summarize'
  | 'validate'
  | 'unify';

/**
 * LOCKED operation → capability-role map (verbatim from the WS-B plan).
 *
 * Designed so adding a new operation is a single new line here (plus its key
 * in {@link OperationKind}); resolution code (B.3) reads only this map and
 * never hard-codes a role per operation.
 */
export const OPERATION_ROLE: Record<OperationKind, CapabilityRole> = {
  chat: 'draft',
  outline: 'planning',
  chapter: 'draft',
  polish: 'rewrite',
  summarize: 'recall',
  validate: 'recall',
  unify: 'rewrite',
};

/**
 * Transport class of a runtime/connection. Minimal precise set — the broker
 * (B.3) and Rust health probe (B.2) branch on this:
 *
 * - `openai-compatible` — OpenAI `/v1` chat-completions shape. Covers OpenAI,
 *   DeepSeek, Moonshot, Qwen/DashScope-compatible, SiliconFlow, OpenRouter,
 *   LM Studio, llama.cpp server, MLX server, any custom `/v1` endpoint.
 * - `anthropic` — Anthropic Messages API (`/v1/messages`, `x-api-key`).
 * - `ollama-native` — Ollama's native `/api/*` surface (tags/pull/generate).
 *   Distinct from `openai-compatible` because pull/list use native endpoints.
 */
export type RuntimeTransport = 'openai-compatible' | 'anthropic' | 'ollama-native';
export const RUNTIME_TRANSPORTS: readonly RuntimeTransport[] = [
  'openai-compatible',
  'anthropic',
  'ollama-native',
] as const;

/** Whether a connection is a local runtime, a hosted provider, or a custom endpoint. */
export type RuntimeConnectionKind = 'local' | 'provider' | 'custom';
export const RUNTIME_CONNECTION_KINDS: readonly RuntimeConnectionKind[] = [
  'local',
  'provider',
  'custom',
] as const;

export function isRuntimeTransport(value: unknown): value is RuntimeTransport {
  return typeof value === 'string' && RUNTIME_TRANSPORTS.includes(value as RuntimeTransport);
}

export function isRuntimeConnectionKind(value: unknown): value is RuntimeConnectionKind {
  return typeof value === 'string' && RUNTIME_CONNECTION_KINDS.includes(value as RuntimeConnectionKind);
}

/**
 * Opaque reference to a stored secret. NEVER carries the secret value itself —
 * only the keychain/localStorage `account` under which secret-store holds it.
 * For connection keys `account` is always `connection:<connectionId>` (see
 * {@link connectionSecretAccount}).
 */
export interface SecretRef {
  account: string;
}

/** Namespace prefix for connection secrets in the shared keychain service. */
export const CONNECTION_SECRET_PREFIX = 'connection:' as const;
export const MAX_CONNECTION_SECRET_ACCOUNT_LENGTH = 2_096;
export const MAX_CONNECTION_SECRET_VALUE_LENGTH = 16_384;

/** Derive the namespaced secret account for a connection id. */
export function connectionSecretAccount(connectionId: string): string {
  return `${CONNECTION_SECRET_PREFIX}${connectionId}`;
}

/** Build the {@link SecretRef} for a connection id. */
export function connectionSecretRef(connectionId: string): SecretRef {
  return { account: connectionSecretAccount(connectionId) };
}

/**
 * A user-owned runtime connection. The secret (API key / bearer token) is
 * NEVER stored on this object — only an opaque {@link SecretRef}. Plaintext
 * keys live exclusively in secret-store (keychain on desktop).
 */
export interface RuntimeConnection {
  /**
   * Stable unique id, assigned on first upsert; never changes across updates.
   * Usually a UUID but has a non-UUID fallback (see `newId`) — treat as an
   * opaque string. B.3/B.4 MUST NOT parse/validate it as a UUID.
   */
  id: string;
  /** Human label shown in the UI ("My OpenAI", "Local Ollama"). */
  label: string;
  kind: RuntimeConnectionKind;
  transport: RuntimeTransport;
  /** Base URL the runtime is reached at (e.g. `https://api.openai.com/v1`). */
  baseUrl: string;
  /**
   * Reference to the stored secret, or null/undefined when the connection
   * needs no key (most local runtimes). Presence does NOT imply a secret is
   * actually stored — callers resolve the value via secret-store.
   */
  secretRef?: SecretRef | null;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
}

/** A curated catalog model. `role` (roleFit) is the role(s) it serves well. */
export interface CuratedModelEntry {
  id: string;
  name: string;
  /** Freshness lifecycle for curated recommendations. Only `recommended`
   * entries may appear in first-run starter shelves. */
  lifecycle: 'recommended' | 'current' | 'compatibility' | 'legacy' | 'deprecated';
  /** roleFit: single role or the set of roles this model serves well. */
  role: CapabilityRole | CapabilityRole[];
  /** Curated category label (spec §2 curated categories), for UI grouping. */
  category: string;
  /** Ollama library tag, e.g. `qwen3.5:4b`. Omitted if no Ollama path. */
  ollamaName?: string;
  /** Hugging Face GGUF source, when a sensible public repo exists. */
  gguf?: {
    repo: string;
    recommendedQuant?: string;
  };
  /** Hugging Face MLX repo (macOS only), when a well-known public repo exists. */
  mlx?: {
    repo: string;
  };
  /** ISO date when fast-moving catalog metadata was last checked against source model cards. */
  lastVerifiedAt: string;
  /** Source URLs used for the most recent manual verification. */
  sourceUrls: readonly string[];
  /** Replacement to surface when this entry is kept only for compatibility. */
  replacementId?: string;
  /** Short reason for legacy/compatibility state, shown in audits/tests. */
  lifecycleNote?: string;
  /** Rough minimum system RAM (GB) to run the recommended quant. */
  minRamGb?: number;
  /** Human size hint for the recommended variant ("~4.7 GB"). */
  sizeHint?: string;
  /**
   * Approximate context window (tokens) the model was trained with. Curated
   * value — taken from the model card's max_position_embeddings (or the value
   * the chat template ships with), not from a runtime probe. Consumers should
   * still trust an engine-reported value first when present.
   *
   * Omitted (undefined) when we don't have a confident value; callers fall
   * back to engine metadata, then to FALLBACK_CTX_TOKENS in lib/token-budget.
   */
  contextLengthTokens?: number;
  /**
   * Wave 4 commit F additions — used by autoBind scoring + UI badges:
   *
   * - `languages`     — which languages the model handles competently.
   *                     `'multi'` means we don't want to pin a specific
   *                     language. autoBind adds a small Chinese bonus when a
   *                     novel is zh and the model lists `'zh'`.
   * - `prosePreset`   — kind of prose the model is good at; UI shows a hint
   *                     so users picking a model for long-form know which is
   *                     literary-leaning vs general assistant-style.
   * - `paramsB`       — parameter count in billions, used for RAM estimate
   *                     and the "8B / 14B" chip on the card.
   *
   * All three are optional — old entries without them keep working unchanged.
   */
  languages?: ReadonlyArray<'zh' | 'en' | 'ja' | 'multi'>;
  prosePreset?: 'literary' | 'webnovel' | 'general';
  paramsB?: number;
  /**
   * Optional BYOK price (per million tokens) for the local cost panel's cost
   * estimate. Curated local models are run on the user's own hardware (cost = 0)
   * so this is normally absent here; it exists for completeness and parity with
   * {@link import('@/lib/providers').ProviderModelMetadata}'s `pricing`. ONLY
   * fill it with a source-verified price (same freshness discipline as
   * `lastVerifiedAt`/`sourceUrls`) — a missing price is rendered as "unknown",
   * never as free, so never invent a number to look complete.
   */
  pricing?: ModelTokenPricing;
}

/** Per-million-token price for a model, surfaced to the local cost panel. */
export interface ModelTokenPricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  /** ISO-4217 code; defaults to USD when omitted. */
  currency?: string;
}

// NOTE: Contract type consumed by B.2 (Rust I/O) and B.4 (UI). Intentionally
// unreferenced within B.1 — do NOT prune as dead code.
/** A model actually present in / reachable from a local runtime. */
export interface InstalledModel {
  runtimeConnectionId: string;
  modelId: string;
  name?: string;
  sizeBytes?: number;
  quant?: string;
  source: 'ollama' | 'gguf' | 'mlx' | 'openai-compatible';
}

/** A model file/snapshot already present in the desktop app's model folder. */
export interface InstalledLocalModel {
  label: string;
  modelPath: string;
  format: 'gguf' | 'mlx';
  sizeBytes: number;
  sourceRepo?: string;
  sourceFilename?: string;
  installedAtUnix?: number;
  managedByApp: boolean;
}

// NOTE: HfModelFile / HfSearchResult are contract types consumed by B.2 (Rust
// I/O) and B.4 (UI). Intentionally unreferenced within B.1 — not dead code.
/** A single GGUF file inside a Hugging Face repo. */
export interface HfModelFile {
  repo: string;
  filename: string;
  sizeBytes: number;
  quant?: string;
  sha256?: string;
  /** C1 additive: resolved format ("gguf" | "mlx") — never rename/reorder above fields. */
  format: 'gguf' | 'mlx';
}

/** Args for `hf_download_repo_snapshot` — mirrors Rust `SnapshotArgs` (camelCase). */
export interface SnapshotDownloadArgs {
  repoId: string;
  files: HfModelFile[];
  destDir: string;
}

/** One Hugging Face repo search hit (return shape of `hf_search_models`). */
export interface HfSearchResult {
  repo: string;
  downloads: number;
  /** C1 additive: resolved format ("gguf" | "mlx") — never rename/reorder above fields. */
  format: 'gguf' | 'mlx';
  /**
   * Wave 4 commit F additive: best-effort language hint derived from the HF
   * repo's tags / readme. Currently we surface a single coarse signal
   * (`'zh'`) when the listing mentions Chinese — used to show a
   * "中文友好" badge in LocalModelsPanel. Never reorder above fields:
   * Rust → TS structural contract.
   */
  languageHint?: 'zh' | 'en' | 'multi';
}

/** A resolved capability binding: which connection + model serves a role. */
export interface CapabilityBinding {
  connectionId: string;
  modelId: string;
  /** Optional fallback used when the primary connection/model is unavailable. */
  fallback?: {
    connectionId: string;
    modelId: string;
  };
}

/**
 * Role → binding map. A role may be unbound (`null`). B.3 resolves an
 * operation by `OPERATION_ROLE[op]` then this profile.
 */
export type CapabilityProfile = Record<CapabilityRole, CapabilityBinding | null>;

// ── Streaming / health payloads (Rust → TS, camelCase — see contract #3) ──

/**
 * Ollama `/api/pull` NDJSON progress line. Mirrors Ollama's native stream:
 * `{ status, digest?, total?, completed? }`. B.2 serializes each NDJSON line
 * into this shape over a `Channel<PullProgress>`.
 */
export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/** Phase of an HF GGUF download. */
export type DownloadPhase = 'downloading' | 'verifying' | 'done' | 'error';

/**
 * HF GGUF download progress, streamed over a `Channel<DownloadProgress>`.
 * `phase` drives the UI state machine; `message` carries error/verify detail.
 */
export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  phase: DownloadPhase;
  message?: string;
}

/**
 * Return shape of B.2's `runtime_health` command. camelCase per contract #3 —
 * B.2's Rust struct uses `#[serde(rename_all = "camelCase")]`.
 *
 * - `reachable`   — the base URL responded at all.
 * - `transportOk` — the response matched the declared transport's protocol.
 * - `models`      — model ids the runtime advertises (may be empty).
 * - `latencyMs`   — round-trip latency of the probe.
 * - `message`     — product-level human status ("drafting model ready" / why not).
 */
export interface ConnectionHealth {
  reachable: boolean;
  transportOk: boolean;
  models: string[];
  latencyMs: number;
  message: string;
}
