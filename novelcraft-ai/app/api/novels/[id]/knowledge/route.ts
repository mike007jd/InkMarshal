import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { getKnowledgeEntries } from '@/lib/db';
import { parseKnowledgeEntry } from '@/lib/knowledge';
import { parseKnowledgeListRequest } from '@/lib/knowledge-workspace';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: novelId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const { type, search } = parseKnowledgeListRequest(new URL(req.url));

  const rows = await getKnowledgeEntries(novelId, { type, search });
  const entries = rows.map(row => parseKnowledgeEntry(row as unknown as Record<string, unknown>));

  return NextResponse.json(entries);
}
