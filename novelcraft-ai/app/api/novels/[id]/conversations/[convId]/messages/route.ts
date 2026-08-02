import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { resolveFullMessageChain, verifyConversationOwnership } from '@/lib/conversations';
import { CHAT_TURN_STATUS_HEADER } from '@/lib/chat-turn-recovery';
import {
  resolveChatTurnRecoveryStatus,
  resolveLatestChatTurnRecoveryStatus,
} from '@/lib/chat-turn-recovery.server';

export async function GET(req: Request, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id: novelId, convId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  if (!(await verifyConversationOwnership(convId, novelId, ownerCheck.user.id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const messages = await resolveFullMessageChain(novelId, convId, ownerCheck.user.id);
  const pendingTurnId = new URL(req.url).searchParams.get('pendingTurnId');
  const turnStatus = pendingTurnId && pendingTurnId.length <= 128
    ? resolveChatTurnRecoveryStatus(novelId, pendingTurnId, messages)
    : resolveLatestChatTurnRecoveryStatus(novelId, messages);
  return NextResponse.json(messages, turnStatus ? {
    headers: { [CHAT_TURN_STATUS_HEADER]: turnStatus },
  } : undefined);
}
