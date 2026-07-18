import { parseWikilinks } from '@/lib/vault/wikilink';
import type { OutgoingLink, RelationFrontmatter } from '@/lib/vault/types';

export function collectOutgoingLinks(input: {
  fields: Record<string, unknown>;
  text?: string;
}): OutgoingLink[] {
  const out: OutgoingLink[] = [];
  const seen = new Set<string>();

  function add(raw: unknown) {
    if (typeof raw !== 'string') return;
    const target = raw.trim();
    if (!target || seen.has(target)) return;
    seen.add(target);
    out.push({ raw: target });
  }

  for (const link of parseWikilinks(input.text || '')) add(link.raw);
  for (const value of Object.values(input.fields)) {
    if (typeof value !== 'string') continue;
    for (const link of parseWikilinks(value)) add(link.raw);
  }

  const relations = input.fields['relations'];
  if (Array.isArray(relations)) {
    for (const relation of relations as RelationFrontmatter[]) {
      add(relation?.target);
    }
  }

  const characters = input.fields['characters'];
  if (Array.isArray(characters)) {
    for (const character of characters) add(character);
  }

  return out;
}
