import { describe, expect, it } from 'vitest';

import { parsePositiveIntegerParam } from '@/lib/route-params';

describe('route param parsing', () => {
  it('accepts only safe positive integer strings', () => {
    expect(parsePositiveIntegerParam('1')).toBe(1);
    expect(parsePositiveIntegerParam('0012')).toBe(12);
    expect(parsePositiveIntegerParam('0')).toBeNull();
    expect(parsePositiveIntegerParam('-1')).toBeNull();
    expect(parsePositiveIntegerParam('1abc')).toBeNull();
    expect(parsePositiveIntegerParam('1.5')).toBeNull();
    expect(parsePositiveIntegerParam('9007199254740992')).toBeNull();
  });
});
