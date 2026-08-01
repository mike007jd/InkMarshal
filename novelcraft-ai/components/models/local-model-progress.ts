import type { ModelProgress } from '@/lib/model-download-progress';
import type { DownloadProgress } from '@/lib/model-supply/types';

export interface DownloadProgressLabels {
  downloading: string;
  verifying: string;
  paused: string;
  failed: string;
  cancelled: string;
  ready: string;
}

export function downloadStartedProgress(
  labels: Pick<DownloadProgressLabels, 'downloading'>,
  taskId: string,
): ModelProgress {
  return {
    state: 'downloading',
    percent: 0,
    label: labels.downloading,
    cancelTaskId: taskId,
  };
}

export function downloadCancelledProgress(
  labels: Pick<DownloadProgressLabels, 'cancelled'>,
  taskId: string,
): ModelProgress {
  return {
    state: 'cancelled',
    percent: null,
    label: labels.cancelled,
    cancelTaskId: taskId,
  };
}

export function downloadPausedProgress(
  labels: Pick<DownloadProgressLabels, 'paused'>,
  taskId: string,
  percent: number | null = null,
): ModelProgress {
  return {
    state: 'paused',
    percent,
    label: labels.paused,
    cancelTaskId: taskId,
  };
}

export function downloadFailedProgress(
  labels: Pick<DownloadProgressLabels, 'failed'>,
  error: string,
  taskId?: string,
): ModelProgress {
  return {
    state: 'failed',
    percent: null,
    label: labels.failed,
    error,
    cancelTaskId: taskId,
  };
}

export function downloadReadyProgress(
  labels: Pick<DownloadProgressLabels, 'ready'>,
  taskId: string,
  modelPath: string,
): ModelProgress {
  return {
    state: 'ready',
    percent: 100,
    label: labels.ready,
    modelPath,
    cancelTaskId: taskId,
  };
}

export function progressFromDownloadEvent({
  progress,
  taskId,
  labels,
  cancelled,
  paused = false,
}: {
  progress: DownloadProgress;
  taskId: string;
  labels: Pick<DownloadProgressLabels, 'downloading' | 'verifying' | 'failed' | 'cancelled' | 'paused'>;
  cancelled: boolean;
  paused?: boolean;
}): ModelProgress {
  if (paused && progress.phase === 'error') {
    return downloadPausedProgress(labels, taskId, progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : null);
  }
  if (cancelled && progress.phase === 'error') {
    return downloadCancelledProgress(labels, taskId);
  }
  const percent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : null;
  return {
    state:
      progress.phase === 'error'
        ? 'failed'
        : progress.phase === 'verifying'
          ? 'verifying'
          : 'downloading',
    percent,
    label:
      progress.phase === 'verifying'
        ? labels.verifying
        : progress.phase === 'error'
          ? labels.failed
          : labels.downloading,
    error: progress.phase === 'error' ? progress.message : undefined,
    cancelTaskId: taskId,
  };
}
