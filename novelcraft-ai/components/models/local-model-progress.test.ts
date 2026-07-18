import { describe, expect, it } from 'vitest';

import {
  downloadCancelledProgress,
  downloadFailedProgress,
  downloadReadyProgress,
  downloadStartedProgress,
  progressFromDownloadEvent,
  type DownloadProgressLabels,
} from '@/components/models/local-model-progress';

const labels: DownloadProgressLabels = {
  downloading: 'Downloading',
  verifying: 'Verifying',
  failed: 'Failed',
  cancelled: 'Cancelled',
  ready: 'Ready',
};

describe('local model download progress mapping', () => {
  it('creates stable lifecycle progress objects', () => {
    expect(downloadStartedProgress(labels, 'task-a')).toEqual({
      state: 'downloading',
      percent: 0,
      label: 'Downloading',
      cancelTaskId: 'task-a',
    });
    expect(downloadCancelledProgress(labels, 'task-a')).toEqual({
      state: 'cancelled',
      percent: null,
      label: 'Cancelled',
      cancelTaskId: 'task-a',
    });
    expect(downloadReadyProgress(labels, 'task-a', '/models/a.gguf')).toEqual({
      state: 'ready',
      percent: 100,
      label: 'Ready',
      modelPath: '/models/a.gguf',
      cancelTaskId: 'task-a',
    });
    expect(downloadFailedProgress(labels, 'no space')).toEqual({
      state: 'failed',
      percent: null,
      label: 'Failed',
      error: 'no space',
      cancelTaskId: undefined,
    });
  });

  it('maps native download events to UI progress', () => {
    expect(progressFromDownloadEvent({
      progress: { phase: 'downloading', receivedBytes: 50, totalBytes: 200 },
      taskId: 'task-a',
      labels,
      cancelled: false,
    })).toMatchObject({
      state: 'downloading',
      percent: 25,
      label: 'Downloading',
      cancelTaskId: 'task-a',
    });

    expect(progressFromDownloadEvent({
      progress: { phase: 'verifying', receivedBytes: 200, totalBytes: 200 },
      taskId: 'task-a',
      labels,
      cancelled: false,
    })).toMatchObject({
      state: 'verifying',
      percent: 100,
      label: 'Verifying',
    });

    expect(progressFromDownloadEvent({
      progress: { phase: 'error', receivedBytes: 0, totalBytes: 0, message: 'boom' },
      taskId: 'task-a',
      labels,
      cancelled: false,
    })).toMatchObject({
      state: 'failed',
      percent: null,
      label: 'Failed',
      error: 'boom',
    });
  });

  it('preserves user cancellation over late native errors', () => {
    expect(progressFromDownloadEvent({
      progress: { phase: 'error', receivedBytes: 0, totalBytes: 100, message: 'cancelled upstream' },
      taskId: 'task-a',
      labels,
      cancelled: true,
    })).toEqual({
      state: 'cancelled',
      percent: null,
      label: 'Cancelled',
      cancelTaskId: 'task-a',
    });
  });
});
