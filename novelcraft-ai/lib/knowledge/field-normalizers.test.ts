import { describe, expect, it } from 'vitest';

import {
  normalizeKnowledgeAliases,
  normalizeKnowledgeStringArray,
} from '@/lib/knowledge/field-normalizers';

describe('knowledge field normalizers', () => {
  it('trims, bounds, and drops empty string-array values', () => {
    expect(normalizeKnowledgeStringArray(['  A  ', '', 42, 'B'.repeat(5)], 2, 3)).toEqual([
      'A',
      'BBB',
    ]);
  });

  it('uses the shared alias bounds', () => {
    const aliases = Array.from({ length: 25 }, (_, i) => ` alias-${i} `);
    expect(normalizeKnowledgeAliases(aliases)).toHaveLength(20);
    expect(normalizeKnowledgeAliases(aliases)[0]).toBe('alias-0');
  });
});
