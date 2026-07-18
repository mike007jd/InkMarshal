import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { getConversations } from '@/lib/db';
import { parseConversation } from '@/lib/conversations';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: novelId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user } = ownerCheck;

  const rows = await getConversations(novelId, user.id);
  return NextResponse.json(rows.map(r => parseConversation(r as unknown as Record<string, unknown>)));
}
