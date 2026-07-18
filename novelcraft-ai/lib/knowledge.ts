import type { KnowledgeEntry, KnowledgeRelation, KnowledgeType } from '@/lib/types/knowledge';
import { parseJsonField, parseTimestamp } from '@/lib/utils';

export function parseKnowledgeEntry(row: Record<string, unknown>): KnowledgeEntry {
  const novelId = (row.novel_id ?? row.novelId) as string;
  const sortOrder = (row.sort_order ?? row.sortOrder ?? 0) as number;

  // Tolerate stale/seed rows whose `data` or `tags` JSON columns may not parse
  // (or parsed to the wrong shape) — fall back to empty defaults rather than
  // crashing the request. The validators reject e.g. a `data` array.
  const data = parseJsonField<Record<string, unknown>>(
    row.data,
    {},
    v => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
  );
  const tags = parseJsonField<string[]>(row.tags, [], v => Array.isArray(v));

  return {
    id: row.id as string,
    novelId,
    type: row.type as KnowledgeType,
    title: row.title as string,
    summary: (row.summary as string) || '',
    data,
    sortOrder,
    tags,
    createdAt: parseTimestamp(row.created_at ?? row.createdAt),
    updatedAt: parseTimestamp(row.updated_at ?? row.updatedAt),
  } as KnowledgeEntry;
}

export function parseKnowledgeRelation(row: Record<string, unknown>): KnowledgeRelation {
  const sourceId = (row.source_id ?? row.sourceId) as string;
  const targetId = (row.target_id ?? row.targetId) as string;
  const relationType = (row.relation_type ?? row.relationType) as string;

  return {
    id: row.id as string,
    sourceId,
    targetId,
    relationType,
    label: (row.label as string) || '',
    createdAt: parseTimestamp(row.created_at ?? row.createdAt),
  };
}

// --- AI Summary Injection ---

export function buildSummaryInjection(entries: KnowledgeEntry[], charBudget: number = 4000): string {
  const major: KnowledgeEntry[] = [];
  const minor: KnowledgeEntry[] = [];

  for (const e of entries) {
    if (!e.summary) continue;
    const importance = (e.data as Record<string, unknown> | undefined)?.importance;
    if (importance === 'major') {
      major.push(e);
    } else {
      minor.push(e);
    }
  }

  major.sort((a, b) => b.updatedAt - a.updatedAt);
  minor.sort((a, b) => b.updatedAt - a.updatedAt);

  const lines: string[] = [];
  let used = 0;

  for (const e of [...major, ...minor]) {
    const line = `[${e.type}] ${e.title}: ${e.summary}`;
    if (used + line.length > charBudget) break;
    lines.push(line);
    used += line.length;
  }

  return lines.join('\n');
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanList(value: unknown): string {
  return Array.isArray(value)
    ? value.map(cleanText).filter(Boolean).join(', ')
    : '';
}

function cleanDetails(value: unknown): string {
  if (!value || typeof value !== 'object') return '';

  return Object.entries(value as Record<string, unknown>)
    .map(([key, detail]) => `${key}: ${cleanText(detail)}`)
    .filter(line => !line.endsWith(': '))
    .join('; ');
}

export function buildKnowledgeEntrySummary(type: KnowledgeType, data: Record<string, unknown>): string {
  let parts: string[];

  switch (type) {
    case 'character':
      parts = [cleanText(data.description), cleanText(data.motivation), cleanList(data.traits), cleanText(data.arc)];
      break;
    case 'world':
      parts = [cleanText(data.description), cleanDetails(data.details)];
      break;
    case 'timeline':
      parts = [cleanText(data.date), cleanText(data.description)];
      break;
    case 'outline':
      parts = [cleanText(data.synopsis), cleanList(data.keyEvents), cleanText(data.pov), cleanText(data.notes)];
      break;
    case 'style_reference':
      parts = [cleanText(data.styleNotes), cleanText(data.sampleText)];
      break;
    default:
      parts = [];
  }

  return parts.filter(Boolean).join('；').slice(0, 500);
}

// --- Dangling Reference Cleanup ---

export function removeDanglingRefs(data: Record<string, unknown>, deletedId: string): Record<string, unknown> {
  const cleaned = { ...data };
  for (const key of ['characterRefs', 'characters', 'chapterIds']) {
    if (Array.isArray(cleaned[key])) {
      cleaned[key] = (cleaned[key] as string[]).filter(id => id !== deletedId);
    }
  }
  return cleaned;
}
