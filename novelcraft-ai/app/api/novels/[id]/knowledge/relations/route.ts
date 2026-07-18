import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { getKnowledgeRelationsByNovel } from '@/lib/db';
import { parseKnowledgeRelation } from '@/lib/knowledge';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: novelId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const relations = await getKnowledgeRelationsByNovel(novelId);
  const result = relations.map(r => parseKnowledgeRelation(r as unknown as Record<string, unknown>));
  return NextResponse.json(result);
}
