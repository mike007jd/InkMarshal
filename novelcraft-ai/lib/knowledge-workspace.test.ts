import { describe, expect, it } from 'vitest';

import type { KnowledgeEntry } from '@/lib/types/knowledge';
import {
  buildKnowledgeEntriesUrl,
  knowledgeListQuery,
  normalizeKnowledgeSearchQuery,
  parseKnowledgeListRequest,
  summarizeKnowledgeEntryPreview,
} from '@/lib/knowledge-workspace';

function entry(data: Record<string, unknown>): KnowledgeEntry {
  return {
    id: 'entry-1',
    novelId: 'novel-1',
    type: 'character',
    title: 'Hero',
    summary: '',
    data,
    sortOrder: 0,
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  } as unknown as KnowledgeEntry;
}

describe('knowledge workspace query contract', () => {
  it('normalizes search text before client and server query use', () => {
    expect(normalizeKnowledgeSearchQuery('  dragon  ')).toBe('dragon');
    expect(normalizeKnowledgeSearchQuery('   ')).toBeUndefined();
    expect(normalizeKnowledgeSearchQuery('x'.repeat(120))).toHaveLength(100);
  });

  it('builds the same list query shape used by the panel and API route', () => {
    expect(knowledgeListQuery({ filter: 'all', search: '' }).toString()).toBe('');
    expect(knowledgeListQuery({ filter: 'world', search: ' tower ' }).toString()).toBe('type=world&q=tower');
    expect(buildKnowledgeEntriesUrl('novel 1', { filter: 'timeline', search: 'year 3' }))
      .toBe('/api/novels/novel%201/knowledge?type=timeline&q=year+3');
  });

  it('parses the API request query with the same search cap', () => {
    const parsed = parseKnowledgeListRequest(new URL(`http://local/api?type=outline&q=${'a'.repeat(110)}`));

    expect(parsed.type).toBe('outline');
    expect(parsed.search).toHaveLength(100);
  });
});

describe('knowledge workspace card preview', () => {
  it('uses the strongest human-readable field for each entry card preview', () => {
    expect(summarizeKnowledgeEntryPreview(entry({ description: 'A careful detective' }))).toBe('A careful detective');
    expect(summarizeKnowledgeEntryPreview(entry({ synopsis: 'Chapter synopsis' }))).toBe('Chapter synopsis');
    expect(summarizeKnowledgeEntryPreview(entry({ sampleText: 'Sample voice' }))).toBe('Sample voice');
    expect(summarizeKnowledgeEntryPreview(entry({ styleNotes: 'Sparse prose' }))).toBe('Sparse prose');
  });

  it('caps long previews to the card-sized text budget', () => {
    const preview = summarizeKnowledgeEntryPreview(entry({ description: 'x'.repeat(90) }));

    expect(preview).toHaveLength(83);
    expect(preview.endsWith('...')).toBe(true);
  });
});
