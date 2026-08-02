import 'server-only';

import { CHAT_TURN_STALE_LEASE_MS, getChatTurn } from '@/lib/db';
import { hasLegacyStoppedChatTurn } from '@/lib/db/queries-chat-turns';
import type { ChatTurnRecoveryStatus } from '@/lib/chat-turn-recovery';

interface RecoveryMessage {
  id: string;
  role: string;
  content: string;
}

/**
 * Classify the latest durable turn for reload recovery. The message list may
 * race a just-committed assistant row, so clients deliberately keep polling a
 * user-only `succeeded` response instead of treating it as a failure.
 */
export function resolveLatestChatTurnRecoveryStatus(
  novelId: string,
  messages: readonly RecoveryMessage[],
  nowMs = Date.now(),
): ChatTurnRecoveryStatus | null {
  const latestUser = messages.findLast(message => message.role === 'user');
  if (!latestUser) return null;
  return resolveChatTurnRecoveryStatus(novelId, latestUser.id, messages, nowMs);
}

/** Resolve one submitted turn even before its user message becomes visible. */
export function resolveChatTurnRecoveryStatus(
  novelId: string,
  userMessageId: string,
  messages: readonly RecoveryMessage[],
  nowMs = Date.now(),
): ChatTurnRecoveryStatus {
  const turn = getChatTurn(novelId, userMessageId);
  if (!turn) return 'missing';
  if (
    turn.status === 'running'
    && nowMs - Date.parse(turn.updatedAt) >= CHAT_TURN_STALE_LEASE_MS
  ) {
    return 'stale';
  }

  const latestMessage = messages.at(-1);
  if (
    turn.status === 'succeeded'
    && latestMessage?.role === 'assistant'
    && latestMessage.id === turn.assistantMessageId
    && latestMessage.content === turn.responseText
    && hasLegacyStoppedChatTurn(turn)
  ) {
    return 'stopped';
  }
  return turn.status;
}
