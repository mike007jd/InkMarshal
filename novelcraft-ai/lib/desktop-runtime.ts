import type {
  ConnectionHealth,
  DownloadProgress,
  HfModelFile,
  HfSearchResult,
  InstalledLocalModel,
  PullProgress,
  RuntimeTransport,
} from '@/lib/model-supply/types';

export interface DesktopStatus {
  desktop: boolean;
  platform: string;
  arch?: string | null;
  total_memory_bytes?: number | null;
  app_data_dir?: string | null;
  model_dir?: string | null;
  model_dir_error?: string | null;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

/** True on macOS (or iOS — same modifier-key convention). SSR-safe; returns
 *  false when navigator is unavailable. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;
  return isMacPlatformName(platform);
}

export function isMacPlatformName(platform: string | null | undefined): boolean {
  return /mac|iP(hone|ad|od)/i.test(platform ?? '');
}

export const DESKTOP_COMMANDS = {
  desktopStatus: 'desktop_status',
  probeDefaultRuntimes: 'probe_default_runtimes',
  keychainSet: 'keychain_set',
  keychainGet: 'keychain_get',
  keychainDelete: 'keychain_delete',
  keychainStatus: 'keychain_status',
  runtimeHealth: 'runtime_health',
  ollamaListTags: 'ollama_list_tags',
  ollamaPull: 'ollama_pull',
  hfSearchModels: 'hf_search_models',
  hfListGgufFiles: 'hf_list_gguf_files',
  hfGetEndpoint: 'hf_get_endpoint',
  hfSetEndpoint: 'hf_set_endpoint',
  hfDownloadGguf: 'hf_download_gguf',
  hfDownloadRepoSnapshot: 'hf_download_repo_snapshot',
  cancelDownload: 'cancel_download',
  modelDirFreeBytes: 'model_dir_free_bytes',
  setModelDir: 'set_model_dir',
  resetModelDir: 'reset_model_dir',
  revealModelDir: 'reveal_model_dir',
  listInstalledLocalModels: 'list_installed_local_models',
  importLocalModel: 'import_local_model',
  revealLocalModel: 'reveal_local_model',
  removeInstalledLocalModel: 'remove_installed_local_model',
  engineStart: 'engine_start',
  engineStop: 'engine_stop',
  engineStatus: 'engine_status',
  engineEstimateFootprint: 'engine_estimate_footprint',
  engineResourceBudget: 'engine_resource_budget',
  engineLogTail: 'engine_log_tail',
  stopOthersForPath: 'stop_others_for_path',
  revealExportFile: 'reveal_export_file',
  readLocalFile: 'read_local_file',
} as const;

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

async function invokeTauriWithProgress<TProgress>(
  command: string,
  args: Record<string, unknown>,
  onProgress: (progress: TProgress) => void,
): Promise<void> {
  const { Channel } = await import('@tauri-apps/api/core');
  const channel = new Channel<TProgress>();
  channel.onmessage = onProgress;
  await invokeTauri<void>(command, { ...args, onProgress: channel });
}

export async function getDesktopStatus(): Promise<DesktopStatus> {
  if (!isTauriRuntime()) {
    return {
      desktop: false,
      platform: typeof navigator === 'undefined' ? 'web' : navigator.platform,
      arch: null,
      total_memory_bytes:
        typeof navigator !== 'undefined' && 'deviceMemory' in navigator
          ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory! * 1024 ** 3
          : null,
      app_data_dir: null,
      model_dir: null,
    };
  }
  try {
    const status = await invokeTauri<DesktopStatus>(DESKTOP_COMMANDS.desktopStatus);
    return status;
  } catch (err) {
    return {
      desktop: true,
      platform: typeof navigator === 'undefined' ? 'desktop' : navigator.platform,
      arch: null,
      total_memory_bytes: null,
      app_data_dir: null,
      model_dir: null,
      model_dir_error: err instanceof Error ? err.message : 'desktop_status failed',
    };
  }
}

// ── Model-supply capability wrappers ────────────────────────────────────────
//
// LOCKED command-name contract — the Rust `generate_handler!` registers EXACTLY
// these snake_case names. Do not rename without updating the Rust side.
//
//   keychainSet        -> keychain_set
//   keychainGet        -> keychain_get
//   keychainDelete     -> keychain_delete
//   runtimeHealth      -> runtime_health
//   ollamaListTags     -> ollama_list_tags
//   ollamaPull         -> ollama_pull         (Channel<PullProgress>)
//   hfSearchModels     -> hf_search_models
//   hfListGgufFiles    -> hf_list_gguf_files
//   hfGetEndpoint      -> hf_get_endpoint
//   hfSetEndpoint      -> hf_set_endpoint
//   hfDownloadGguf     -> hf_download_gguf    (Channel<DownloadProgress>)
//   cancelDownload     -> cancel_download
//   modelDirFreeBytes  -> model_dir_free_bytes
//
// Each wrapper is a real `invoke` call (never stubbed); calling one whose
// command is not registered rejects with Tauri's "command not found".

function requireTauri(fnName: string): void {
  if (!isTauriRuntime()) {
    throw new Error(`${fnName} is desktop-only (requires the Tauri runtime)`);
  }
}

/** A.1 secret backend in active use (OS keychain or encrypted file fallback). */
export type SecretBackend = 'keychain' | 'encrypted_file';

interface SecretBackendStatus {
  backend: SecretBackend;
}

interface SecretGetResult {
  value: string | null;
  backend: SecretBackend;
}

/** A.1 keychain: store a secret. Returns the backend that actually persisted it. */
export async function keychainSet(account: string, secret: string): Promise<SecretBackend> {
  requireTauri('keychainSet');
  return invokeTauri<SecretBackend>(DESKTOP_COMMANDS.keychainSet, { account, secret });
}

/** A.1 keychain: read a secret; missing entry resolves to `null`. */
export async function keychainGet(account: string): Promise<string | null> {
  requireTauri('keychainGet');
  const result = await invokeTauri<SecretGetResult>(DESKTOP_COMMANDS.keychainGet, { account });
  return result.value;
}

/** A.1 keychain: delete a secret (idempotent). Returns the active backend. */
export async function keychainDelete(account: string): Promise<SecretBackend> {
  requireTauri('keychainDelete');
  return invokeTauri<SecretBackend>(DESKTOP_COMMANDS.keychainDelete, { account });
}

/** A.1 keychain: report which backend is currently active. */
export async function keychainStatus(): Promise<SecretBackend> {
  requireTauri('keychainStatus');
  const result = await invokeTauri<SecretBackendStatus>(DESKTOP_COMMANDS.keychainStatus);
  return result.backend;
}

/** B.2: probe a runtime connection's reachability/transport/models. */
export async function runtimeHealth(input: {
  connectionId: string;
  baseUrl: string;
  transport: RuntimeTransport;
  secret?: string | null;
}): Promise<ConnectionHealth> {
  requireTauri('runtimeHealth');
  return invokeTauri<ConnectionHealth>(DESKTOP_COMMANDS.runtimeHealth, { input });
}

/** B.2: list model tags installed in a local Ollama runtime. */
export async function ollamaListTags(baseUrl: string): Promise<string[]> {
  requireTauri('ollamaListTags');
  return invokeTauri<string[]>(DESKTOP_COMMANDS.ollamaListTags, { baseUrl });
}

/** B.2: curated HF repo search (NOT a generic catalog dump — see catalog.ts). */
export async function hfSearchModels(
  query: string,
  format: 'gguf' | 'mlx',
  limit: number,
): Promise<HfSearchResult[]> {
  requireTauri('hfSearchModels');
  return invokeTauri<HfSearchResult[]>(DESKTOP_COMMANDS.hfSearchModels, { query, format, limit });
}

/** B.2: list files (with sizes/quant/sha) in an HF repo, filtered by format. */
export async function hfListGgufFiles(
  repoId: string,
  format: 'gguf' | 'mlx',
): Promise<HfModelFile[]> {
  requireTauri('hfListGgufFiles');
  return invokeTauri<HfModelFile[]>(DESKTOP_COMMANDS.hfListGgufFiles, { repoId, format });
}

export interface HfEndpointStatus {
  configuredEndpoint: string | null;
  effectiveEndpoint: string;
  source: 'default' | 'setting' | 'environment';
}

/** Read the persisted model download source and the effective HF_ENDPOINT override. */
export async function hfGetEndpoint(): Promise<HfEndpointStatus> {
  requireTauri('hfGetEndpoint');
  return invokeTauri<HfEndpointStatus>(DESKTOP_COMMANDS.hfGetEndpoint);
}

/** Persist a model download source. null/the official endpoint resets to default. */
export async function hfSetEndpoint(endpoint: string | null): Promise<HfEndpointStatus> {
  requireTauri('hfSetEndpoint');
  return invokeTauri<HfEndpointStatus>(DESKTOP_COMMANDS.hfSetEndpoint, { endpoint });
}

/**
 * B.2: download a GGUF file, streaming progress over a Channel. Resumable /
 * integrity-verified on the Rust side; `expectedSha256` enables checksum
 * verification and `expectedSizeBytes` catches truncated files when a checksum
 * is unavailable.
 */
export async function hfDownloadGguf(
  args: {
    repoId: string;
    filename: string;
    destPath: string;
    expectedSha256?: string;
    expectedSizeBytes?: number;
  },
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  requireTauri('hfDownloadGguf');
  await invokeTauriWithProgress<DownloadProgress>(
    DESKTOP_COMMANDS.hfDownloadGguf,
    { args },
    onProgress,
  );
}

/**
 * C3: download every file of an MLX repo snapshot into `destDir`, streaming
 * aggregate progress over a Channel. Resumable per-file, sha256-verified,
 * single cancel flag for the whole repo (task id == repoId).
 */
export async function hfDownloadRepoSnapshot(
  args: { repoId: string; files: HfModelFile[]; destDir: string },
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  requireTauri('hfDownloadRepoSnapshot');
  await invokeTauriWithProgress<DownloadProgress>(
    DESKTOP_COMMANDS.hfDownloadRepoSnapshot,
    { args },
    onProgress,
  );
}

/** B.2: cancel an in-flight download by its task id. */
export async function cancelDownload(taskId: string): Promise<void> {
  requireTauri('cancelDownload');
  await invokeTauri<void>(DESKTOP_COMMANDS.cancelDownload, { taskId });
}

/** B.2: free bytes available in the local model directory (disk-space check). */
export async function modelDirFreeBytes(): Promise<number> {
  requireTauri('modelDirFreeBytes');
  return invokeTauri<number>(DESKTOP_COMMANDS.modelDirFreeBytes);
}

export async function pickModelDir(currentPath?: string | null): Promise<string | null> {
  requireTauri('pickModelDir');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: false,
    directory: true,
    defaultPath: currentPath || undefined,
  });
  return typeof picked === 'string' ? picked : null;
}

export async function setModelDir(modelDir: string): Promise<string> {
  requireTauri('setModelDir');
  return invokeTauri<string>(DESKTOP_COMMANDS.setModelDir, { modelDir });
}

export async function resetModelDir(): Promise<string> {
  requireTauri('resetModelDir');
  return invokeTauri<string>(DESKTOP_COMMANDS.resetModelDir);
}

export async function revealModelDir(): Promise<void> {
  requireTauri('revealModelDir');
  await invokeTauri<void>(DESKTOP_COMMANDS.revealModelDir);
}

/** List GGUF files and MLX snapshots already present in the local model folder. */
export async function listInstalledLocalModels(): Promise<InstalledLocalModel[]> {
  requireTauri('listInstalledLocalModels');
  return invokeTauri<InstalledLocalModel[]>(DESKTOP_COMMANDS.listInstalledLocalModels);
}

/** Register an existing local GGUF file or MLX bundle folder without copying it. */
export async function importLocalModel(modelPath: string): Promise<InstalledLocalModel> {
  requireTauri('importLocalModel');
  return invokeTauri<InstalledLocalModel>(DESKTOP_COMMANDS.importLocalModel, { modelPath });
}

/** Pick an existing GGUF file path through the native desktop dialog. */
export async function pickLocalGgufModel(): Promise<string | null> {
  requireTauri('pickLocalGgufModel');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'GGUF model', extensions: ['gguf'] }],
  });
  return typeof picked === 'string' ? picked : null;
}

/** Pick an existing MLX model bundle folder through the native desktop dialog. */
export async function pickLocalMlxModelFolder(): Promise<string | null> {
  requireTauri('pickLocalMlxModelFolder');
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, directory: true });
  return typeof picked === 'string' ? picked : null;
}

export interface LocalFileRead {
  path: string;
  contentsBase64: string;
}

/**
 * Read a user-chosen local file through a native open dialog. The user picks
 * each file explicitly (the dialog runs Rust-side), so no arbitrary path is ever
 * read — `read_local_file` mirrors `save_export_file`'s safety model. Pass the
 * allowed extensions (e.g. `['txt','md','docx']`); returns `null` if the user
 * dismissed the dialog. Shared by manuscript import, backup restore, and
 * template-pack import.
 */
export async function readLocalFile(extensions: string[]): Promise<LocalFileRead | null> {
  requireTauri('readLocalFile');
  return invokeTauri<LocalFileRead | null>(DESKTOP_COMMANDS.readLocalFile, { extensions });
}

/** One `*.inkmarshal` backup file already on disk in the chosen backup folder. */
/** Reveal a local model file or snapshot folder in the OS file manager. */
export async function revealLocalModel(modelPath: string): Promise<void> {
  requireTauri('revealLocalModel');
  await invokeTauri<void>(DESKTOP_COMMANDS.revealLocalModel, { modelPath });
}

/** Reveal a just-exported file in Finder/Explorer. The Rust side only
 *  accepts paths produced by `save_export_file` in this session. */
export async function revealExportFile(path: string): Promise<void> {
  requireTauri('revealExportFile');
  await invokeTauri<void>(DESKTOP_COMMANDS.revealExportFile, { path });
}

/** Remove an installed local model after the UI has confirmed the destructive action. */
export async function removeInstalledLocalModel(modelPath: string): Promise<void> {
  requireTauri('removeInstalledLocalModel');
  await invokeTauri<void>(DESKTOP_COMMANDS.removeInstalledLocalModel, { modelPath });
}

export type EngineFormat = 'gguf' | 'mlx';

export interface EngineInfo {
  engineId: string;
  format: EngineFormat;
  modelPath: string;
  port: number;
  /** Wave 4-A: cached RAM footprint estimate (bytes), 0 when estimation failed. */
  footprintBytes: number;
  /** Wave 4-A: optional disambiguator so the same model can run in multiple instances. */
  engineLabel?: string | null;
}

/** Wave 4-A: footprint estimate for a model file/snapshot (RAM only on Apple Silicon). */
export interface EngineFootprint {
  modelSizeBytes: number;
  ramBytes: number;
  vramHintBytes: number;
}

/** Wave 4-A: a snapshot of one running engine's resource bookkeeping. */
export interface RunningEngineSummary {
  engineId: string;
  modelPath: string;
  footprintBytes: number;
}

/** Wave 4-A: the system's current resource budget — used for admit/deny checks. */
export interface EngineBudget {
  totalRamBytes: number;
  availableRamBytes: number;
  reservedForOsBytes: number;
  running: RunningEngineSummary[];
}

/** Start the bundled inference engine for a downloaded model. Resolves when the
 * local OpenAI-compatible server is ready (Rust polls /v1/models). */
export async function engineStart(args: {
  modelPath: string;
  format: EngineFormat;
  /** Wave 4-A: disambiguator so the same model can be launched twice (e.g. one
   * bound to polish, another to draft). `null`/omitted collapses to the legacy
   * single-instance form. */
  engineLabel?: string | null;
}): Promise<EngineInfo> {
  requireTauri('engineStart');
  return invokeTauri<EngineInfo>(DESKTOP_COMMANDS.engineStart, { args });
}

/** Stop a running bundled engine by id (no-op if already stopped). */
export async function engineStop(engineId: string): Promise<void> {
  requireTauri('engineStop');
  await invokeTauri<void>(DESKTOP_COMMANDS.engineStop, { engineId });
}

/** List currently running bundled engines. */
export async function engineStatus(): Promise<EngineInfo[]> {
  requireTauri('engineStatus');
  return invokeTauri<EngineInfo[]>(DESKTOP_COMMANDS.engineStatus);
}

/**
 * Wave 4-A: estimate RAM footprint of a model file (GGUF) or snapshot dir (MLX)
 * without launching anything. Throws on missing path / unreadable bundle.
 */
export async function engineEstimateFootprint(
  modelPath: string,
  format: EngineFormat,
): Promise<EngineFootprint> {
  requireTauri('engineEstimateFootprint');
  return invokeTauri<EngineFootprint>(DESKTOP_COMMANDS.engineEstimateFootprint, {
    modelPath,
    format,
  });
}

/**
 * Wave 4-A: report total RAM, available RAM, OS reservation and currently
 * running engines. The orchestrator uses this to decide admit/deny before
 * starting a new engine.
 */
export async function engineResourceBudget(): Promise<EngineBudget> {
  requireTauri('engineResourceBudget');
  return invokeTauri<EngineBudget>(DESKTOP_COMMANDS.engineResourceBudget);
}

/**
 * Wave 4-A: stop every running engine whose `modelPath` matches the argument.
 * Returns the count stopped. Used by the orchestrator's "replace" conflict
 * policy — never call from a non-explicit code path.
 */
export async function stopOthersForPath(modelPath: string): Promise<number> {
  requireTauri('stopOthersForPath');
  return invokeTauri<number>(DESKTOP_COMMANDS.stopOthersForPath, { modelPath });
}

const ALLOWED_EXTERNAL_URLS = new Set([
  'https://github.com/mike007jd/InkMarshal',
  'https://github.com/mike007jd/InkMarshal/issues/new',
]);

export function normalizeAllowedExternalUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('External links must use HTTPS');
  }
  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString().replace(/\/$/, '');
  if (!ALLOWED_EXTERNAL_URLS.has(normalized)) {
    throw new Error('External link is not allowed');
  }
  return normalized;
}

/**
 * Open a product-owned external URL in the user's default browser.
 *
 * Desktop (Tauri): the `@tauri-apps/plugin-shell` `open` capability. Web
 * fallback: `window.open` with `noopener`. Keep this helper allowlisted because
 * the OS open surface must not accept user-controlled URLs or local paths.
 */
export async function openExternal(url: string): Promise<void> {
  const target = normalizeAllowedExternalUrl(url);
  if (isTauriRuntime()) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(target);
    return;
  }
  if (typeof window !== 'undefined') {
    window.open(target, '_blank', 'noopener');
  }
}
