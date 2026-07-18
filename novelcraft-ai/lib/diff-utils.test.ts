import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyChanges, locateOriginalText } from '@/lib/diff-utils';

describe('locateOriginalText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when the punctuation-normalized fallback hits the comparison cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = locateOriginalText('x'.repeat(20_000), 'yyyy');

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[diff-utils] locateOriginalText level 3 comparison cap reached',
      expect.objectContaining({
        fullTextLength: 20_000,
        originalLength: 4,
        maxComparisons: 50_000,
      }),
    );
  });

  it('re-anchors continue insertions when text before the selection changes', () => {
    const result = applyChanges('new intro\nanchor paragraph\nending', [{
      id: 'continue-1',
      original: 'anchor paragraph',
      replacement: '\n\ncontinued prose',
      status: 'accepted',
      location: { start: 0, end: 'anchor paragraph'.length },
      insertAfterOriginal: true,
    }]);

    expect(result.text).toBe('new intro\nanchor paragraph\n\ncontinued prose\nending');
    expect(result.appliedCount).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('applies the non-overlapping accepted change and reports the overlap as skipped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const text = 'abcdef';
    const result = applyChanges(text, [
      { id: 'a', original: 'abc', replacement: 'x', status: 'accepted', location: { start: 0, end: 3 } },
      { id: 'b', original: 'cde', replacement: 'y', status: 'accepted', location: { start: 2, end: 5 } },
    ]);
    // Reverse-sorted by start, 'b' (start 2) is kept; 'a' overlaps it and is dropped.
    expect(result.text).toBe('abyf');
    expect(result.appliedCount).toBe(1);
    expect(result.skipped).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[diff-utils] skipped overlapping accepted change',
      expect.objectContaining({ skipped: 'a', keptNeighbor: 'b' }),
    );
  });

  it('counts accepted changes whose original text can no longer be located as skipped', () => {
    const result = applyChanges('totally different text', [
      { id: 'gone', original: 'missing phrase', replacement: 'x', status: 'accepted', location: { start: 0, end: 14 } },
    ]);
    expect(result.text).toBe('totally different text');
    expect(result.appliedCount).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
