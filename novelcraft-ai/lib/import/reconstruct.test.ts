import { describe, expect, it } from 'vitest';
import { reconstructChaptersFromParts } from '@/lib/import/reconstruct';
import type { StoredImportSegment } from '@/lib/import/session-store';

const segments: StoredImportSegment[] = [
  {
    id: 'seg-1',
    title: 'One',
    volumeTitle: null,
    paragraphs: ['Alpha para', 'Beta para'],
    wordCount: 4,
    inferred: false,
  },
  {
    id: 'seg-2',
    title: 'Two',
    volumeTitle: null,
    paragraphs: ['Gamma para'],
    wordCount: 2,
    inferred: false,
  },
];

describe('reconstructChaptersFromParts', () => {
  it('reconstructs exact prose from full-coverage parts', () => {
    const chapters = reconstructChaptersFromParts(segments, [
      { title: 'One', parts: [{ segmentId: 'seg-1', fromParagraph: 0, toParagraph: 2 }] },
      { title: 'Two', parts: [{ segmentId: 'seg-2', fromParagraph: 0, toParagraph: 1 }] },
    ]);
    expect(chapters).toEqual([
      { chapterNumber: 1, title: 'One', content: 'Alpha para\n\nBeta para' },
      { chapterNumber: 2, title: 'Two', content: 'Gamma para' },
    ]);
  });

  it('supports merge and split via parts while preserving exact prose', () => {
    const merged = reconstructChaptersFromParts(segments, [
      {
        title: 'Merged',
        parts: [
          { segmentId: 'seg-1', fromParagraph: 0, toParagraph: 2 },
          { segmentId: 'seg-2', fromParagraph: 0, toParagraph: 1 },
        ],
      },
    ]);
    expect(merged[0]!.content).toBe('Alpha para\n\nBeta para\n\nGamma para');

    const split = reconstructChaptersFromParts(segments, [
      { title: 'A', parts: [{ segmentId: 'seg-1', fromParagraph: 0, toParagraph: 1 }] },
      { title: 'B', parts: [{ segmentId: 'seg-1', fromParagraph: 1, toParagraph: 2 }] },
      { title: 'C', parts: [{ segmentId: 'seg-2', fromParagraph: 0, toParagraph: 1 }] },
    ]);
    expect(split.map(c => c.content)).toEqual(['Alpha para', 'Beta para', 'Gamma para']);
  });

  it('rejects unknown segments, overlaps, reordering, and incomplete coverage', () => {
    expect(() => reconstructChaptersFromParts(segments, [
      { title: 'X', parts: [{ segmentId: 'nope', fromParagraph: 0, toParagraph: 1 }] },
    ])).toThrow(/unknown segment/);

    expect(() => reconstructChaptersFromParts(segments, [
      { title: 'A', parts: [{ segmentId: 'seg-1', fromParagraph: 0, toParagraph: 2 }] },
      { title: 'B', parts: [{ segmentId: 'seg-1', fromParagraph: 0, toParagraph: 1 }] },
      { title: 'C', parts: [{ segmentId: 'seg-2', fromParagraph: 0, toParagraph: 1 }] },
    ])).toThrow(/original order/);

    expect(() => reconstructChaptersFromParts(segments, [
      { title: 'A', parts: [{ segmentId: 'seg-1', fromParagraph: 0, toParagraph: 1 }] },
    ])).toThrow(/full manuscript/);

    expect(() => reconstructChaptersFromParts(segments, [
      { title: 'Two first', parts: [{ segmentId: 'seg-2', fromParagraph: 0, toParagraph: 1 }] },
      { title: 'One second', parts: [{ segmentId: 'seg-1', fromParagraph: 0, toParagraph: 2 }] },
    ])).toThrow(/original order/);
  });
});
