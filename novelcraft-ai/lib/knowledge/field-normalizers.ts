export function normalizeKnowledgeStringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function normalizeKnowledgeAliases(value: unknown): string[] {
  return normalizeKnowledgeStringArray(value, 20, 100);
}

export function normalizeKnowledgeTags(value: unknown): string[] {
  return normalizeKnowledgeStringArray(value, 20, 100);
}
