export function knowledgeRelationEndpointsMatch(
  source: { novel_id?: string | null; novelId?: string | null } | null | undefined,
  target: { novel_id?: string | null; novelId?: string | null } | null | undefined,
): boolean {
  if (!source || !target) return false;
  const sourceNovelId = source.novel_id ?? source.novelId;
  const targetNovelId = target.novel_id ?? target.novelId;
  return Boolean(sourceNovelId) && sourceNovelId === targetNovelId;
}
