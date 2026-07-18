import { describe, expect, it } from 'vitest';

import { normalizeStyleId } from '@/lib/style-id';

describe('normalizeStyleId', () => {
  it('accepts only trimmed UUID knowledge-entry ids', () => {
    const id = '11111111-2222-4333-8444-555555555555';

    expect(normalizeStyleId(` ${id} `)).toBe(id);
    expect(normalizeStyleId('not-a-uuid')).toBeNull();
    expect(normalizeStyleId('x'.repeat(5000))).toBeNull();
    expect(normalizeStyleId(null)).toBeNull();
  });
});
