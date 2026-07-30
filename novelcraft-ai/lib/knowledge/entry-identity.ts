export function normalizeKnowledgeEntryTitle(title: string): string {
  return title.trim().normalize('NFC').toLowerCase();
}

export function knowledgeEntryIdentityKey(entry: { type: string; title: string }): string {
  return `${entry.type}:${normalizeKnowledgeEntryTitle(entry.title)}`;
}
