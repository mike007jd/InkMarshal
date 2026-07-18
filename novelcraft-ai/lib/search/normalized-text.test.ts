import { describe, expect, it } from 'vitest';

import { findNormalizedSearchMatch } from './normalized-text';

describe('normalized text search offsets', () => {
  it('maps expanded NFKC matches back to the original source range', () => {
    const match = findNormalizedSearchMatch('A ﬃ title', 'ffi');

    expect(match).toEqual({
      normalizedOffset: 2,
      range: { offset: 2, length: 1 },
    });
  });

  it('maps fullwidth folded matches back to the original title range', () => {
    const match = findNormalizedSearchMatch('第１章', '1');

    expect(match).toEqual({
      normalizedOffset: 1,
      range: { offset: 1, length: 1 },
    });
  });

  it('returns null for empty or missing matches', () => {
    expect(findNormalizedSearchMatch('Chapter One', '')).toBeNull();
    expect(findNormalizedSearchMatch('Chapter One', 'Two')).toBeNull();
  });
});
