import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { getConversation } from '@/lib/db';
import { parseConversation } from '@/lib/conversations';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id: novelId, convId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const row = await getConversation(convId, novelId, ownerCheck.user.id);
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(parseConversation(row as unknown as Record<string, unknown>));
}
