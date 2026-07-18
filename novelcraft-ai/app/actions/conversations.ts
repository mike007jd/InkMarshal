'use server';

import { getUser } from '@/lib/local-auth';
import {
  verifyNovelOwnership,
  createConversation as dbCreateConversation,
  updateConversation as dbUpdateConversation,
  deleteConversation as dbDeleteConversation,
  getConversationById,
} from '@/lib/db';
import { createConversationSchema, updateConversationSchema } from '@/lib/types/conversation';
import { verifyParentMessageBelongsToNovel } from '@/lib/conversations';
import { nowIso } from '@/lib/utils';

function hasConversationUpdateChange(
  parsed: { title?: string; isArchived?: boolean },
  conv: { title: string; is_archived: number },
): boolean {
  return (
    (parsed.title !== undefined && parsed.title !== conv.title) ||
    (parsed.isArchived !== undefined && parsed.isArchived !== (conv.is_archived === 1))
  );
}

export async function createConversation(novelId: string, input: unknown) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  const parsed = createConversationSchema.parse(input);
  await verifyNovelOwnership(novelId, user.id);
  if (!(await verifyParentMessageBelongsToNovel(parsed.parentMessageId, novelId, user.id))) {
    throw new Error('Not found');
  }

  const now = nowIso();
  const id = crypto.randomUUID();

  await dbCreateConversation({
    id,
    novelId,
    userId: user.id,
    topic: parsed.topic,
    title: parsed.title,
    parentMessageId: parsed.parentMessageId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return { id, novelId, topic: parsed.topic, title: parsed.title };
}

export async function updateConversation(novelId: string, convId: string, updates: unknown) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  await verifyNovelOwnership(novelId, user.id);
  const conv = await getConversationById(convId);
  if (!conv || conv.user_id !== user.id || conv.novel_id !== novelId) {
    throw new Error('Not found');
  }

  const parsed = updateConversationSchema.parse(updates);
  if (!hasConversationUpdateChange(parsed, conv)) return;
  await dbUpdateConversation(convId, novelId, user.id, {
    ...parsed,
    updatedAt: nowIso(),
  });
}

export async function deleteConversation(novelId: string, convId: string) {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');

  await verifyNovelOwnership(novelId, user.id);
  const conv = await getConversationById(convId);
  if (!conv || conv.user_id !== user.id || conv.novel_id !== novelId) {
    throw new Error('Not found');
  }

  await dbDeleteConversation(convId, novelId, user.id);
}
