import type { StringKey } from '@/lib/i18n';
import type { KnowledgeEntry, KnowledgeType } from '@/lib/types/knowledge';

export type KnowledgeFilterTab = 'all' | KnowledgeType;

const MAX_KNOWLEDGE_SEARCH_LENGTH = 100;

export const KNOWLEDGE_FILTER_TABS: Array<{ key: KnowledgeFilterTab; labelKey: StringKey }> = [
  { key: 'all', labelKey: 'knowledgeTabAll' },
  { key: 'character', labelKey: 'knowledgeTabCharacters' },
  { key: 'world', labelKey: 'knowledgeTabWorld' },
  { key: 'timeline', labelKey: 'knowledgeTabTimeline' },
  { key: 'outline', labelKey: 'knowledgeTabOutline' },
  { key: 'style_reference', labelKey: 'knowledgeTabStyle' },
];

export function normalizeKnowledgeSearchQuery(value: string | null | undefined): string | undefined {
  const clean = (value ?? '').trim().slice(0, MAX_KNOWLEDGE_SEARCH_LENGTH);
  return clean || undefined;
}

export function knowledgeListQuery(options: {
  filter: KnowledgeFilterTab;
  search?: string | null;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (options.filter !== 'all') params.set('type', options.filter);
  const search = normalizeKnowledgeSearchQuery(options.search);
  if (search) params.set('q', search);
  return params;
}

export function buildKnowledgeEntriesUrl(
  novelId: string,
  options: { filter: KnowledgeFilterTab; search?: string | null },
): string {
  const query = knowledgeListQuery(options).toString();
  const base = `/api/novels/${encodeURIComponent(novelId)}/knowledge`;
  return query ? `${base}?${query}` : base;
}

export function parseKnowledgeListRequest(url: URL): { type?: string; search?: string } {
  return {
    type: url.searchParams.get('type') ?? undefined,
    search: normalizeKnowledgeSearchQuery(url.searchParams.get('q')),
  };
}

export function summarizeKnowledgeEntryPreview(entry: KnowledgeEntry, maxLength = 80): string {
  const data = entry.data;
  let text = '';

  if ('description' in data && data.description) {
    text = String(data.description);
  } else if ('synopsis' in data && data.synopsis) {
    text = String(data.synopsis);
  } else if ('sampleText' in data && data.sampleText) {
    text = String(data.sampleText);
  } else if ('styleNotes' in data && data.styleNotes) {
    text = String(data.styleNotes);
  }

  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}
