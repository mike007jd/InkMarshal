import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-brainstorm-agent-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

type ExecutableTool = {
  execute(input: Record<string, unknown>, options?: unknown): Promise<unknown>;
};

describe('explicit writing approval detection', () => {
  it('accepts clear zh-CN, zh-TW, and English approve-to-write phrasing', async () => {
    const { isExplicitWritingApproval } = await import('@/lib/brainstorm-agent');

    expect(isExplicitWritingApproval('批准写作。请开始生成完整第一章。')).toBe(true);
    expect(isExplicitWritingApproval('大纲无误，开始动笔')).toBe(true);
    expect(isExplicitWritingApproval('同意开始写作')).toBe(true);
    expect(isExplicitWritingApproval('请使用系统写作工具批准当前故事方案并启动第一章写作任务，不要在聊天中直接返回正文。')).toBe(true);
    expect(isExplicitWritingApproval('批准寫作。請開始生成完整第一章。')).toBe(true);
    expect(isExplicitWritingApproval('大綱無誤，開始動筆')).toBe(true);
    expect(isExplicitWritingApproval('好，就按这个方案开始写第一章吧')).toBe(true);
    expect(isExplicitWritingApproval('方案没问题，开始写第一章')).toBe(true);
    expect(isExplicitWritingApproval('Approve writing. Please generate the full first chapter.')).toBe(true);
    expect(isExplicitWritingApproval('Approve & begin writing')).toBe(true);
    expect(isExplicitWritingApproval('Approve the current story plan and start writing now')).toBe(true);
    expect(isExplicitWritingApproval('Yes, go ahead with chapter one')).toBe(true);
    expect(isExplicitWritingApproval('不要在聊天中直接写正文，请批准写作并开始第一章。')).toBe(true);
    expect(isExplicitWritingApproval('不要直接返回小说正文；批准当前故事方案并启动第一章写作任务。')).toBe(true);
    expect(isExplicitWritingApproval('批准当前故事方案；不要在聊天中直接写正文。')).toBe(true);
    expect(isExplicitWritingApproval('批准写作，结局不要改。')).toBe(true);
    expect(isExplicitWritingApproval('批准写作，不用修改大纲。')).toBe(true);
    expect(isExplicitWritingApproval('Approve writing; don\'t change the ending.')).toBe(true);
    expect(isExplicitWritingApproval('Tomorrow is clear. Approve writing now.')).toBe(true);
    expect(isExplicitWritingApproval('我明天有空。批准写作。')).toBe(true);
  });

  it('rejects questions, deferred approval, negation, and adjust-with-approval turns', async () => {
    const { isExplicitWritingApproval } = await import('@/lib/brainstorm-agent');

    expect(isExplicitWritingApproval('写一个短篇悬疑故事：调查员林澈在雾港档案馆发现会自行改写的失踪索引。')).toBe(false);
    expect(isExplicitWritingApproval('请直接推进到可批准写作的一章方案。')).toBe(false);
    expect(isExplicitWritingApproval('先调整方案，结局改成开放式。')).toBe(false);
    expect(isExplicitWritingApproval('调整方案后再批准写作')).toBe(false);
    expect(isExplicitWritingApproval('不要批准写作')).toBe(false);
    expect(isExplicitWritingApproval('还没准备好批准')).toBe(false);
    expect(isExplicitWritingApproval('什么时候可以批准写作？')).toBe(false);
    expect(isExplicitWritingApproval('请问什么时候可以批准写作？')).toBe(false);
    expect(isExplicitWritingApproval('我们可以批准写作了吗？')).toBe(false);
    expect(isExplicitWritingApproval('批准写作但先改结局')).toBe(false);
    expect(isExplicitWritingApproval('Can I approve writing?')).toBe(false);
    expect(isExplicitWritingApproval('Can we begin writing now?')).toBe(false);
    expect(isExplicitWritingApproval('Approve plan after adjust ending')).toBe(false);
    expect(isExplicitWritingApproval('批准写作，不过把结局改成开放式。')).toBe(false);
    expect(isExplicitWritingApproval('批准写作，之后再调整结局。')).toBe(false);
    expect(isExplicitWritingApproval('批准写作，但先把结局改成开放式。')).toBe(false);
    expect(isExplicitWritingApproval('批准写作，把大纲改成三幕式。')).toBe(false);
    expect(isExplicitWritingApproval('Approve writing, but make the ending open.')).toBe(false);
    expect(isExplicitWritingApproval('Approve the plan after you adjust the ending.')).toBe(false);
    expect(isExplicitWritingApproval('Approve writing, but change the outline first.')).toBe(false);
    expect(isExplicitWritingApproval('I might approve writing tomorrow.')).toBe(false);
    expect(isExplicitWritingApproval('I am considering whether to approve writing.')).toBe(false);
    expect(isExplicitWritingApproval('我明天可能批准写作。')).toBe(false);
    expect(isExplicitWritingApproval('我不是要批准写作。')).toBe(false);
    expect(isExplicitWritingApproval('告诉我如何批准写作。')).toBe(false);
    expect(isExplicitWritingApproval('The UI says, Approve writing.')).toBe(false);
    expect(isExplicitWritingApproval('My editor wrote, approve the current plan.')).toBe(false);
    expect(isExplicitWritingApproval('界面显示，批准写作。')).toBe(false);
    expect(isExplicitWritingApproval('Tomorrow, approve writing.')).toBe(false);
    expect(isExplicitWritingApproval('明天，批准写作。')).toBe(false);
    expect(isExplicitWritingApproval('Approve writing is disabled.')).toBe(false);
    expect(isExplicitWritingApproval('On the UI, approve writing is disabled.')).toBe(false);
    expect(isExplicitWritingApproval('Approve writing might be the button label.')).toBe(false);
    expect(isExplicitWritingApproval('批准写作按钮不可用。')).toBe(false);
    expect(isExplicitWritingApproval('Don\'t approve writing yet')).toBe(false);
    expect(isExplicitWritingApproval('Please adjust the outline before approving')).toBe(false);
    expect(isExplicitWritingApproval('I want to write a cyberpunk detective story')).toBe(false);
  });
});

describe('brainstorm agent tools', () => {
  it('only marks a brainstorm ready after atomically saving a complete Story Deck', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntries, getNovel } = await import('@/lib/db');
    const { getInterviewState } = await import('@/lib/interview-state-server');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const novel = await createNovel({ userId: 'local-user', title: 'Brainstorm Ready' });

    try {
      const tools = createBrainstormTools(novel.id);
      await (tools.finalizeBrainstorm as unknown as ExecutableTool).execute({
        profile: {
          genre: 'Mystery',
          targetWords: 60000,
          storySummary: 'Two sisters investigate a haunted archive.',
          characterSummary: 'One skeptic, one believer.',
          arcSummary: 'The haunting reveals a family betrayal.',
        },
        entries: [
          { type: 'character', title: 'Mira', summary: 'A skeptical archivist.', details: {} },
          { type: 'world', title: 'The Archive', summary: 'Erased histories speak at night.', details: {} },
          { type: 'outline', title: 'The Locked Shelf', summary: 'The sisters expose a family betrayal.', details: { chapterNumber: '1' } },
        ],
      });

      const updated = await getNovel(novel.id);
      const state = await getInterviewState(novel.id);
      expect(updated?.stage).toBe('ready_for_greenlight');
      expect(updated?.progress).toBe(0);
      expect(state?.mode).toBe('proposal_review');
      expect(state?.collectedProfile.storySummary).toContain('haunted archive');
      const entries = await getKnowledgeEntries(novel.id);
      expect(new Set(entries.map(entry => entry.type))).toEqual(new Set(['character', 'world', 'outline']));
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('does not advance the stage when finalization omits a required Deck category', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntries, getNovel } = await import('@/lib/db');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const novel = await createNovel({ userId: 'local-user', title: 'Incomplete Brainstorm' });

    try {
      const tools = createBrainstormTools(novel.id);
      const result = await (tools.finalizeBrainstorm as unknown as ExecutableTool).execute({
        profile: { storySummary: 'A proposal that is not structurally complete.' },
        entries: [
          { type: 'character', title: 'Mira', summary: 'An archivist.', details: {} },
          { type: 'world', title: 'Archive', summary: 'A haunted library.', details: {} },
        ],
      });

      expect(result).toEqual({ ok: false, reason: 'incomplete' });
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect(await getKnowledgeEntries(novel.id)).toEqual([]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('repairs only missing Story Deck categories without changing existing cards', async () => {
    const {
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getNovel,
      updateNovel,
    } = await import('@/lib/db');
    const { finalizeApprovedStoryDeck } = await import('@/lib/brainstorm-agent');
    const novel = await createNovel({ userId: 'local-user', title: 'Partial Deck Repair' });
    await updateNovel(novel.id, {
      genre: 'Mystery',
      storySummary: 'A custom story seed.',
      characterSummary: 'A custom cast.',
      arcSummary: 'A custom arc.',
    });
    const updatedAt = '2026-01-02T03:04:05.000Z';
    const existingCards = [
      {
        id: crypto.randomUUID(),
        type: 'character',
        title: 'Main Cast',
        summary: 'Writer-authored character summary.',
        data: JSON.stringify({ custom: 'character-data' }),
        tags: JSON.stringify(['writer-authored']),
      },
      {
        id: crypto.randomUUID(),
        type: 'world',
        title: 'Handmade World',
        summary: 'Writer-authored world summary.',
        data: JSON.stringify({ custom: 'world-data' }),
        tags: JSON.stringify(['writer-authored']),
      },
    ];

    try {
      for (const card of existingCards) {
        await createKnowledgeEntry({
          ...card,
          novelId: novel.id,
          sortOrder: 7,
          createdAt: updatedAt,
          updatedAt,
        });
      }

      expect(await finalizeApprovedStoryDeck(novel.id, 'en')).toMatchObject({ ok: true });

      const entries = await getKnowledgeEntries(novel.id);
      expect(entries.filter(entry => entry.type === 'character')).toHaveLength(1);
      expect(entries.filter(entry => entry.type === 'world')).toHaveLength(1);
      expect(entries.filter(entry => entry.type === 'outline')).toHaveLength(1);
      for (const original of existingCards) {
        expect(entries.find(entry => entry.id === original.id)).toMatchObject({
          id: original.id,
          type: original.type,
          title: original.title,
          summary: original.summary,
          data: original.data,
          tags: original.tags,
          updated_at: updatedAt,
        });
      }
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('upserts Story Deck entries as knowledge records', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntries } = await import('@/lib/db');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const novel = await createNovel({ userId: 'local-user', title: 'Brainstorm Deck' });

    try {
      const tools = createBrainstormTools(novel.id);
      const result = await (tools.upsertStoryDeckEntries as unknown as ExecutableTool).execute({
        entries: [
          {
            type: 'character',
            title: 'Mira',
            summary: 'A skeptical archivist.',
            details: { motivation: 'Protect her sister', arc: 'Learns to trust the uncanny' },
          },
          {
            type: 'world',
            title: 'The Archive',
            summary: 'A library where erased histories speak at night.',
            details: { rule: 'Only forgotten names can open locked shelves' },
          },
        ],
      }) as { ok: boolean; created: number; updated: number };

      const characters = await getKnowledgeEntries(novel.id, { type: 'character' });
      const worlds = await getKnowledgeEntries(novel.id, { type: 'world' });
      expect(result).toEqual({ ok: true, created: 2, updated: 0, unchanged: 0 });
      expect(characters.map(entry => entry.title)).toEqual(['Mira']);
      expect(worlds.map(entry => entry.title)).toEqual(['The Archive']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('emits one visible receipt and atomically refuses stale undo', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntries, getNovel, updateNovel } = await import('@/lib/db');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      beginBrainstormReceipt,
      consumeLatestBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');
    const novel = await createNovel({ userId: 'local-user', title: 'Brainstorm Receipt' });

    try {
      const receiptId = beginBrainstormReceipt(novel.id);
      const tools = createBrainstormTools(novel.id, receiptId);
      await (tools.updateBrainstormProfile as unknown as ExecutableTool).execute({
        genre: 'Mystery',
        storySummary: 'A librarian hears erased names.',
      });
      await (tools.upsertStoryDeckEntries as unknown as ExecutableTool).execute({
        entries: [{
          type: 'character',
          title: 'Mira',
          summary: 'A skeptical archivist.',
          details: {},
        }],
      });

      const receipt = consumeLatestBrainstormReceipt(novel.id);
      expect(receipt).toMatchObject({
        id: receiptId,
        profileFields: expect.arrayContaining(['genre', 'storySummary']),
        storyEntries: [{ type: 'character', title: 'Mira', action: 'created' }],
      });
      expect(consumeLatestBrainstormReceipt(novel.id)).toBeNull();

      // A later manual edit protects the writer from an undo that would
      // silently roll back newer intent.
      await updateNovel(novel.id, { storySummary: 'The writer refined this afterward.' });
      expect(await undoBrainstormReceipt(novel.id, receiptId)).toEqual({ ok: false, reason: 'conflict' });
      expect((await getNovel(novel.id))?.storySummary).toBe('The writer refined this afterward.');
      expect((await getKnowledgeEntries(novel.id, { type: 'character' })).map(entry => entry.title)).toEqual(['Mira']);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('undoes the exact profile and Story Deck writes from a receipt', async () => {
    const { createNovel, deleteNovelCascade, getKnowledgeEntries, getNovel } = await import('@/lib/db');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      beginBrainstormReceipt,
      consumeLatestBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');
    const novel = await createNovel({ userId: 'local-user', title: 'Brainstorm Undo' });

    try {
      const receiptId = beginBrainstormReceipt(novel.id);
      const tools = createBrainstormTools(novel.id, receiptId);
      await (tools.updateBrainstormProfile as unknown as ExecutableTool).execute({ genre: 'Fantasy' });
      await (tools.upsertStoryDeckEntries as unknown as ExecutableTool).execute({
        entries: [{
          type: 'world',
          title: 'Glass City',
          summary: 'Every promise becomes visible.',
          details: {},
        }],
      });
      expect(consumeLatestBrainstormReceipt(novel.id)?.id).toBe(receiptId);

      expect(await undoBrainstormReceipt(novel.id, receiptId)).toEqual({ ok: true });
      expect((await getNovel(novel.id))?.genre).toBe(novel.genre);
      expect(await getKnowledgeEntries(novel.id, { type: 'world' })).toEqual([]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
