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

describe('brainstorm agent tools', () => {
  it('marks a brainstorm ready with a greenlight-compatible proposal state', async () => {
    const { createNovel, deleteNovelCascade, getNovel } = await import('@/lib/db');
    const { getInterviewState } = await import('@/lib/interview-state-server');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const novel = await createNovel({ userId: 'local-user', title: 'Brainstorm Ready' });

    try {
      const tools = createBrainstormTools(novel.id);
      await (tools.updateBrainstormProfile as unknown as ExecutableTool).execute({
        genre: 'Mystery',
        targetWords: 60000,
        storySummary: 'Two sisters investigate a haunted archive.',
        characterSummary: 'One skeptic, one believer.',
        arcSummary: 'The haunting reveals a family betrayal.',
        readyForGreenlight: true,
      });

      const updated = await getNovel(novel.id);
      const state = await getInterviewState(novel.id);
      expect(updated?.stage).toBe('ready_for_greenlight');
      expect(updated?.progress).toBe(0);
      expect(state?.mode).toBe('proposal_review');
      expect(state?.collectedProfile.storySummary).toContain('haunted archive');
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
