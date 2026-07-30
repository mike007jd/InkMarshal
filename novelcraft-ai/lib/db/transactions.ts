import type Database from 'better-sqlite3';
import { nowIso } from '@/lib/utils';
import { getDb } from '@/lib/db/connection';

export function nextNovelUpdatedAt(db: Database.Database, novelId: string): string {
  const row = db.prepare('SELECT updated_at FROM novels WHERE id = ?').get(novelId) as
    | { updated_at: string }
    | undefined;
  const previousMs = row ? Date.parse(row.updated_at) : Number.NaN;
  return new Date(Math.max(
    Date.now(),
    Number.isFinite(previousMs) ? previousMs + 1 : 0,
  )).toISOString();
}

export function touchNovelUpdatedAt(
  db: Database.Database,
  novelId: string,
): number | null {
  const updatedAt = nextNovelUpdatedAt(db, novelId);
  const result = db.prepare('UPDATE novels SET updated_at = ? WHERE id = ?')
    .run(updatedAt, novelId);
  return result.changes === 1 ? Date.parse(updatedAt) : null;
}

export interface SeedKnowledgeEntry {
  id: string;
  novel_id: string;
  type: string;
  title: string;
  summary: string;
  data: string;
  tags: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SeedConversation {
  id: string;
  novel_id: string;
  user_id: string;
  topic: string;
  title: string;
  parent_message_id: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface SeedMessage {
  id: string;
  novel_id: string;
  role: string;
  content: string;
  conversation_id: string | null;
  created_at: string;
}

export async function seedNovelData(
  knowledgeEntries: SeedKnowledgeEntry[],
  conversations: SeedConversation[],
  messages: SeedMessage[],
): Promise<void> {
  const db = getDb();
  const insertKe = db.prepare(
    `INSERT INTO knowledge_entries (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertConv = db.prepare(
    `INSERT INTO conversations (id, novel_id, user_id, topic, title, parent_message_id, is_archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const ke of knowledgeEntries) {
      insertKe.run(ke.id, ke.novel_id, ke.type, ke.title, ke.summary, ke.data, ke.sort_order, ke.tags, ke.created_at, ke.updated_at);
    }
    for (const conv of conversations) {
      insertConv.run(conv.id, conv.novel_id, conv.user_id, conv.topic, conv.title, conv.parent_message_id ?? null, conv.is_archived ? 1 : 0, conv.created_at, conv.updated_at);
    }
    for (const msg of messages) {
      insertMsg.run(msg.id, msg.novel_id, msg.role, msg.content, msg.conversation_id ?? null, msg.created_at);
    }
  });
  tx();
}
