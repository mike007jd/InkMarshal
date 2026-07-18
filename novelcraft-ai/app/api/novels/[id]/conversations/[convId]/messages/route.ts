import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { resolveFullMessageChain, verifyConversationOwnership } from '@/lib/conversations';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id: novelId, convId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  if (!(await verifyConversationOwnership(convId, novelId, ownerCheck.user.id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const messages = await resolveFullMessageChain(novelId, convId, ownerCheck.user.id);
  return NextResponse.json(messages);
}
