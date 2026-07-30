import { describe, expect, it } from 'vitest';
import {
  buildPreviewChapters,
  mergePreviewUp,
  segmentFromCandidate,
  splitPreviewAt,
} from '@/lib/import/preview';
import { reconstructChaptersFromParts } from '@/lib/import/reconstruct';

describe('import preview edit ops', () => {
  it('merge and split keep parts that reconstruct to the original prose', () => {
    const segments = [
      segmentFromCandidate({
        id: 'seg-1',
        title: 'One',
        volumeTitle: null,
        content: 'Alpha\n\nBeta',
        wordCount: 2,
        inferred: false,
      }),
      segmentFromCandidate({
        id: 'seg-2',
        title: 'Two',
        volumeTitle: null,
        content: 'Gamma',
        wordCount: 1,
        inferred: false,
      }),
    ];
    let chapters = buildPreviewChapters(segments);
    chapters = mergePreviewUp(chapters, 1);
    expect(chapters).toHaveLength(1);
    expect(reconstructChaptersFromParts(segments, chapters.map(c => ({
      title: c.title,
      parts: c.parts,
    })))[0]!.content).toBe('Alpha\n\nBeta\n\nGamma');

    chapters = splitPreviewAt(chapters, 0, 1);
    expect(chapters).toHaveLength(2);
    const rebuilt = reconstructChaptersFromParts(
      segments,
      chapters.map(c => ({ title: c.title, parts: c.parts })),
    );
    expect(rebuilt.map(c => c.content)).toEqual(['Alpha', 'Beta\n\nGamma']);
  });
});
