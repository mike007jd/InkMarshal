import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { getKnowledgeEntry, getKnowledgeEntryIdsByNovel, getKnowledgeRelationsByEntry } from '@/lib/db';
import { parseKnowledgeEntry, parseKnowledgeRelation } from '@/lib/knowledge';
import { isUuid } from '@/lib/utils';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id: novelId, entryId } = await params;
  if (!isUuid(entryId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const entryRow = await getKnowledgeEntry(entryId, novelId);
  if (!entryRow) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const entry = parseKnowledgeEntry(entryRow as unknown as Record<string, unknown>);

  // Pull relations whose endpoints both belong to this novel — defends against
  // legacy/seed rows that predate the same-novel trigger and would otherwise
  // leak counter-party entry ids across novels.
  const novelEntryIds = new Set(await getKnowledgeEntryIdsByNovel(novelId));

  const relRows = await getKnowledgeRelationsByEntry(entryId);
  const relations = relRows
    .filter(r => novelEntryIds.has(r.source_id) && novelEntryIds.has(r.target_id))
    .map(r => parseKnowledgeRelation(r as unknown as Record<string, unknown>));

  return NextResponse.json({ ...entry, relations });
}
