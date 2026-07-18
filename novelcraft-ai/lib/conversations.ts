import type { Conversation } from '@/lib/types/conversation';
import {
  getAllConversationsForNovel,
  getLatestConversationAssistantMessagesForTopics,
  getMessagesForNovel,
  getConversationById,
  verifyParentMessageBelongsToNovelLocal,
} from '@/lib/db';
import { parseTimestamp } from '@/lib/utils';

export function parseConversation(row: Record<string, unknown>): Conversation {
  const id = row.id as string;
  const novelId = (row.novel_id ?? row.novelId) as string;
  const userId = (row.user_id ?? row.userId) as string;
  const topic = (row.topic as string) || 'general';
  const title = row.title as string;
  const parentMessageId = ((row.parent_message_id ?? row.parentMessageId) as string) || null;

  const archiveVal = row.is_archived ?? row.isArchived;
  const isArchived =
    typeof archiveVal === 'boolean' ? archiveVal :
    typeof archiveVal === 'number' ? archiveVal === 1 :
    false;

  return {
    id,
    novelId,
    userId,
    topic,
    title,
    parentMessageId,
    isArchived,
    createdAt: parseTimestamp(row.created_at ?? row.createdAt),
    updatedAt: parseTimestamp(row.updated_at ?? row.updatedAt),
  };
}

/** Matches the messages table schema exactly. */
export interface MinimalMessage {
  id: string;
  novelId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  conversationId: string | null;
}

interface MinimalConversation {
  id: string;
  parentMessageId: string | null;
}

export function conversationMatchesNovelAndUser(
  row: { novel_id?: string | null; novelId?: string | null; user_id?: string | null; userId?: string | null } | null | undefined,
  novelId: string,
  userId: string,
): boolean {
  if (!row) return false;
  return (row.novel_id ?? row.novelId) === novelId
    && (row.user_id ?? row.userId) === userId;
}

export async function verifyConversationOwnership(
  conversationId: string,
  novelId: string,
  userId: string,
): Promise<boolean> {
  const conv = await getConversationById(conversationId);
  return conversationMatchesNovelAndUser(conv, novelId, userId);
}

export async function verifyParentMessageBelongsToNovel(
  parentMessageId: string | null,
  novelId: string,
  userId?: string,
): Promise<boolean> {
  return verifyParentMessageBelongsToNovelLocal(parentMessageId, novelId, userId);
}

/**
 * Resolve the full message chain for a conversation, including forked parent messages.
 * Walks up the fork chain collecting parent messages up to each fork point,
 * then appends the target conversation's own messages.
 */
export function resolveForkedMessageChain(
  conversationId: string,
  conversations: MinimalConversation[],
  messagesByConv: Record<string, MinimalMessage[]>,
  maxDepth: number = 50
): MinimalMessage[] {
  const convMap = new Map(conversations.map(c => [c.id, c]));

  function ownMessagesUpTo(convId: string, messageId: string | null): MinimalMessage[] {
    const msgs = messagesByConv[convId] || [];
    if (!messageId) return msgs;
    const forkIdx = msgs.findIndex(m => m.id === messageId);
    return forkIdx >= 0 ? msgs.slice(0, forkIdx + 1) : [];
  }

  function collect(convId: string, includeUpToMessageId: string | null, depth: number): MinimalMessage[] {
    if (depth >= maxDepth) {
      console.warn(
        `[conversations] fork chain for ${conversationId} truncated at depth ${maxDepth}; ancestor ${convId} and earlier were dropped`,
      );
      return [];
    }

    const conv = convMap.get(convId);
    if (!conv) return [];

    const ownSegment = ownMessagesUpTo(convId, includeUpToMessageId);
    if (!conv.parentMessageId) return ownSegment;

    const parentConvId = findConversationForMessage(conv.parentMessageId, conversations, messagesByConv);
    if (!parentConvId) return ownSegment;

    return [
      ...collect(parentConvId, conv.parentMessageId, depth + 1),
      ...ownSegment,
    ];
  }

  const seen = new Set<string>();
  const result: MinimalMessage[] = [];
  for (const msg of collect(conversationId, null, 0)) {
    if (!seen.has(msg.id)) {
      seen.add(msg.id);
      result.push(msg);
    }
  }

  return result;
}

/**
 * Fetch all conversations + messages for a novel, then resolve the forked message chain
 * for the given conversationId. Eliminates the N+1 query pattern duplicated across routes.
 */
export async function resolveFullMessageChain(
  novelId: string,
  conversationId: string,
  userId: string,
): Promise<MinimalMessage[]> {
  const [convRows, msgRows] = await Promise.all([
    getAllConversationsForNovel(novelId, userId),
    getMessagesForNovel(novelId, userId),
  ]);

  const conversations = convRows.map(r => ({
    id: r.id,
    parentMessageId: r.parent_message_id || null,
  }));

  // Group messages by conversationId in memory
  const messagesByConv: Record<string, MinimalMessage[]> = {};
  for (const row of msgRows) {
    const msg: MinimalMessage = {
      id: row.id,
      novelId: row.novel_id,
      role: row.role as MinimalMessage['role'],
      content: row.content,
      createdAt: parseTimestamp(row.created_at),
      conversationId: row.conversation_id || null,
    };
    if (!msg.conversationId) continue;
    (messagesByConv[msg.conversationId] ??= []).push(msg);
  }

  return resolveForkedMessageChain(conversationId, conversations, messagesByConv);
}

function findConversationForMessage(
  messageId: string,
  conversations: MinimalConversation[],
  messagesByConv: Record<string, MinimalMessage[]>
): string | null {
  for (const conv of conversations) {
    const msgs = messagesByConv[conv.id];
    if (msgs?.some(m => m.id === messageId)) return conv.id;
  }
  return null;
}

// ── Conversation digest for AI context injection ───────────────────────────

export interface ConversationDigestOpts {
  /** Scope digest to the already-authorized local user. */
  userId?: string;
  /** Restrict to these conversation topics; default = all non-empty topics. */
  topics?: string[];
  /** Hard cap on total characters emitted (across all topics). */
  maxChars: number;
  /** How many recent assistant messages per conversation to summarise. Default 3. */
  perConvMessages?: number;
  /** Hard cap per message snippet. Default 200. */
  perMessageChars?: number;
}

/**
 * Compress prior conversations into a tight text block for AI prompt injection.
 *
 * Strategy (deterministic, no LLM call):
 * 1. For each requested topic, pick the single most-recently-updated
 *    non-archived conversation.
 * 2. From that conversation take the last N assistant messages (default 3),
 *    chronological order, head-truncated to perMessageChars (default 200).
 * 3. Stop once maxChars is hit. Topics with no recent assistant message are
 *    silently skipped — they contribute nothing to the prompt.
 *
 * Returns '' when there's nothing to inject (no conversations, no assistant
 * messages, or maxChars=0). Caller decides whether to render a header.
 */
export async function summarizeConversationsForContext(
  novelId: string,
  opts: ConversationDigestOpts,
): Promise<string> {
  const { topics, userId, maxChars, perConvMessages = 3, perMessageChars = 200 } = opts;
  if (maxChars <= 0) return '';

  const rows = await getLatestConversationAssistantMessagesForTopics(novelId, {
    userId,
    topics,
    perConvMessages,
  });
  if (rows.length === 0) return '';

  const chosen = new Map<string, { topic: string; title: string; messages: MinimalMessage[] }>();
  for (const row of rows) {
    const conv = chosen.get(row.conversation_id) ?? {
      topic: row.topic,
      title: row.title,
      messages: [],
    };
    conv.messages.push({
      id: row.id,
      novelId: row.novel_id,
      role: row.role as MinimalMessage['role'],
      content: row.content,
      createdAt: parseTimestamp(row.created_at),
      conversationId: row.conversation_id,
    });
    chosen.set(row.conversation_id, conv);
  }

  const blocks: string[] = [];
  let used = 0;
  for (const conv of chosen.values()) {
    const lines: string[] = [`[${conv.topic}] ${conv.title}`];
    for (const m of conv.messages) {
      // Keep the TAIL, not the head: these are assistant turns and the
      // decision/conclusion lands at the end — a head cut keeps "Let me think
      // about…" and drops the actual payload.
      const snip = m.content.length > perMessageChars
        ? `…${m.content.slice(-perMessageChars)}`
        : m.content;
      lines.push(`- ${snip}`);
    }
    const block = lines.join('\n');
    if (used + block.length + 1 > maxChars) {
      // Try a head-truncated version of this block before giving up.
      const remaining = maxChars - used - 1;
      if (remaining > 40) {
        blocks.push(`${block.slice(0, remaining)}…`);
        used = maxChars;
      }
      break;
    }
    blocks.push(block);
    used += block.length + 1;
  }
  return blocks.join('\n\n');
}
