import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const completionFault = vi.hoisted(() => ({ throwOnce: false }));

vi.mock('@/lib/db/queries-chat-turns', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/db/queries-chat-turns')>();
  return {
    ...actual,
    completeChatTurnToolCall: (
      args: Parameters<typeof actual.completeChatTurnToolCall>[0],
    ) => {
      if (completionFault.throwOnce) {
        completionFault.throwOnce = false;
        throw new Error('INJECTED_CRASH_AFTER_TOOL_MUTATION');
      }
      return actual.completeChatTurnToolCall(args);
    },
  };
});

interface ExecutableTool {
  execute: (input: never) => Promise<unknown>;
}

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-brainstorm-durable-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('durable brainstorm tool effects', () => {
  it('recovers every mutation-after-intent crash without a second write and rejects changed retry args', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      cancelChatTurn,
      createNovel,
      deleteNovelCascade,
      failChatTurn,
      getKnowledgeEntries,
      getNovel,
      hashChatTurnRequest,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      consumeLatestBrainstormReceipt,
      ensureBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');

    const novel = await createNovel({ userId: 'local-user', title: 'Durable Tools' });
    const userMessageId = 'durable-tools-turn';
    const requestHash = hashChatTurnRequest({
      content: 'Build the durable story deck',
      mode: 'ordinary',
    });
    const assistantMessageId = 'durable-tools-assistant';
    let claim = beginChatTurn({
      novelId: novel.id,
      userMessageId,
      requestHash,
      assistantMessageId,
    });

    const acquireTools = () => {
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected an acquired durable tool turn');
      }
      const receiptId = ensureBrainstormReceipt(
        novel.id,
        claim.turn.brainstormReceiptId,
      );
      expect(attachChatTurnBrainstormReceipt(
        novel.id,
        userMessageId,
        receiptId,
        claim.turn.claimToken,
      )).toBe(true);
      return {
        receiptId,
        claimToken: claim.turn.claimToken,
        tools: createBrainstormTools(novel.id, {
          receiptId,
          userMessageId,
          claimToken: claim.turn.claimToken,
        }),
      };
    };
    const failAndReclaim = (claimToken: string) => {
      expect(failChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken,
        errorCode: 'provider_failed',
      })?.status).toBe('failed');
      claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId,
      });
      expect(claim.kind).toBe('acquired');
    };
    const cancelAndReclaim = (claimToken: string) => {
      const cancelled = cancelChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken,
        responseText: 'partial provider text must not replace the tool ledger',
      });
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        claimToken: null,
        errorCode: null,
        responseText: null,
      });
      claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId,
      });
      expect(claim.kind).toBe('acquired');
    };

    const profileInput = {
      genre: 'Mystery',
      storySummary: 'A librarian hears erased names.',
    };
    const deckInput = {
      entries: [{
        type: 'character' as const,
        title: 'Mira',
        summary: 'A skeptical archivist.',
        details: { arc: 'Learns to trust the uncanny' },
      }],
    };
    const finalizeInput = {
      profile: {
        genre: 'Mystery',
        targetWords: 60_000,
        storySummary: 'A librarian hears erased names.',
        characterSummary: 'Mira protects her sister.',
        arcSummary: 'The archive reveals a family betrayal.',
      },
      entries: [
        ...deckInput.entries,
        {
          type: 'world' as const,
          title: 'The Archive',
          summary: 'Erased histories speak at night.',
          details: { rule: 'Forgotten names open locked shelves' },
        },
        {
          type: 'outline' as const,
          title: 'The Locked Shelf',
          summary: 'Mira exposes the family betrayal.',
          details: { chapterNumber: '1' },
        },
      ],
    };

    try {
      let active = acquireTools();
      completionFault.throwOnce = true;
      await expect(
        (active.tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(profileInput as never),
      ).rejects.toThrow('INJECTED_CRASH_AFTER_TOOL_MUTATION');
      expect((await getNovel(novel.id))?.genre).toBe('Mystery');
      getDb().prepare('UPDATE novels SET updated_at = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', novel.id);

      failAndReclaim(active.claimToken);
      active = acquireTools();
      await expect(
        (active.tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute({ storySummary: profileInput.storySummary, genre: profileInput.genre } as never),
      ).resolves.toEqual({ ok: true });
      expect((await getNovel(novel.id))?.updatedAt).toBe(946_684_800_000);
      await expect(
        (active.tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute({ genre: 'Science Fiction' } as never),
      ).rejects.toThrow('ledger key collision');
      expect((await getNovel(novel.id))?.genre).toBe('Mystery');

      completionFault.throwOnce = true;
      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(deckInput as never),
      ).rejects.toThrow('INJECTED_CRASH_AFTER_TOOL_MUTATION');
      let mira = (await getKnowledgeEntries(novel.id, { type: 'character' }))[0];
      expect(mira?.title).toBe('Mira');
      getDb().prepare('UPDATE knowledge_entries SET updated_at = ? WHERE id = ?')
        .run('2000-01-02T00:00:00.000Z', mira.id);

      failAndReclaim(active.claimToken);
      active = acquireTools();
      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute({
            entries: [{
              ...deckInput.entries[0],
              details: { arc: 'Learns to trust the uncanny' },
            }],
          } as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      mira = (await getKnowledgeEntries(novel.id, { type: 'character' }))[0];
      expect(mira.updated_at).toBe('2000-01-02T00:00:00.000Z');
      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute({
            entries: [{
              type: 'character',
              title: 'Different Retry Title',
              summary: 'Must never be inserted.',
              details: {},
            }],
          } as never),
      ).rejects.toThrow('ledger key collision');
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))
        .map(entry => entry.title)).toEqual(['Mira']);

      // Simulate a real process restart after the ledger result was durable:
      // the in-memory receipt disappears, cancellation supplies partial text,
      // and the next provider run replays both completed tool slots.
      const registry = globalThis as typeof globalThis & {
        __inkmarshalBrainstormReceipts?: Map<string, unknown>;
      };
      registry.__inkmarshalBrainstormReceipts?.clear();
      cancelAndReclaim(active.claimToken);
      active = acquireTools();
      await expect(
        (active.tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(profileInput as never),
      ).resolves.toEqual({ ok: true });
      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(deckInput as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0].updated_at)
        .toBe('2000-01-02T00:00:00.000Z');

      completionFault.throwOnce = true;
      await expect(
        (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
          .execute(finalizeInput as never),
      ).rejects.toThrow('INJECTED_CRASH_AFTER_TOOL_MUTATION');
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      getDb().prepare(
        `UPDATE knowledge_entries SET updated_at = ?
          WHERE novel_id = ? AND type IN ('world', 'outline')`,
      ).run('2000-01-03T00:00:00.000Z', novel.id);

      failAndReclaim(active.claimToken);
      active = acquireTools();
      await expect(
        (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
          .execute(finalizeInput as never),
      ).resolves.toEqual({
        ok: true,
        coverage: { character: 1, world: 1, outline: 1 },
      });
      expect(Object.fromEntries((await getKnowledgeEntries(novel.id)).map(
        entry => [entry.title, entry.updated_at],
      ))).toEqual({
        Mira: '2000-01-02T00:00:00.000Z',
        'The Archive': '2000-01-03T00:00:00.000Z',
        'The Locked Shelf': '2000-01-03T00:00:00.000Z',
      });
      await expect(
        (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
          .execute({
            ...finalizeInput,
            entries: finalizeInput.entries.map((entry, index) => (
              index === 1 ? { ...entry, title: 'Different World Retry' } : entry
            )),
          } as never),
      ).rejects.toThrow('ledger key collision');
      expect((await getKnowledgeEntries(novel.id)).some(
        entry => entry.title === 'Different World Retry',
      )).toBe(false);

      const receipt = consumeLatestBrainstormReceipt(novel.id);
      expect(receipt).toMatchObject({
        id: active.receiptId,
        profileFields: expect.arrayContaining(['genre', 'storySummary', 'stage']),
        storyEntries: expect.arrayContaining([
          expect.objectContaining({ title: 'Mira', action: 'created' }),
          expect.objectContaining({ title: 'The Archive', action: 'created' }),
          expect.objectContaining({ title: 'The Locked Shelf', action: 'created' }),
        ]),
      });
      expect(await undoBrainstormReceipt(novel.id, active.receiptId))
        .toEqual({ ok: true });
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect(await getKnowledgeEntries(novel.id)).toEqual([]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('fails closed when user edits diverge from both the prepared before-state and tool after-state', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createNovel,
      deleteNovelCascade,
      failChatTurn,
      getKnowledgeEntries,
      getNovel,
      hashChatTurnRequest,
      updateKnowledgeEntry,
      updateNovel,
    } = await import('@/lib/db');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const { ensureBrainstormReceipt } = await import('@/lib/brainstorm-receipts');

    const runConflictCase = async (
      suffix: string,
      executeTool: (tools: ReturnType<typeof createBrainstormTools>) => Promise<unknown>,
      applyUserEdit: (novelId: string) => Promise<void>,
      assertPreserved: (novelId: string) => Promise<void>,
    ) => {
      const novel = await createNovel({
        userId: 'local-user',
        title: `Conflict ${suffix}`,
      });
      const userMessageId = `conflict-${suffix}`;
      const requestHash = hashChatTurnRequest({
        content: `conflict ${suffix}`,
        mode: 'ordinary',
      });
      const assistantMessageId = `assistant-${suffix}`;
      let claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId,
      });
      const acquire = () => {
        if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
          throw new Error('Expected conflict test claim');
        }
        const receiptId = ensureBrainstormReceipt(
          novel.id,
          claim.turn.brainstormReceiptId,
        );
        expect(attachChatTurnBrainstormReceipt(
          novel.id,
          userMessageId,
          receiptId,
          claim.turn.claimToken,
        )).toBe(true);
        return {
          claimToken: claim.turn.claimToken,
          tools: createBrainstormTools(novel.id, {
            receiptId,
            userMessageId,
            claimToken: claim.turn.claimToken,
          }),
        };
      };

      try {
        let active = acquire();
        completionFault.throwOnce = true;
        await expect(executeTool(active.tools))
          .rejects.toThrow('INJECTED_CRASH_AFTER_TOOL_MUTATION');
        await applyUserEdit(novel.id);
        expect(failChatTurn({
          novelId: novel.id,
          userMessageId,
          claimToken: active.claimToken,
          errorCode: 'provider_failed',
        })?.status).toBe('failed');
        claim = beginChatTurn({
          novelId: novel.id,
          userMessageId,
          requestHash,
          assistantMessageId,
        });
        active = acquire();
        await expect(executeTool(active.tools))
          .rejects.toThrow('Durable brainstorm tool state conflict');
        await assertPreserved(novel.id);
      } finally {
        completionFault.throwOnce = false;
        await deleteNovelCascade(novel.id, 'local-user');
      }
    };

    const profileInput = {
      genre: 'Mystery',
      storySummary: 'Tool-authored summary.',
    };
    await runConflictCase(
      'profile',
      tools => (tools.updateBrainstormProfile as unknown as ExecutableTool)
        .execute(profileInput as never),
      async novelId => {
        await updateNovel(novelId, {
          storySummary: 'Writer-authored summary after the crash.',
        });
      },
      async novelId => {
        expect((await getNovel(novelId))?.storySummary)
          .toBe('Writer-authored summary after the crash.');
      },
    );

    const deckInput = {
      entries: [{
        type: 'character' as const,
        title: 'Mira',
        summary: 'Tool-authored character.',
        details: {},
      }],
    };
    await runConflictCase(
      'entry',
      tools => (tools.upsertStoryDeckEntries as unknown as ExecutableTool)
        .execute(deckInput as never),
      async novelId => {
        const entry = (await getKnowledgeEntries(novelId, { type: 'character' }))[0];
        await updateKnowledgeEntry(entry.id, {
          summary: 'Writer-authored character after the crash.',
          data: JSON.stringify({ role: 'writer-owned' }),
          updatedAt: '2026-07-30T01:02:03.000Z',
        });
      },
      async novelId => {
        const entries = await getKnowledgeEntries(novelId, { type: 'character' });
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          title: 'Mira',
          summary: 'Writer-authored character after the crash.',
          data: JSON.stringify({ role: 'writer-owned' }),
        });
      },
    );

    const finalizeInput = {
      profile: {
        genre: 'Mystery',
        targetWords: 60_000,
        storySummary: 'Tool story.',
        characterSummary: 'Tool cast.',
        arcSummary: 'Tool arc.',
      },
      entries: [
        { type: 'character' as const, title: 'Mira', summary: 'Tool character.', details: {} },
        { type: 'world' as const, title: 'Archive', summary: 'Tool world.', details: {} },
        { type: 'outline' as const, title: 'Opening', summary: 'Tool outline.', details: {} },
      ],
    };
    await runConflictCase(
      'finalize',
      tools => (tools.finalizeBrainstorm as unknown as ExecutableTool)
        .execute(finalizeInput as never),
      async novelId => {
        const world = (await getKnowledgeEntries(novelId, { type: 'world' }))[0];
        await updateKnowledgeEntry(world.id, {
          summary: 'Writer-authored world after the crash.',
          data: JSON.stringify({ category: 'writer-owned' }),
          updatedAt: '2026-07-30T02:03:04.000Z',
        });
      },
      async novelId => {
        const entries = await getKnowledgeEntries(novelId);
        expect(entries).toHaveLength(3);
        expect(entries.find(entry => entry.type === 'world')).toMatchObject({
          title: 'Archive',
          summary: 'Writer-authored world after the crash.',
          data: JSON.stringify({ category: 'writer-owned' }),
        });
      },
    );
  });

  it('keeps finalize ledger bounded with a 550 KiB unrelated knowledge corpus', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      hashChatTurnRequest,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { persistChatTurnAssistantMessage } = await import('@/lib/db/queries-chat-turns');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      consumeLatestBrainstormReceipt,
      ensureBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');
    const novel = await createNovel({ userId: 'local-user', title: 'Bounded Ledger' });
    const now = '2026-07-30T03:04:05.000Z';

    try {
      for (let index = 0; index < 110; index += 1) {
        await createKnowledgeEntry({
          id: crypto.randomUUID(),
          novelId: novel.id,
          type: 'style_reference',
          title: `Large style ${index}`,
          summary: `Style ${index}`,
          data: JSON.stringify({ sample: 'x'.repeat(5_000) }),
          sortOrder: index,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
      }
      const hugeCharacterData = JSON.stringify({
        role: 'supporting',
        description: 'Original writer-owned character.',
        backstory: '',
        motivation: '',
        traits: [],
        arc: '',
        aliases: [],
        perNovelOverrides: Object.fromEntries(Array.from(
          { length: 200 },
          (_, index) => [`book-${index}`, { note: `${index}:${'z'.repeat(2_700)}` }],
        )),
      });
      expect(Buffer.byteLength(hugeCharacterData, 'utf8')).toBeGreaterThan(530 * 1024);
      await createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'character',
        title: 'Mira',
        summary: 'Original writer-owned character.',
        data: hugeCharacterData,
        sortOrder: 0,
        tags: JSON.stringify(['writer-owned']),
        createdAt: now,
        updatedAt: now,
      });
      const userMessageId = 'bounded-ledger-turn';
      const claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({
          content: 'Finalize without copying unrelated knowledge',
          mode: 'ordinary',
        }),
        assistantMessageId: 'bounded-ledger-assistant',
      });
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected bounded ledger claim');
      }
      const receiptId = ensureBrainstormReceipt(novel.id);
      expect(attachChatTurnBrainstormReceipt(
        novel.id,
        userMessageId,
        receiptId,
        claim.turn.claimToken,
      )).toBe(true);
      const tools = createBrainstormTools(novel.id, {
        receiptId,
        userMessageId,
        claimToken: claim.turn.claimToken,
      });
      await expect(
        (tools.finalizeBrainstorm as unknown as ExecutableTool).execute({
          profile: {
            genre: 'Mystery',
            targetWords: 60_000,
            storySummary: 'A bounded story.',
            characterSummary: 'A bounded cast.',
            arcSummary: 'A bounded arc.',
          },
          entries: [
            { type: 'character', title: 'Mira', summary: 'A character.', details: {} },
            { type: 'world', title: 'Archive', summary: 'A world.', details: {} },
            { type: 'outline', title: 'Opening', summary: 'An outline.', details: {} },
          ],
        } as never),
      ).resolves.toMatchObject({ ok: true });

      const row = getDb().prepare(
        `SELECT response_text
           FROM chat_turns
          WHERE novel_id = ? AND user_message_id = ?`,
      ).get(novel.id, userMessageId) as { response_text: string };
      expect(Buffer.byteLength(row.response_text, 'utf8')).toBeLessThan(64 * 1024);
      const snapshot = getDb().prepare(
        `SELECT payload, payload_sha256
           FROM chat_turn_tool_snapshots
          WHERE novel_id = ? AND user_message_id = ?`,
      ).get(novel.id, userMessageId) as { payload: string; payload_sha256: string };
      expect(Buffer.byteLength(snapshot.payload, 'utf8')).toBeGreaterThan(530 * 1024);
      expect(snapshot.payload_sha256).toMatch(/^[a-f0-9]{64}$/);

      expect(persistChatTurnAssistantMessage({
        novelId: novel.id,
        userMessageId,
        claimToken: claim.turn.claimToken,
        assistantMessageId: 'bounded-ledger-assistant',
        responseText: 'Finalized.',
      })).toMatchObject({ content: 'Finalized.' });
      expect(getDb().prepare(
        `SELECT COUNT(*) AS count FROM chat_turn_tool_snapshots
          WHERE novel_id = ? AND user_message_id = ?`,
      ).get(novel.id, userMessageId)).toEqual({ count: 0 });

      expect(consumeLatestBrainstormReceipt(novel.id)?.id).toBe(receiptId);
      expect(await undoBrainstormReceipt(novel.id, receiptId)).toEqual({ ok: true });
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0].data)
        .toBe(hugeCharacterData);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('recovers or conflicts safely when the overwritten target snapshot exceeds 530 KiB', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      failChatTurn,
      getKnowledgeEntries,
      hashChatTurnRequest,
      updateKnowledgeEntry,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      consumeLatestBrainstormReceipt,
      ensureBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');

    const finalizeInput = {
      profile: {
        genre: 'Mystery',
        targetWords: 60_000,
        storySummary: 'A large-snapshot story.',
        characterSummary: 'A large-snapshot cast.',
        arcSummary: 'A large-snapshot arc.',
      },
      entries: [
        { type: 'character' as const, title: 'Mira', summary: 'Replacement character.', details: {} },
        { type: 'world' as const, title: 'Archive', summary: 'Replacement world.', details: {} },
        { type: 'outline' as const, title: 'Opening', summary: 'Replacement outline.', details: {} },
      ],
    };

    for (const conflict of [false, true]) {
      const novel = await createNovel({
        userId: 'local-user',
        title: conflict ? 'Huge Snapshot Conflict' : 'Huge Snapshot Recovery',
      });
      const hugeCharacterData = JSON.stringify({
        role: 'supporting',
        description: 'Original writer-owned character.',
        backstory: '',
        motivation: '',
        traits: [],
        arc: '',
        aliases: [],
        perNovelOverrides: Object.fromEntries(Array.from(
          { length: 200 },
          (_, index) => [`book-${index}`, { note: `${index}:${'q'.repeat(2_700)}` }],
        )),
      });
      const userMessageId = `huge-target-${conflict ? 'conflict' : 'recover'}`;
      const requestHash = hashChatTurnRequest({
        content: userMessageId,
        mode: 'ordinary',
      });
      const assistantMessageId = `assistant-${userMessageId}`;

      try {
        await createKnowledgeEntry({
          id: crypto.randomUUID(),
          novelId: novel.id,
          type: 'character',
          title: 'Mira',
          summary: 'Original writer-owned character.',
          data: hugeCharacterData,
          sortOrder: 0,
          tags: JSON.stringify(['writer-owned']),
          createdAt: '2026-07-30T04:05:06.000Z',
          updatedAt: '2026-07-30T04:05:06.000Z',
        });
        let claim = beginChatTurn({
          novelId: novel.id,
          userMessageId,
          requestHash,
          assistantMessageId,
        });
        const acquire = () => {
          if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
            throw new Error('Expected huge snapshot claim');
          }
          const receiptId = ensureBrainstormReceipt(
            novel.id,
            claim.turn.brainstormReceiptId,
          );
          expect(attachChatTurnBrainstormReceipt(
            novel.id,
            userMessageId,
            receiptId,
            claim.turn.claimToken,
          )).toBe(true);
          return {
            claimToken: claim.turn.claimToken,
            receiptId,
            tools: createBrainstormTools(novel.id, {
              receiptId,
              userMessageId,
              claimToken: claim.turn.claimToken,
            }),
          };
        };

        let active = acquire();
        completionFault.throwOnce = true;
        await expect(
          (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
            .execute(finalizeInput as never),
        ).rejects.toThrow('INJECTED_CRASH_AFTER_TOOL_MUTATION');
        expect(getDb().prepare(
          `SELECT COUNT(*) AS count FROM chat_turn_tool_snapshots
            WHERE novel_id = ? AND user_message_id = ?`,
        ).get(novel.id, userMessageId)).toEqual({ count: 1 });

        if (conflict) {
          const mira = (await getKnowledgeEntries(novel.id, { type: 'character' }))[0];
          await updateKnowledgeEntry(mira.id, {
            summary: 'Writer override after crash.',
            data: JSON.stringify({
              role: 'supporting',
              description: 'Writer override after crash.',
              backstory: '',
              motivation: '',
              traits: [],
              arc: '',
              aliases: [],
            }),
            updatedAt: '2026-07-30T05:06:07.000Z',
          });
        }
        expect(failChatTurn({
          novelId: novel.id,
          userMessageId,
          claimToken: active.claimToken,
          errorCode: 'provider_failed',
        })?.status).toBe('failed');
        expect(getDb().prepare(
          `SELECT COUNT(*) AS count FROM chat_turn_tool_snapshots
            WHERE novel_id = ? AND user_message_id = ?`,
        ).get(novel.id, userMessageId)).toEqual({ count: 1 });
        claim = beginChatTurn({
          novelId: novel.id,
          userMessageId,
          requestHash,
          assistantMessageId,
        });
        active = acquire();

        const retry = (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
          .execute(finalizeInput as never);
        if (conflict) {
          await expect(retry).rejects.toThrow('Durable brainstorm tool state conflict');
          const entries = await getKnowledgeEntries(novel.id);
          expect(entries).toHaveLength(3);
          expect(entries.find(entry => entry.type === 'character')?.summary)
            .toBe('Writer override after crash.');
        } else {
          await expect(retry).resolves.toMatchObject({ ok: true });
          expect(consumeLatestBrainstormReceipt(novel.id)?.id).toBe(active.receiptId);
          expect(await undoBrainstormReceipt(novel.id, active.receiptId))
            .toEqual({ ok: true });
          expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0].data)
            .toBe(hugeCharacterData);
        }
      } finally {
        completionFault.throwOnce = false;
        await deleteNovelCascade(novel.id, 'local-user');
      }
    }
  });
});
