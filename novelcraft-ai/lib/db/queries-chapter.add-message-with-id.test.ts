import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-add-message-with-id-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('addMessageWithId atomic insert', () => {
  it('lets one concurrent insert win and returns the validated row for both callers', async () => {
    const {
      addMessageWithId,
      createNovel,
      deleteNovelCascade,
      getMessages,
    } = await import('@/lib/db');

    const novel = await createNovel({ userId: 'local-user', title: 'Message Collision' });
    const messageId = 'atomic-user-1';

    try {
      const [first, second] = await Promise.all([
        addMessageWithId(novel.id, messageId, 'user', 'same body'),
        addMessageWithId(novel.id, messageId, 'user', 'same body'),
      ]);

      expect(first).toMatchObject({
        id: messageId,
        role: 'user',
        content: 'same body',
        conversationId: null,
      });
      expect(second).toMatchObject({
        id: messageId,
        role: 'user',
        content: 'same body',
        conversationId: null,
      });
      expect(first.createdAt).toBe(second.createdAt);
      expect((await getMessages(novel.id)).map(message => message.id)).toEqual([messageId]);

      await expect(
        addMessageWithId(novel.id, messageId, 'user', 'mutated body'),
      ).rejects.toThrow('Message id collision');
      await expect(
        addMessageWithId(novel.id, messageId, 'assistant', 'same body'),
      ).rejects.toThrow('Message id collision');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
