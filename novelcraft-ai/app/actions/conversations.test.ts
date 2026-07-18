import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-conversation-action-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('conversation server actions', () => {
  it('bounds update payloads before writing conversation metadata', async () => {
    const { createNovel, deleteNovelCascade, getConversationById } = await import('@/lib/db');
    const { createConversation, updateConversation } = await import('@/app/actions/conversations');
    const novel = await createNovel({ userId: 'local-user', title: 'Conversation action test' });

    try {
      const conversation = await createConversation(novel.id, {
        topic: 'general',
        title: 'Original title',
        parentMessageId: null,
      });

      await expect(
        updateConversation(novel.id, conversation.id, { title: 'x'.repeat(201) }),
      ).rejects.toThrow();

      expect((await getConversationById(conversation.id))?.title).toBe('Original title');

      await updateConversation(novel.id, conversation.id, { title: 'Renamed', isArchived: true });
      const updated = await getConversationById(conversation.id);
      expect(updated?.title).toBe('Renamed');
      expect(updated?.is_archived).toBe(1);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not refresh conversation or novel recency for empty or same-value updates', async () => {
    const { createNovel, deleteNovelCascade, getConversationById, getNovel } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createConversation, updateConversation } = await import('@/app/actions/conversations');
    const novel = await createNovel({ userId: 'local-user', title: 'Conversation no-op action' });
    const stale = '2000-01-01T00:00:00.000Z';

    try {
      const conversation = await createConversation(novel.id, {
        topic: 'general',
        title: 'Stable title',
        parentMessageId: null,
      });
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?').run(stale, novel.id);
      getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(stale, conversation.id);

      await updateConversation(novel.id, conversation.id, {});
      expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));
      expect((await getConversationById(conversation.id))?.updated_at).toBe(stale);

      await updateConversation(novel.id, conversation.id, {
        title: 'Stable title',
        isArchived: false,
      });
      expect((await getNovel(novel.id))?.updatedAt).toBe(Date.parse(stale));
      expect((await getConversationById(conversation.id))?.updated_at).toBe(stale);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('bounds parent message ids before lookup', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { createConversation } = await import('@/app/actions/conversations');
    const novel = await createNovel({ userId: 'local-user', title: 'Conversation parent bounds' });

    try {
      await expect(
        createConversation(novel.id, {
          topic: 'general',
          title: 'Fork',
          parentMessageId: 'x'.repeat(129),
        }),
      ).rejects.toThrow();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects fork roots that are not attached to a live conversation', async () => {
    const { addMessage, createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { createConversation } = await import('@/app/actions/conversations');
    const novel = await createNovel({ userId: 'local-user', title: 'Conversation orphan parent' });

    try {
      const orphanMessage = await addMessage(novel.id, 'assistant', 'global chat message');

      await expect(
        createConversation(novel.id, {
          topic: 'general',
          title: 'Invalid fork',
          parentMessageId: orphanMessage.id,
        }),
      ).rejects.toThrow('Not found');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('allows fork roots attached to the same novel conversation', async () => {
    const { addMessage, createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { createConversation } = await import('@/app/actions/conversations');
    const novel = await createNovel({ userId: 'local-user', title: 'Conversation valid parent' });

    try {
      const parentConversation = await createConversation(novel.id, {
        topic: 'plot',
        title: 'Parent',
        parentMessageId: null,
      });
      const parentMessage = await addMessage(novel.id, 'assistant', 'forkable parent', parentConversation.id);

      const fork = await createConversation(novel.id, {
        topic: 'plot',
        title: 'Fork',
        parentMessageId: parentMessage.id,
      });

      expect(fork.title).toBe('Fork');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('deleting a parent conversation removes its fork descendants atomically', async () => {
    const {
      addMessage,
      createNovel,
      deleteNovelCascade,
      getConversationById,
      getMessagesForNovel,
    } = await import('@/lib/db');
    const { createConversation, deleteConversation } = await import('@/app/actions/conversations');
    const novel = await createNovel({ userId: 'local-user', title: 'Conversation fork delete tree' });

    try {
      const parent = await createConversation(novel.id, {
        topic: 'plot',
        title: 'Parent',
        parentMessageId: null,
      });
      const parentMessage = await addMessage(novel.id, 'assistant', 'fork root', parent.id);

      const child = await createConversation(novel.id, {
        topic: 'plot',
        title: 'Child',
        parentMessageId: parentMessage.id,
      });
      const childMessage = await addMessage(novel.id, 'assistant', 'child fork root', child.id);

      const grandchild = await createConversation(novel.id, {
        topic: 'plot',
        title: 'Grandchild',
        parentMessageId: childMessage.id,
      });
      await addMessage(novel.id, 'assistant', 'grandchild turn', grandchild.id);

      const unrelated = await createConversation(novel.id, {
        topic: 'characters',
        title: 'Unrelated',
        parentMessageId: null,
      });
      await addMessage(novel.id, 'assistant', 'unrelated turn', unrelated.id);

      await deleteConversation(novel.id, parent.id);

      await expect(getConversationById(parent.id)).resolves.toBeUndefined();
      await expect(getConversationById(child.id)).resolves.toBeUndefined();
      await expect(getConversationById(grandchild.id)).resolves.toBeUndefined();
      await expect(getConversationById(unrelated.id)).resolves.toBeDefined();
      const deletedIds = new Set([parent.id, child.id, grandchild.id]);
      expect((await getMessagesForNovel(novel.id)).some(message => deletedIds.has(message.conversation_id ?? ''))).toBe(false);
      expect((await getMessagesForNovel(novel.id)).some(message => message.conversation_id === unrelated.id)).toBe(true);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects update and delete when the conversation belongs to another novel', async () => {
    const { createNovel, deleteNovelCascade, getConversationById } = await import('@/lib/db');
    const { createConversation, deleteConversation, updateConversation } = await import(
      '@/app/actions/conversations'
    );
    const sourceNovel = await createNovel({ userId: 'local-user', title: 'Conversation source novel' });
    const otherNovel = await createNovel({ userId: 'local-user', title: 'Conversation other novel' });

    try {
      const conversation = await createConversation(sourceNovel.id, {
        topic: 'general',
        title: 'Source title',
        parentMessageId: null,
      });

      await expect(
        updateConversation(otherNovel.id, conversation.id, { title: 'Wrong novel rename' }),
      ).rejects.toThrow('Not found');
      expect((await getConversationById(conversation.id))?.title).toBe('Source title');

      await expect(deleteConversation(otherNovel.id, conversation.id)).rejects.toThrow('Not found');
      expect(await getConversationById(conversation.id)).toBeDefined();
    } finally {
      await deleteNovelCascade(sourceNovel.id, 'local-user');
      await deleteNovelCascade(otherNovel.id, 'local-user');
    }
  });
});
