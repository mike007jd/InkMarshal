import { describe, expect, it } from 'vitest';
import { ggufDownloadTaskId, snapshotDownloadTaskId } from './download-task';

describe('model download task ids', () => {
  it('escapes repo and filename slash boundaries for GGUF downloads', () => {
    const nestedRepo = ggufDownloadTaskId('org/model', 'nested/file.gguf');
    const nestedFile = ggufDownloadTaskId('org', 'model/nested/file.gguf');

    expect(nestedRepo).toBe('hf:gguf:v2:org%2Fmodel/nested%2Ffile.gguf');
    expect(nestedRepo).not.toBe(nestedFile);
  });

  it('matches Rust percent-encoding for path-control bytes', () => {
    expect(ggufDownloadTaskId('org/model', 'weird #1%.gguf')).toBe(
      'hf:gguf:v2:org%2Fmodel/weird%20%231%25.gguf',
    );
  });

  it('keeps snapshot cancellation scoped to the repo id', () => {
    expect(snapshotDownloadTaskId('mlx-community/Qwen3.5-9B-OptiQ-4bit')).toBe(
      'mlx-community/Qwen3.5-9B-OptiQ-4bit',
    );
  });
});
