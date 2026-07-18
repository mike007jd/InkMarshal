import { ggufDownloadTaskId } from '@/lib/model-supply/download-task';

export type DownloadState =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface ModelProgress {
  state: DownloadState;
  percent: number | null;
  label: string;
  error?: string;
  modelPath?: string;
  cancelTaskId?: string;
}

export interface InstalledDownloadTarget {
  format: 'gguf' | 'mlx';
  modelPath: string;
  sourceRepo?: string;
  sourceFilename?: string;
}

interface NormalizeProgressCopy {
  interruptedLabel: string;
  interruptedError: string;
}

const MAX_PROGRESS_ENTRIES = 100;
const MAX_KEY_LENGTH = 240;
const MAX_LABEL_LENGTH = 120;
const MAX_ERROR_LENGTH = 500;

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function cleanPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function fallbackFilenameFromPath(modelPath: string): string | null {
  return modelPath.split(/[\\/]/).pop() || null;
}

export function installedGgufDownloadTaskId(model: InstalledDownloadTarget): string | null {
  if (model.format !== 'gguf' || !model.sourceRepo) return null;
  const filename = model.sourceFilename || fallbackFilenameFromPath(model.modelPath);
  return filename ? ggufDownloadTaskId(model.sourceRepo, filename) : null;
}

/**
 * Drop stale failed/cancelled progress entries whose download target actually
 * exists on disk. Happens after an interrupted-then-completed download (the
 * Rust side finished + verified, but the app died before the 'done' frame
 * updated localStorage): without this the card shows "failed / retry" while
 * the installed list already contains the file. Returns the input object
 * unchanged (same reference) when nothing needs pruning, so callers can pass
 * the result straight to a state setter without re-render loops.
 */
export function pruneStaleDownloadFailures(
  progress: Record<string, ModelProgress>,
  installedTaskIds: ReadonlySet<string>,
): Record<string, ModelProgress> {
  let changed = false;
  const out: Record<string, ModelProgress> = {};
  for (const [key, item] of Object.entries(progress)) {
    if ((item.state === 'failed' || item.state === 'cancelled') && installedTaskIds.has(key)) {
      changed = true;
      continue;
    }
    out[key] = item;
  }
  return changed ? out : progress;
}

export function normalizeModelDownloadProgress(
  value: unknown,
  copy: NormalizeProgressCopy,
): Record<string, ModelProgress> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ModelProgress> = {};
  for (const [key, raw] of Object.entries(value).slice(0, MAX_PROGRESS_ENTRIES)) {
    const cleanKey = cleanText(key, MAX_KEY_LENGTH);
    if (!cleanKey || !raw || typeof raw !== 'object') continue;
    const item = raw as Partial<ModelProgress>;
    const state = item.state;

    if (state === 'downloading' || state === 'verifying') {
      out[cleanKey] = {
        state: 'failed',
        percent: null,
        label: copy.interruptedLabel,
        error: copy.interruptedError,
      };
      continue;
    }

    if (state !== 'failed' && state !== 'cancelled') {
      continue;
    }

    out[cleanKey] = {
      state,
      percent: cleanPercent(item.percent),
      label: cleanText(item.label, MAX_LABEL_LENGTH) ?? copy.interruptedLabel,
      error: cleanText(item.error, MAX_ERROR_LENGTH),
    };
  }
  return out;
}
