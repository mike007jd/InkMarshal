import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { conversationMatchesNovelAndUser, resolveForkedMessageChain } from '@/lib/conversations';

describe('conversation ownership helpers', () => {
  it('accepts a conversation only when conversation, novel, and user all match', () => {
    expect(conversationMatchesNovelAndUser(
      { novel_id: 'novel-1', user_id: 'user-1' },
      'novel-1',
      'user-1',
    )).toBe(true);
  });

  it('rejects a conversation from another novel', () => {
    expect(conversationMatchesNovelAndUser(
      { novel_id: 'novel-2', user_id: 'user-1' },
      'novel-1',
      'user-1',
    )).toBe(false);
  });
});

describe('resolveForkedMessageChain', () => {
  it('keeps nested fork history bounded to each parent fork point', () => {
    const messages = resolveForkedMessageChain(
      'conv-c',
      [
        { id: 'conv-a', parentMessageId: null },
        { id: 'conv-b', parentMessageId: 'a2' },
        { id: 'conv-c', parentMessageId: 'b1' },
      ],
      {
        'conv-a': [
          { id: 'a1', novelId: 'novel-1', role: 'user', content: 'A before fork', createdAt: 1, conversationId: 'conv-a' },
          { id: 'a2', novelId: 'novel-1', role: 'assistant', content: 'A fork point', createdAt: 2, conversationId: 'conv-a' },
          { id: 'a3', novelId: 'novel-1', role: 'assistant', content: 'A after fork', createdAt: 3, conversationId: 'conv-a' },
        ],
        'conv-b': [
          { id: 'b1', novelId: 'novel-1', role: 'assistant', content: 'B fork point', createdAt: 4, conversationId: 'conv-b' },
          { id: 'b2', novelId: 'novel-1', role: 'assistant', content: 'B after child fork', createdAt: 5, conversationId: 'conv-b' },
        ],
        'conv-c': [
          { id: 'c1', novelId: 'novel-1', role: 'user', content: 'C child turn', createdAt: 6, conversationId: 'conv-c' },
        ],
      },
    );

    expect(messages.map(m => m.id)).toEqual(['a1', 'a2', 'b1', 'c1']);
  });
});

// ── summarizeConversationsForContext (W2-E topic filter + sizing) ─────────

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-convotest-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function dbm() {
  return import('@/lib/db');
}

const USER_ID = '22222222-2222-2222-2222-222222222222';
const OTHER_USER_ID = '33333333-3333-3333-3333-333333333333';

async function seedConversation(
  novelId: string,
  topic: string,
  title: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  userId: string = USER_ID,
): Promise<string> {
  const { createConversation, addMessage } = await dbm();
  const now = new Date().toISOString();
  const cid = crypto.randomUUID();
  await createConversation({
    id: cid,
    novelId,
    userId,
    topic,
    title,
    parentMessageId: null,
    createdAt: now,
    updatedAt: now,
  });
  // Each addMessage call assigns its own createdAt — sleep a microtask to
  // keep ordering stable across two consecutive inserts.
  for (const m of messages) {
    await addMessage(novelId, m.role, m.content, cid);
  }
  return cid;
}

describe('summarizeConversationsForContext', () => {
  let novelId: string | null = null;

  afterEach(async () => {
    if (novelId) {
      const { deleteNovelCascade } = await dbm();
      await deleteNovelCascade(novelId, USER_ID).catch(() => {});
      novelId = null;
    }
  });

  it('returns empty string when there are no conversations', async () => {
    const { createNovel } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'Empty', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    const { summarizeConversationsForContext } = await import('@/lib/conversations');
    expect(await summarizeConversationsForContext(novel.id, { maxChars: 2000 })).toBe('');
  });

  it('picks one conversation per topic and includes only assistant messages', async () => {
    const { createNovel } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'Topics', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    await seedConversation(novel.id, 'plot', 'Plot arc', [
      { role: 'user', content: 'how should the climax go?' },
      { role: 'assistant', content: 'Push the antagonist to expose the hidden artefact.' },
    ]);
    await seedConversation(novel.id, 'characters', 'Hero bio', [
      { role: 'user', content: 'Tell me about hero' },
      { role: 'assistant', content: 'The hero is haunted by a sister he could not save.' },
    ]);

    const { summarizeConversationsForContext } = await import('@/lib/conversations');
    const all = await summarizeConversationsForContext(novel.id, { maxChars: 2000 });
    expect(all).toContain('[plot] Plot arc');
    expect(all).toContain('[characters] Hero bio');
    // User messages should never leak through.
    expect(all).not.toContain('how should the climax go');
  });

  it('scopes conversation digest to the authorized user when userId is provided', async () => {
    const { createNovel } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'Scoped digest', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    await seedConversation(novel.id, 'plot', 'Owned plot', [
      { role: 'assistant', content: 'owned secret plot note' },
    ]);
    await seedConversation(novel.id, 'plot', 'Other plot', [
      { role: 'assistant', content: 'other user plot note' },
    ], OTHER_USER_ID);

    const { summarizeConversationsForContext } = await import('@/lib/conversations');
    const scoped = await summarizeConversationsForContext(novel.id, { userId: USER_ID, maxChars: 2000 });
    expect(scoped).toContain('owned secret plot note');
    expect(scoped).not.toContain('Other plot');
    expect(scoped).not.toContain('other user plot note');
  });

  it('scopes resolved fork chains to the authorized user', async () => {
    const { createNovel } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'Scoped fork', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    const ownedId = await seedConversation(novel.id, 'plot', 'Owned fork', [
      { role: 'assistant', content: 'owned chain message' },
    ]);
    await seedConversation(novel.id, 'plot', 'Other fork', [
      { role: 'assistant', content: 'other user chain message' },
    ], OTHER_USER_ID);

    const { resolveFullMessageChain } = await import('@/lib/conversations');
    const scoped = await resolveFullMessageChain(novel.id, ownedId, USER_ID);
    expect(scoped.map(message => message.content)).toEqual(['owned chain message']);
  });

  it('rejects fork parent messages from another user in the same novel', async () => {
    const { createNovel, createConversation, addMessage } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'Scoped parent', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    const now = new Date().toISOString();
    const otherConversationId = crypto.randomUUID();
    await createConversation({
      id: otherConversationId,
      novelId: novel.id,
      userId: OTHER_USER_ID,
      topic: 'plot',
      title: 'Other user parent',
      parentMessageId: null,
      createdAt: now,
      updatedAt: now,
    });
    const otherMessage = await addMessage(novel.id, 'assistant', 'other user fork root', otherConversationId);

    const { verifyParentMessageBelongsToNovel } = await import('@/lib/conversations');
    expect(await verifyParentMessageBelongsToNovel(otherMessage.id, novel.id, USER_ID)).toBe(false);
    expect(await verifyParentMessageBelongsToNovel(otherMessage.id, novel.id, OTHER_USER_ID)).toBe(true);
  });

  it('uses message activity to choose the latest conversation for a topic', async () => {
    const { createNovel, createConversation, addMessage } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'Conversation recency', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    const revivedId = crypto.randomUUID();
    const staleWinnerId = crypto.randomUUID();
    await createConversation({
      id: revivedId,
      novelId: novel.id,
      userId: USER_ID,
      topic: 'plot',
      title: 'Revived plot',
      parentMessageId: null,
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-01T00:00:00.000Z',
    });
    await createConversation({
      id: staleWinnerId,
      novelId: novel.id,
      userId: USER_ID,
      topic: 'plot',
      title: 'Previously newer plot',
      parentMessageId: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
    await addMessage(novel.id, 'assistant', 'old plot fact', staleWinnerId);
    await new Promise(resolve => setTimeout(resolve, 5));
    await addMessage(novel.id, 'assistant', 'newly relevant plot fact', revivedId);

    const { summarizeConversationsForContext } = await import('@/lib/conversations');
    const all = await summarizeConversationsForContext(novel.id, { topics: ['plot'], maxChars: 2000 });
    expect(all).toContain('[plot] Revived plot');
    expect(all).toContain('newly relevant plot fact');
    expect(all).not.toContain('Previously newer plot');
  });

  it('topic filter narrows the output to selected topics only', async () => {
    const { createNovel } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'Topic filter', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    await seedConversation(novel.id, 'plot', 'Plot one', [
      { role: 'assistant', content: 'Plot reply line about the conspiracy.' },
    ]);
    await seedConversation(novel.id, 'chapter_editing', 'Ch5 polishing', [
      { role: 'assistant', content: 'Trim the second paragraph and reorder dialogue.' },
    ]);
    await seedConversation(novel.id, 'characters', 'Backstory', [
      { role: 'assistant', content: 'Hero grew up in a sea-port temple.' },
    ]);

    const { summarizeConversationsForContext } = await import('@/lib/conversations');
    const filtered = await summarizeConversationsForContext(novel.id, {
      topics: ['chapter_editing'],
      maxChars: 2000,
    });
    expect(filtered).toContain('[chapter_editing] Ch5 polishing');
    expect(filtered).not.toContain('[plot]');
    expect(filtered).not.toContain('[characters]');
  });

  it('honours maxChars and head-truncates with an ellipsis when over budget', async () => {
    const { createNovel } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'Budgets', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    const longContent = 'X'.repeat(800);
    await seedConversation(novel.id, 'plot', 'Long', [{ role: 'assistant', content: longContent }]);

    const { summarizeConversationsForContext } = await import('@/lib/conversations');
    const tight = await summarizeConversationsForContext(novel.id, { maxChars: 120 });
    expect(tight.length).toBeLessThanOrEqual(120);
    expect(tight.endsWith('…')).toBe(true);
  });

  it('limits to perConvMessages most-recent assistant messages per conversation', async () => {
    const { createNovel } = await dbm();
    const novel = await createNovel({ userId: USER_ID, title: 'PerConv', genre: 'test', targetWords: 80000 });
    novelId = novel.id;
    // Five assistant turns — only last 3 should appear (default perConvMessages = 3).
    await seedConversation(novel.id, 'plot', 'Many', [
      { role: 'assistant', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'assistant', content: 'three' },
      { role: 'assistant', content: 'four' },
      { role: 'assistant', content: 'five' },
    ]);

    const { summarizeConversationsForContext } = await import('@/lib/conversations');
    const out = await summarizeConversationsForContext(novel.id, { maxChars: 2000 });
    expect(out).toContain('- three');
    expect(out).toContain('- four');
    expect(out).toContain('- five');
    expect(out).not.toContain('- one');
    expect(out).not.toContain('- two');
  });
});
