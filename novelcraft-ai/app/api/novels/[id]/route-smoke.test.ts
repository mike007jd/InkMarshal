import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-route-smoke-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

describe('novel read route smoke coverage', () => {
  it('returns 404 for missing or foreign novels before reading child resources', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const novelRoute = await import('./route');
    const blueprintRoute = await import('./blueprint/route');
    const chaptersRoute = await import('./chapters/route');
    const conversationsRoute = await import('./conversations/route');
    const knowledgeRoute = await import('./knowledge/route');
    const outlineRoute = await import('./outline/route');
    const foreign = await createNovel({ userId: 'other-user', title: 'Foreign Novel' });

    try {
      const missingId = 'missing-novel-id';
      const cases: Array<() => Promise<Response>> = [
        () => novelRoute.GET(new Request(`http://localhost/api/novels/${missingId}`), params({ id: missingId })),
        () => blueprintRoute.GET(new Request(`http://localhost/api/novels/${foreign.id}/blueprint`), params({ id: foreign.id })),
        () => chaptersRoute.GET(new Request(`http://localhost/api/novels/${foreign.id}/chapters`), params({ id: foreign.id })),
        () => conversationsRoute.GET(new Request(`http://localhost/api/novels/${foreign.id}/conversations`), params({ id: foreign.id })),
        () => knowledgeRoute.GET(new Request(`http://localhost/api/novels/${foreign.id}/knowledge`), params({ id: foreign.id })),
        () => outlineRoute.GET(new Request(`http://localhost/api/novels/${foreign.id}/outline`), params({ id: foreign.id })),
      ];

      for (const run of cases) {
        const response = await run();
        expect(response.status).toBe(404);
      }
    } finally {
      await deleteNovelCascade(foreign.id, 'other-user');
    }
  });

  it('returns stable empty shapes for a new local novel', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const blueprintRoute = await import('./blueprint/route');
    const chaptersRoute = await import('./chapters/route');
    const conversationsRoute = await import('./conversations/route');
    const knowledgeRoute = await import('./knowledge/route');
    const relationsRoute = await import('./knowledge/relations/route');
    const outlineRoute = await import('./outline/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Empty Smoke Novel', targetWords: 80_000 });

    try {
      await expect(blueprintRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/blueprint`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toMatchObject({ blueprint: null, targetWords: 80_000 });
      await expect(chaptersRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/chapters`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([]);
      await expect(conversationsRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/conversations`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([]);
      await expect(knowledgeRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/knowledge`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([]);
      await expect(relationsRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/knowledge/relations`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([]);
      await expect(outlineRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/outline`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('returns happy-path response shapes for read-only child routes', async () => {
    const {
      addMessage,
      createConversation,
      createKnowledgeEntry,
      createKnowledgeRelation,
      createNovel,
      deleteNovelCascade,
      setNovelBlueprint,
      upsertChapter,
    } = await import('@/lib/db');
    const novelRoute = await import('./route');
    const blueprintRoute = await import('./blueprint/route');
    const chaptersRoute = await import('./chapters/route');
    const conversationsRoute = await import('./conversations/route');
    const conversationRoute = await import('./conversations/[convId]/route');
    const conversationMessagesRoute = await import('./conversations/[convId]/messages/route');
    const knowledgeRoute = await import('./knowledge/route');
    const knowledgeEntryRoute = await import('./knowledge/[entryId]/route');
    const relationsRoute = await import('./knowledge/relations/route');
    const outlineRoute = await import('./outline/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Full Smoke Novel', genre: 'fantasy', targetWords: 90_000 });

    try {
      await setNovelBlueprint(novel.id, {
        chapters: [{ chapterNumber: 1, title: 'Opening', summary: 'The story opens.' }],
        targetWordsPerChapter: 4500,
        generatedAt: new Date().toISOString(),
        modelId: 'test-model',
      });
      await upsertChapter(novel.id, 1, 'Opening', 'Once upon a local runtime.');
      const now = new Date().toISOString();
      const conversation = await createConversation({
        id: crypto.randomUUID(),
        novelId: novel.id,
        userId: 'local-user',
        topic: 'general',
        title: 'Draft discussion',
        parentMessageId: null,
        createdAt: now,
        updatedAt: now,
      });
      const message = await addMessage(novel.id, 'assistant', 'Conversation message', conversation.id);
      const entryA = await createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'character',
        title: 'Mira',
        summary: 'Protagonist',
        data: JSON.stringify({ role: 'lead' }),
        sortOrder: 0,
        tags: JSON.stringify([]),
        createdAt: now,
        updatedAt: now,
      });
      const entryB = await createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'world',
        title: 'Harbor',
        summary: 'Starting location',
        data: JSON.stringify({ category: 'place' }),
        sortOrder: 1,
        tags: JSON.stringify([]),
        createdAt: now,
        updatedAt: now,
      });
      const relation = await createKnowledgeRelation({
        id: crypto.randomUUID(),
        sourceId: entryA.id,
        targetId: entryB.id,
        relationType: 'lives_in',
        label: 'home port',
        createdAt: now,
      });

      await expect(novelRoute.GET(new Request(`http://localhost/api/novels/${novel.id}`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toMatchObject({
          id: novel.id,
          title: 'Full Smoke Novel',
          blueprint: { chapters: [expect.objectContaining({ title: 'Opening' })] },
        });
      await expect(blueprintRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/blueprint`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toMatchObject({
          blueprint: { chapters: [expect.objectContaining({ title: 'Opening' })] },
          targetWords: 90_000,
        });
      await expect(chaptersRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/chapters?lite=1`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([expect.objectContaining({ chapterNumber: 1, title: 'Opening' })]);
      await expect(conversationsRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/conversations`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([expect.objectContaining({ id: conversation.id, title: 'Draft discussion' })]);
      await expect(conversationRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}`), params({ id: novel.id, convId: conversation.id })).then(r => r.json()))
        .resolves.toMatchObject({ id: conversation.id, title: 'Draft discussion' });
      await expect(conversationMessagesRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/conversations/${conversation.id}/messages`), params({ id: novel.id, convId: conversation.id })).then(r => r.json()))
        .resolves.toEqual([expect.objectContaining({ id: message.id, content: 'Conversation message' })]);
      await expect(knowledgeRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/knowledge?type=character`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([expect.objectContaining({ id: entryA.id, title: 'Mira' })]);
      await expect(knowledgeEntryRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/knowledge/${entryA.id}`), params({ id: novel.id, entryId: entryA.id })).then(r => r.json()))
        .resolves.toMatchObject({ id: entryA.id, relations: [expect.objectContaining({ id: relation.id })] });
      await expect(relationsRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/knowledge/relations`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([expect.objectContaining({ id: relation.id })]);
      await expect(outlineRoute.GET(new Request(`http://localhost/api/novels/${novel.id}/outline`), params({ id: novel.id })).then(r => r.json()))
        .resolves.toEqual([expect.objectContaining({ title: 'Opening', hasChapter: true, chapterWordCount: 5 })]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
