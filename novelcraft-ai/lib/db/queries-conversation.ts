import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db/connection';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';

export interface ConversationRow {
  id: string;
  novel_id: string;
  user_id: string;
  topic: string;
  title: string;
  parent_message_id: string | null;
  is_archived: number;
  created_at: string;
  updated_at: string;
}

interface ConversationParentRow {
  id: string;
  parent_message_id: string | null;
}

interface MessageConversationRow {
  id: string;
  conversation_id: string | null;
}

function collectConversationDeleteSubtree(
  db: Database.Database,
  rootId: string,
  novelId: string,
  userId: string,
): string[] {
  const conversations = db
    .prepare('SELECT id, parent_message_id FROM conversations WHERE novel_id = ? AND user_id = ?')
    .all(novelId, userId) as ConversationParentRow[];
  if (!conversations.some(conversation => conversation.id === rootId)) return [];

  const messages = db
    .prepare(
      `SELECT id, conversation_id
         FROM messages
        WHERE novel_id = ?
          AND conversation_id IS NOT NULL`,
    )
    .all(novelId) as MessageConversationRow[];

  const messageConversation = new Map<string, string>();
  for (const message of messages) {
    if (message.conversation_id) messageConversation.set(message.id, message.conversation_id);
  }

  const childrenByConversation = new Map<string, string[]>();
  for (const conversation of conversations) {
    if (!conversation.parent_message_id) continue;
    const parentConversationId = messageConversation.get(conversation.parent_message_id);
    if (!parentConversationId) continue;
    const children = childrenByConversation.get(parentConversationId) ?? [];
    children.push(conversation.id);
    childrenByConversation.set(parentConversationId, children);
  }

  const toDelete = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const conversationId = queue.shift()!;
    if (toDelete.has(conversationId)) continue;
    toDelete.add(conversationId);
    for (const childId of childrenByConversation.get(conversationId) ?? []) {
      queue.push(childId);
    }
  }

  return Array.from(toDelete);
}

export async function getConversations(novelId: string, userId: string): Promise<ConversationRow[]> {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM conversations WHERE novel_id = ? AND user_id = ? ORDER BY updated_at DESC',
    )
    .all(novelId, userId) as ConversationRow[];
}

export async function getConversation(
  id: string,
  novelId: string,
  userId: string,
): Promise<ConversationRow | undefined> {
  const db = getDb();
  return db
    .prepare('SELECT * FROM conversations WHERE id = ? AND novel_id = ? AND user_id = ?')
    .get(id, novelId, userId) as ConversationRow | undefined;
}

export async function getConversationById(id: string): Promise<ConversationRow | undefined> {
  const db = getDb();
  return db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(id) as ConversationRow | undefined;
}

export async function createConversation(data: {
  id: string;
  novelId: string;
  userId: string;
  topic: string;
  title: string;
  parentMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}): Promise<ConversationRow> {
  const db = getDb();
  db.prepare(
    `INSERT INTO conversations (id, novel_id, user_id, topic, title, parent_message_id, is_archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    data.id,
    data.novelId,
    data.userId,
    data.topic,
    data.title,
    data.parentMessageId ?? null,
    data.createdAt,
    data.updatedAt,
  );
  touchNovelUpdatedAt(db, data.novelId);
  return db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(data.id) as ConversationRow;
}

export async function updateConversation(
  id: string,
  novelId: string,
  userId: string,
  fields: { title?: string; isArchived?: boolean; updatedAt: string },
): Promise<void> {
  const db = getDb();
  const setParts: string[] = ['updated_at = ?'];
  const values: unknown[] = [fields.updatedAt];

  if (fields.title !== undefined) {
    setParts.push('title = ?');
    values.push(fields.title);
  }
  if (fields.isArchived !== undefined) {
    setParts.push('is_archived = ?');
    values.push(fields.isArchived ? 1 : 0);
  }

  values.push(id, novelId, userId);
  const info = db.prepare(
    `UPDATE conversations SET ${setParts.join(', ')} WHERE id = ? AND novel_id = ? AND user_id = ?`,
  ).run(...values);
  if (info.changes > 0) touchNovelUpdatedAt(db, novelId);
}

export async function deleteConversation(id: string, novelId: string, userId: string): Promise<void> {
  const db = getDb();
  let deletedConversation = 0;
  const tx = db.transaction(() => {
    const conversationIds = collectConversationDeleteSubtree(db, id, novelId, userId);
    if (conversationIds.length === 0) return;

    for (const conversationId of conversationIds) {
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId);
    }
    for (const conversationId of conversationIds) {
      const info = db.prepare('DELETE FROM conversations WHERE id = ? AND novel_id = ? AND user_id = ?').run(
        conversationId,
        novelId,
        userId,
      );
      deletedConversation += info.changes;
    }
    if (deletedConversation > 0) touchNovelUpdatedAt(db, novelId);
  });
  tx();
}

export async function getAllConversationsForNovel(
  novelId: string,
  userId?: string,
): Promise<{ id: string; parent_message_id: string | null }[]> {
  const db = getDb();
  if (userId) {
    return db
      .prepare('SELECT id, parent_message_id FROM conversations WHERE novel_id = ? AND user_id = ?')
      .all(novelId, userId) as { id: string; parent_message_id: string | null }[];
  }
  return db
    .prepare('SELECT id, parent_message_id FROM conversations WHERE novel_id = ?')
    .all(novelId) as { id: string; parent_message_id: string | null }[];
}

/**
 * Fetch all (non-archived) conversations for a novel including topic + title +
 * timestamps. Used by buildAIContext to pick the most-recent conversation per
 * topic when injecting prior-discussion context into a writing/chat prompt.
 * Ownership check is the caller's responsibility (call sites are already inside
 * `requireNovelOwner`).
 */
export async function getConversationsWithTopicForNovel(
  novelId: string,
  userId?: string,
): Promise<ConversationRow[]> {
  const db = getDb();
  if (userId) {
    return db
      .prepare(
        `SELECT * FROM conversations
          WHERE novel_id = ? AND user_id = ? AND COALESCE(is_archived, 0) = 0
          ORDER BY updated_at DESC`,
      )
      .all(novelId, userId) as ConversationRow[];
  }
  return db
    .prepare(
      `SELECT * FROM conversations
        WHERE novel_id = ? AND COALESCE(is_archived, 0) = 0
        ORDER BY updated_at DESC`,
    )
    .all(novelId) as ConversationRow[];
}

interface NovelMessageRow {
  id: string;
  novel_id: string;
  role: string;
  content: string;
  created_at: string;
  conversation_id: string | null;
}

export async function getMessagesForNovel(novelId: string, userId?: string): Promise<NovelMessageRow[]> {
  const db = getDb();
  if (userId) {
    return db
      .prepare(
        `SELECT m.id, m.novel_id, m.role, m.content, m.created_at, m.conversation_id
           FROM messages m
           JOIN conversations c
             ON c.id = m.conversation_id
            AND c.novel_id = m.novel_id
          WHERE m.novel_id = ?
            AND c.user_id = ?
          ORDER BY m.created_at ASC, m.rowid ASC`,
      )
      .all(novelId, userId) as NovelMessageRow[];
  }
  return db
    .prepare(
      'SELECT id, novel_id, role, content, created_at, conversation_id FROM messages WHERE novel_id = ? ORDER BY created_at ASC, rowid ASC',
    )
    .all(novelId) as NovelMessageRow[];
}

interface LatestTopicAssistantMessageRow {
  topic: string;
  title: string;
  id: string;
  novel_id: string;
  role: string;
  content: string;
  created_at: string;
  conversation_id: string;
}

export async function getLatestConversationAssistantMessagesForTopics(
  novelId: string,
  opts: { userId?: string; topics?: string[]; perConvMessages: number },
): Promise<LatestTopicAssistantMessageRow[]> {
  const db = getDb();
  if (opts.topics && opts.topics.length === 0) return [];

  const values: unknown[] = [];
  const conversationFilters = ['novel_id = ?', 'COALESCE(is_archived, 0) = 0'];
  values.push(novelId);
  if (opts.userId) {
    conversationFilters.push('user_id = ?');
    values.push(opts.userId);
  }
  if (opts.topics) {
    conversationFilters.push(`topic IN (${opts.topics.map(() => '?').join(',')})`);
    values.push(...opts.topics);
  }
  values.push(novelId, opts.perConvMessages);

  return db
    .prepare(
      `WITH ranked_conversations AS (
         SELECT id, topic, title, updated_at,
                row_number() OVER (
                  PARTITION BY topic
                  ORDER BY updated_at DESC, created_at DESC, id DESC
                ) AS topic_rank
           FROM conversations
          WHERE ${conversationFilters.join(' AND ')}
       ),
       chosen_conversations AS (
         SELECT id, topic, title, updated_at
           FROM ranked_conversations
          WHERE topic_rank = 1
       ),
       ranked_messages AS (
         SELECT c.topic,
                c.title,
                c.updated_at AS conversation_updated_at,
                m.id,
                m.novel_id,
                m.role,
                m.content,
                m.created_at,
                m.rowid AS message_rowid,
                m.conversation_id,
                row_number() OVER (
                  PARTITION BY m.conversation_id
                  ORDER BY m.created_at DESC, m.rowid DESC
                ) AS message_rank
           FROM chosen_conversations c
           JOIN messages m
             ON m.conversation_id = c.id
            AND m.novel_id = ?
          WHERE m.role = 'assistant'
       )
       SELECT topic, title, id, novel_id, role, content, created_at, conversation_id
         FROM ranked_messages
        WHERE message_rank <= ?
        ORDER BY conversation_updated_at DESC, created_at ASC, message_rowid ASC`,
    )
    .all(...values) as LatestTopicAssistantMessageRow[];
}

export async function verifyParentMessageBelongsToNovelLocal(
  parentMessageId: string | null,
  novelId: string,
  userId?: string,
): Promise<boolean> {
  if (!parentMessageId) return true;
  const db = getDb();
  if (userId) {
    const row = db
      .prepare(
        `SELECT m.id
           FROM messages m
           JOIN conversations c
             ON c.id = m.conversation_id
            AND c.novel_id = m.novel_id
          WHERE m.id = ?
            AND m.novel_id = ?
            AND c.user_id = ?
          LIMIT 1`,
      )
      .get(parentMessageId, novelId, userId);
    return Boolean(row);
  }
  const row = db
    .prepare(
      `SELECT m.id
         FROM messages m
         JOIN conversations c
           ON c.id = m.conversation_id
          AND c.novel_id = m.novel_id
        WHERE m.id = ?
          AND m.novel_id = ?
        LIMIT 1`,
    )
    .get(parentMessageId, novelId);
  return Boolean(row);
}
