// Starter-model shelf shared by `LocalModelsPanel` and the
// `StudioFirstRunWizard`. The wizard wants a tiny, hardcoded "first three"
// list ordered for an empty machine; LocalModelsPanel reuses the same list to
// keep its "Recommended for your Mac" ordering consistent with onboarding.
//
// We intentionally export both the ID list (preserving order) and a thin
// `downloadStarterModel(id, channel)` helper so the wizard can fire a download
// from inside a small UI affordance without having to duplicate the file-list
// fetch + `hf_download_gguf` / repo-snapshot wiring.

import {
  hfDownloadGguf,
  hfDownloadRepoSnapshot,
  type EngineFormat,
} from '@/lib/desktop-runtime';
import { ggufDownloadTaskId, snapshotDownloadTaskId } from '@/lib/model-supply/download-task';
import { listHfGgufFiles } from '@/lib/model-supply/hf-hub';
import { MODEL_CATALOG, recommendedForPlatform, type EnginePlatform } from '@/lib/model-supply/catalog';
import { safeRepoToDir } from '@/lib/model-supply/repo-paths';
import type {
  CuratedModelEntry,
  DownloadProgress,
  HfModelFile,
} from '@/lib/model-supply/types';

/**
 * The starter shelf shown in the first-run wizard and the LocalModelsPanel
 * recommendation strip. Order matters — the wizard renders the first three
 * top-to-bottom, and LocalModelsPanel sorts its full "Recommended" grid by
 * this index.
 *
 * Refreshed against official/Hugging Face/Ollama sources on 2026-07-03. The
 * shelf only uses catalog entries whose lifecycle is `recommended`.
 *
 *   1. qwen-3-5-4b   - smallest current zh+en starter
 *   2. qwen-3-5-9b   - balanced default writer/editor
 *   3. qwen-3-6-27b  - planning/rewrite power-user pick
 *
 * The wizard uses {@link WIZARD_STARTER_COUNT} to slice off the first
 * three — a single source of truth so adding a fourth recommendation later
 * cannot accidentally bloat the wizard.
 */
export const STARTER_MODEL_IDS: readonly string[] = [
  'qwen-3-5-4b',
  'qwen-3-5-9b',
  'qwen-3-6-27b',
] as const;

/** How many starter models the first-run wizard displays. */
export const WIZARD_STARTER_COUNT = 3;

/**
 * Return the curated catalog entries for the starter shelf in the order
 * specified by {@link STARTER_MODEL_IDS}, filtered to entries that have either
 * the preferred format or a GGUF fallback.
 *
 * Apple Silicon may expose MLX as an advanced manual format, but the starter
 * shelf only resolves to MLX after the bundled MLX engine has been verified for
 * that model architecture. Otherwise it falls back to GGUF so first-run setup
 * cannot download a model the bundled engine cannot load.
 */
export function getStarterModelDetails(
  platform: EnginePlatform,
  format: EngineFormat,
): CuratedModelEntry[] {
  const order = new Map<string, number>(
    STARTER_MODEL_IDS.map((id, idx) => [id, idx]),
  );
  return recommendedForPlatform(platform)
    .filter(entry => order.has(entry.id))
    .filter(entry => Boolean(resolveStarterFormat(entry, format)))
    .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/** Fit of a starter model against the machine's total RAM. Pure — shared by the
 * model manager (badge labels) and the first-run wizard so both surfaces use the
 * same thresholds instead of re-deriving them. */
export type StarterFitState = 'good' | 'tight' | 'bad' | 'unknown';

export function classifyStarterFit(
  entry: CuratedModelEntry,
  totalMemoryBytes: number | null | undefined,
): StarterFitState {
  if (!entry.minRamGb || !totalMemoryBytes) return 'unknown';
  const totalGb = totalMemoryBytes / 1024 ** 3;
  if (totalGb < entry.minRamGb) return 'bad';
  if (totalGb < entry.minRamGb * 1.35) return 'tight';
  return 'good';
}

/**
 * The one obvious starter to promote as "Best place to start": the most capable
 * model that still fits comfortably ('good'), else the first that at least isn't
 * a 'bad' fit, else the first entry. Single source of truth so the model manager
 * and the first-run wizard never disagree on the recommended default.
 */
export function pickPrimaryStarterId(
  entries: readonly CuratedModelEntry[],
  totalMemoryBytes: number | null | undefined,
): string | null {
  let goodId: string | null = null;
  let firstNonBadId: string | null = null;
  for (const entry of entries) {
    const state = classifyStarterFit(entry, totalMemoryBytes);
    if (state === 'good') goodId = entry.id;
    if (firstNonBadId === null && state !== 'bad') firstNonBadId = entry.id;
  }
  return goodId ?? firstNonBadId ?? entries[0]?.id ?? null;
}

export function resolveStarterFormat(
  entry: CuratedModelEntry,
  preferredFormat: EngineFormat,
): EngineFormat | null {
  if (preferredFormat === 'mlx' && entry.mlx?.repo) return 'mlx';
  if (entry.gguf?.repo) return 'gguf';
  return null;
}

/** Look up a single starter entry from the catalog by id. Throws if missing. */
export function getStarterModelById(id: string): CuratedModelEntry {
  const entry = MODEL_CATALOG.find(e => e.id === id);
  if (!entry) throw new Error(`Unknown starter model id: ${id}`);
  return entry;
}

/** Repo id chosen for a catalog entry given the active format. Returns null
 * when the entry has no repo for that format (caller should branch). */
export function repoForStarterEntry(
  entry: CuratedModelEntry,
  format: EngineFormat,
): string | null {
  if (format === 'mlx' && entry.mlx?.repo) return entry.mlx.repo;
  return entry.gguf?.repo ?? null;
}

export interface DownloadStarterModelArgs {
  /** Catalog id, must be present in {@link STARTER_MODEL_IDS}. */
  id: string;
  /** Active engine format. macOS MLX path downloads a repo snapshot;
   * GGUF path picks the recommended quant from the file list. */
  format: EngineFormat;
  /** Absolute path to the platform-managed model directory (Rust
   * `model_dir`); the helper writes inside it. */
  modelDir: string;
  /** Optional override of the file list — supplied by tests; production
   * callers omit this and let the helper fetch via `listHfGgufFiles`. */
  files?: HfModelFile[];
  /** Streamed progress events from the Rust download command. */
  onProgress: (progress: DownloadProgress) => void;
  /** Called once the concrete Rust cancel task id is known. */
  onTaskId?: (taskId: string) => void;
}

/**
 * Download a starter model to disk. Returns the final model path on success
 * (a single `.gguf` file for `gguf`, a directory for `mlx`), or `null` if
 * there was no downloadable file for the requested format.
 *
 * This is a thin wrapper around `hfDownloadGguf` / `hfDownloadRepoSnapshot`
 * that exists so the wizard can call ONE function instead of duplicating the
 * file-listing + path-resolution logic. Cancellation is handled by the caller
 * via `cancelDownload(taskId)`, using the same task-id helpers as
 * LocalModelsPanel and the Rust download registry.
 *
 * Errors propagate as-is — the caller is responsible for marking the
 * progress UI as "failed" and surfacing the message.
 */
export async function downloadStarterModel(
  args: DownloadStarterModelArgs,
): Promise<string | null> {
  const entry = getStarterModelById(args.id);
  const repo = repoForStarterEntry(entry, args.format);
  if (!repo) return null;

  const files =
    args.files ?? (await listHfGgufFiles(repo, args.format));
  if (files.length === 0) return null;

  const modelDir = args.modelDir.replace(/[\\/]$/, '');

  if (args.format === 'mlx') {
    const destDir = `${modelDir}/${safeRepoToDir(repo)}`;
    args.onTaskId?.(snapshotDownloadTaskId(repo));
    await hfDownloadRepoSnapshot(
      { repoId: repo, files, destDir },
      args.onProgress,
    );
    return destDir;
  }

  const recQuant = entry.gguf?.recommendedQuant;
  const file =
    (recQuant ? files.find(f => f.quant === recQuant) : undefined) ??
    files[0] ??
    null;
  if (!file) return null;

  const destPath = `${modelDir}/${file.filename}`;
  args.onTaskId?.(ggufDownloadTaskId(repo, file.filename));
  await hfDownloadGguf(
    {
      repoId: repo,
      filename: file.filename,
      destPath,
      expectedSha256: file.sha256,
      expectedSizeBytes: file.sizeBytes > 0 ? file.sizeBytes : undefined,
    },
    args.onProgress,
  );
  return destPath;
}
