import { describe, expect, it } from 'vitest';

import { classifyPressure } from '@/lib/token-budget';

describe('classifyPressure', () => {
  it('treats unknown context windows as over budget', () => {
    expect(classifyPressure(100, 0)).toBe('over');
    expect(classifyPressure(100, -1)).toBe('over');
  });
});
