import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  it('recovers every mutation-after-intent crash without a second write', async () => {
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
      __setBrainstormMutationFaultForTest,
      __setBrainstormUndoFaultForTest,
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
      __setBrainstormMutationFaultForTest({ point: 'after_first_mutation' });
      await expect(
        (active.tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(profileInput as never),
      ).rejects.toThrow('INJECTED_BRAINSTORM_FAULT_AFTER_FIRST_MUTATION');
      expect((await getNovel(novel.id))?.genre).toBe('');

      const staleTools = active.tools;
      failAndReclaim(active.claimToken);
      active = acquireTools();
      await expect(
        (staleTools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(profileInput as never),
      ).rejects.toThrow('Chat turn claim lost');
      await expect(
        (active.tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute({ storySummary: profileInput.storySummary, genre: profileInput.genre } as never),
      ).resolves.toEqual({ ok: true });
      expect((await getNovel(novel.id))?.genre).toBe('Mystery');

      __setBrainstormMutationFaultForTest({ point: 'during_receipt_persist' });
      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(deckInput as never),
      ).rejects.toThrow('INJECTED_BRAINSTORM_FAULT_DURING_RECEIPT_PERSIST');
      expect(await getKnowledgeEntries(novel.id, { type: 'character' })).toEqual([]);
      expect(getDb().prepare(
        `SELECT COUNT(*) AS count FROM knowledge_index
          WHERE novel_id = ? AND type = 'character'`,
      ).get(novel.id)).toEqual({ count: 0 });
      expect(getDb().prepare(
        `SELECT COUNT(*) AS count FROM knowledge_vault_outbox WHERE novel_id = ?`,
      ).get(novel.id)).toEqual({ count: 0 });
      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute({
            entries: [{
              ...deckInput.entries[0],
              details: { arc: 'Learns to trust the uncanny' },
            }],
          } as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      const mira = (await getKnowledgeEntries(novel.id, { type: 'character' }))[0];
      const miraIdentity = { id: mira.id, updatedAt: mira.updated_at };
      expect(getDb().prepare(
        'SELECT id FROM knowledge_index WHERE id = ?',
      ).get(mira.id)).toEqual({ id: mira.id });
      expect(getDb().prepare(
        `SELECT entry_id, operation, status FROM knowledge_vault_outbox WHERE entry_id = ?`,
      ).get(mira.id)).toMatchObject({
        entry_id: mira.id,
        operation: 'upsert',
        status: 'pending',
      });
      // Exact same-input replay under the same durable turn is idempotent.
      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(deckInput as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))
        .map(entry => entry.title)).toEqual(['Mira']);
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0])
        .toMatchObject({ id: miraIdentity.id, updated_at: miraIdentity.updatedAt });

      // Simulate a real process restart after the ledger result was durable:
      // the in-memory receipt disappears, cancellation supplies partial text,
      // and the next provider run replays both completed tool slots.
      const registry = globalThis as typeof globalThis & {
        __inkmarshalBrainstormReceipts?: Map<string, unknown>;
      };
      registry.__inkmarshalBrainstormReceipts?.clear();
      getDb().prepare(
        'UPDATE brainstorm_receipts SET expires_at_ms = 0 WHERE id = ?',
      ).run(active.receiptId);
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
      const repairedReceipt = getDb().prepare(
        'SELECT profile_json, entries_json FROM brainstorm_receipts WHERE id = ?',
      ).get(active.receiptId) as {
        profile_json: string | null;
        entries_json: string;
      };
      expect(repairedReceipt.profile_json).not.toBeNull();
      expect(JSON.parse(repairedReceipt.entries_json)).toHaveLength(1);
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0])
        .toMatchObject({ id: miraIdentity.id, updated_at: miraIdentity.updatedAt });

      __setBrainstormMutationFaultForTest({ point: 'after_first_mutation' });
      await expect(
        (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
          .execute(finalizeInput as never),
      ).rejects.toThrow('INJECTED_BRAINSTORM_FAULT_AFTER_FIRST_MUTATION');
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect((await getKnowledgeEntries(novel.id)).map(entry => entry.title)).toEqual(['Mira']);
      expect(getDb().prepare(
        'SELECT COUNT(*) AS count FROM knowledge_index WHERE novel_id = ?',
      ).get(novel.id)).toEqual({ count: 1 });
      expect(getDb().prepare(
        'SELECT COUNT(*) AS count FROM knowledge_vault_outbox WHERE novel_id = ?',
      ).get(novel.id)).toEqual({ count: 1 });

      failAndReclaim(active.claimToken);
      active = acquireTools();
      await expect(
        (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
          .execute(finalizeInput as never),
      ).resolves.toEqual({
        ok: true,
        coverage: { character: 1, world: 1, outline: 1 },
      });
      expect((await getKnowledgeEntries(novel.id)).map(entry => entry.title).sort())
        .toEqual(['Mira', 'The Archive', 'The Locked Shelf'].sort());
      await expect(
        (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
          .execute(finalizeInput as never),
      ).resolves.toEqual({
        ok: true,
        coverage: { character: 1, world: 1, outline: 1 },
      });
      expect((await getKnowledgeEntries(novel.id)).map(entry => entry.title).sort())
        .toEqual(['Mira', 'The Archive', 'The Locked Shelf'].sort());
      for (const entry of await getKnowledgeEntries(novel.id)) {
        expect(getDb().prepare(
          'SELECT id FROM knowledge_index WHERE id = ?',
        ).get(entry.id)).toEqual({ id: entry.id });
        expect(getDb().prepare(
          `SELECT entry_id, operation, status FROM knowledge_vault_outbox WHERE entry_id = ?`,
        ).get(entry.id)).toMatchObject({
          entry_id: entry.id,
          operation: 'upsert',
          status: 'pending',
        });
      }

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
      __setBrainstormUndoFaultForTest(() => {
        throw new Error('INJECTED_UNDO_ROLLBACK');
      });
      await expect(undoBrainstormReceipt(novel.id, active.receiptId))
        .rejects.toThrow('INJECTED_UNDO_ROLLBACK');
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect(await getKnowledgeEntries(novel.id)).toHaveLength(3);
      __setBrainstormUndoFaultForTest(null);
      expect(await undoBrainstormReceipt(novel.id, active.receiptId))
        .toEqual({ ok: true });
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
      expect(await getKnowledgeEntries(novel.id)).toEqual([]);
    } finally {
      __setBrainstormMutationFaultForTest(null);
      __setBrainstormUndoFaultForTest(null);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('upserts MIRA onto the prepare-selected canonical row among legacy normalized-title duplicates', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      hashChatTurnRequest,
    } = await import('@/lib/db');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const { ensureBrainstormReceipt } = await import('@/lib/brainstorm-receipts');

    const novel = await createNovel({
      userId: 'local-user',
      title: 'Legacy Title Case Dupes',
    });
    const userMessageId = 'legacy-title-case-dupes-turn';
    const requestHash = hashChatTurnRequest({
      content: 'Update Mira casing',
      mode: 'ordinary',
    });
    const claim = beginChatTurn({
      novelId: novel.id,
      userMessageId,
      requestHash,
      assistantMessageId: 'legacy-title-case-dupes-assistant',
    });
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
    const tools = createBrainstormTools(novel.id, {
      receiptId,
      userMessageId,
      claimToken: claim.turn.claimToken,
    });

    const canonicalId = crypto.randomUUID();
    const newerDuplicateId = crypto.randomUUID();
    try {
      // Inverse of updated_at vs sort_order: prepare prefers sort_order ASC first.
      await createKnowledgeEntry({
        id: canonicalId,
        novelId: novel.id,
        type: 'character',
        title: 'Mira',
        summary: 'Older title-case row.',
        data: JSON.stringify({ description: 'Older title-case row.' }),
        tags: JSON.stringify(['brainstorm']),
        sortOrder: 0,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
      await createKnowledgeEntry({
        id: newerDuplicateId,
        novelId: novel.id,
        type: 'character',
        title: 'mira',
        summary: 'Newer lowercase duplicate.',
        data: JSON.stringify({ description: 'Newer lowercase duplicate.' }),
        tags: JSON.stringify(['brainstorm']),
        sortOrder: 10,
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      });

      const prepareCanonical = (await getKnowledgeEntries(novel.id, { type: 'character' }))
        .find(entry => entry.title.trim().toLowerCase() === 'mira');
      expect(prepareCanonical?.id).toBe(canonicalId);

      const miraUpdate = {
        type: 'character' as const,
        title: 'MIRA',
        summary: 'Canonical casing restored.',
        details: { arc: 'Keeps the prepare-selected identity' },
      };
      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool).execute({
          entries: [miraUpdate],
        } as never),
      ).resolves.toEqual({ ok: true, created: 0, updated: 1, unchanged: 0 });

      const characters = await getKnowledgeEntries(novel.id, { type: 'character' });
      expect(characters).toHaveLength(2);
      const mutated = characters.find(entry => entry.id === canonicalId);
      expect(mutated).toMatchObject({ id: canonicalId, title: 'MIRA' });
      expect(mutated?.summary).toContain('Canonical casing restored.');
      expect(characters.find(entry => entry.id === newerDuplicateId)).toMatchObject({
        id: newerDuplicateId,
        title: 'mira',
        summary: 'Newer lowercase duplicate.',
      });
      await expect(
        (tools.finalizeBrainstorm as unknown as ExecutableTool).execute({
          profile: {
            genre: 'Mystery',
            storySummary: 'An index rewrites itself.',
            characterSummary: 'MIRA protects the canonical record.',
            arcSummary: 'She exposes the duplicate.',
          },
          entries: [
            miraUpdate,
            {
              type: 'world',
              title: 'The Archive',
              summary: 'Erased histories speak at night.',
              details: {},
            },
            {
              type: 'outline',
              title: 'The Locked Shelf',
              summary: 'MIRA exposes the duplicate.',
              details: {},
            },
          ],
        } as never),
      ).resolves.toEqual({
        ok: true,
        coverage: { character: 1, world: 1, outline: 1 },
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('returns a completed replay without touching a user replacement', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      cancelChatTurn,
      createNovel,
      deleteNovelCascade,
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
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Completed replay identity fence',
    });
    const userMessageId = 'completed-replay-identity-turn';
    const requestHash = hashChatTurnRequest({
      content: 'Create one durable card',
      mode: 'ordinary',
    });
    let claim = beginChatTurn({
      novelId: novel.id,
      userMessageId,
      requestHash,
      assistantMessageId: 'completed-replay-identity-assistant',
    });
    const acquire = () => {
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected completed replay identity claim');
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
    const input = {
      entries: [{
        type: 'character' as const,
        title: 'Mira',
        summary: 'A skeptical archivist.',
        details: { arc: 'Learns to trust the uncanny' },
      }],
    };

    try {
      let active = acquire();
      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(input as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      const original = (await getKnowledgeEntries(novel.id, { type: 'character' }))[0];
      const replacementId = crypto.randomUUID();
      getDb().transaction(() => {
        getDb().prepare(
          'DELETE FROM knowledge_entries WHERE id = ? AND novel_id = ?',
        ).run(original.id, novel.id);
        getDb().prepare(
          `INSERT INTO knowledge_entries (
             id, novel_id, series_id, type, title, summary, data, data_v,
             sort_order, tags, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          replacementId,
          original.novel_id,
          original.series_id ?? null,
          original.type,
          original.title,
          original.summary,
          original.data,
          original.data_v ?? null,
          original.sort_order,
          original.tags,
          original.created_at,
          original.updated_at,
        );
      })();

      const registry = globalThis as typeof globalThis & {
        __inkmarshalBrainstormReceipts?: Map<string, unknown>;
      };
      registry.__inkmarshalBrainstormReceipts?.clear();
      getDb().prepare(
        'UPDATE brainstorm_receipts SET expires_at_ms = 0 WHERE id = ?',
      ).run(active.receiptId);
      expect(cancelChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken: active.claimToken,
      })?.status).toBe('cancelled');
      claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId: 'completed-replay-identity-assistant',
      });
      active = acquire();

      await expect(
        (active.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(input as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0].id)
        .toBe(replacementId);

      expect(getDb().prepare(
        'SELECT entries_json FROM brainstorm_receipts WHERE id = ?',
      ).get(active.receiptId)).toEqual({
        entries_json: expect.stringContaining(original.id),
      });
      expect(consumeLatestBrainstormReceipt(novel.id)).toMatchObject({
        id: active.receiptId,
      });
      expect(await undoBrainstormReceipt(novel.id, active.receiptId))
        .toEqual({ ok: false, reason: 'conflict' });
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0].id)
        .toBe(replacementId);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('revalidates a prepared no-op inside the ledger transaction before certifying it', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createNovel,
      deleteNovelCascade,
      getNovel,
      hashChatTurnRequest,
      updateNovel,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      __setBrainstormMutationFaultForTest,
      ensureBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Prepared no-op revalidation',
    });

    try {
      await updateNovel(novel.id, { genre: 'Mystery' });
      const userMessageId = 'prepared-noop-revalidation-turn';
      const claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({
          content: 'Keep the current genre',
          mode: 'ordinary',
        }),
        assistantMessageId: 'prepared-noop-revalidation-assistant',
      });
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected prepared no-op claim');
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

      __setBrainstormMutationFaultForTest({ point: 'after_prepare' });
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute({ genre: 'Mystery' } as never),
      ).rejects.toThrow('INJECTED_BRAINSTORM_FAULT_AFTER_PREPARE');

      __setBrainstormMutationFaultForTest({
        point: 'after_recover',
        hook: () => {
          getDb().prepare(
            'UPDATE novels SET story_summary = ? WHERE id = ?',
          ).run('Writer edit between recovery and completion.', novel.id);
        },
      });
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute({ genre: 'Mystery' } as never),
      ).rejects.toThrow('Durable brainstorm tool state conflict');
      expect((await getNovel(novel.id))?.storySummary)
        .toBe('Writer edit between recovery and completion.');
      expect(getDb().prepare(
        'SELECT profile_json, entries_json FROM brainstorm_receipts WHERE id = ?',
      ).get(receiptId)).toEqual({ profile_json: null, entries_json: '[]' });
      expect(await undoBrainstormReceipt(novel.id, receiptId))
        .toEqual({ ok: false, reason: 'expired' });
      expect((await getNovel(novel.id))?.storySummary)
        .toBe('Writer edit between recovery and completion.');
    } finally {
      __setBrainstormMutationFaultForTest(null);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('fails closed when user edits diverge from both the prepared before-state and tool after-state', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      failChatTurn,
      getKnowledgeEntries,
      getNovel,
      hashChatTurnRequest,
      updateNovel,
    } = await import('@/lib/db');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      __setBrainstormMutationFaultForTest,
      ensureBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');

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
        __setBrainstormMutationFaultForTest({ point: 'after_first_mutation' });
        await expect(executeTool(active.tools))
          .rejects.toThrow('INJECTED_BRAINSTORM_FAULT_AFTER_FIRST_MUTATION');
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
        __setBrainstormMutationFaultForTest(null);
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
        await createKnowledgeEntry({
          id: crypto.randomUUID(),
          novelId,
          type: 'character',
          title: 'Mira',
          summary: 'Writer-authored character after the crash.',
          data: JSON.stringify({ role: 'writer-owned' }),
          sortOrder: 0,
          tags: '[]',
          createdAt: '2026-07-30T01:02:03.000Z',
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
        await createKnowledgeEntry({
          id: crypto.randomUUID(),
          novelId,
          type: 'world',
          title: 'Archive',
          summary: 'Writer-authored world after the crash.',
          data: JSON.stringify({ category: 'writer-owned' }),
          sortOrder: 0,
          tags: '[]',
          createdAt: '2026-07-30T02:03:04.000Z',
          updatedAt: '2026-07-30T02:03:04.000Z',
        });
      },
      async novelId => {
        const entries = await getKnowledgeEntries(novelId);
        expect(entries).toHaveLength(1);
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
      getNovel,
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
      let tools = createBrainstormTools(novel.id, {
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
      __setBrainstormMutationFaultForTest,
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
        getDb().prepare(
          `UPDATE knowledge_entries
              SET data_v = 1
            WHERE novel_id = ? AND type = 'character' AND title = 'Mira'`,
        ).run(novel.id);
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
        __setBrainstormMutationFaultForTest({ point: 'during_receipt_persist' });
        await expect(
          (active.tools.finalizeBrainstorm as unknown as ExecutableTool)
            .execute(finalizeInput as never),
        ).rejects.toThrow('INJECTED_BRAINSTORM_FAULT_DURING_RECEIPT_PERSIST');
        expect(await getKnowledgeEntries(novel.id)).toHaveLength(1);
        expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0].data)
          .toBe(hugeCharacterData);
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
          expect(entries).toHaveLength(1);
          expect(entries.find(entry => entry.type === 'character')?.summary)
            .toBe('Writer override after crash.');
        } else {
          await expect(retry).resolves.toMatchObject({ ok: true });
          expect(consumeLatestBrainstormReceipt(novel.id)?.id).toBe(active.receiptId);
          const stored = getDb().prepare(
            'SELECT entries_json FROM brainstorm_receipts WHERE id = ?',
          ).get(active.receiptId) as { entries_json: string };
          const malformed = JSON.parse(stored.entries_json) as Array<{
            before: Record<string, unknown> | null;
          }>;
          const overwritten = malformed.find(mutation => mutation.before !== null);
          if (!overwritten?.before) throw new Error('Expected overwritten entry pre-image');
          expect(overwritten.before.data_v).toBe(1);
          overwritten.before.type = 'invalid_type';
          overwritten.before.data = 'not-json';
          overwritten.before.tags = '{"not":"an array"}';
          overwritten.before.created_at = 'not-a-timestamp';
          getDb().prepare(
            'UPDATE brainstorm_receipts SET entries_json = ? WHERE id = ?',
          ).run(JSON.stringify(malformed), active.receiptId);
          expect(await undoBrainstormReceipt(novel.id, active.receiptId))
            .toEqual({ ok: false, reason: 'conflict' });
          expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0].summary)
            .toBe('Replacement character.');
          getDb().prepare(
            'UPDATE brainstorm_receipts SET entries_json = ? WHERE id = ?',
          ).run(stored.entries_json, active.receiptId);
          expect(await undoBrainstormReceipt(novel.id, active.receiptId))
            .toEqual({ ok: true });
          expect((await getKnowledgeEntries(novel.id, { type: 'character' }))[0])
            .toMatchObject({ data: hugeCharacterData, data_v: 1 });
        }
      } finally {
        __setBrainstormMutationFaultForTest(null);
        await deleteNovelCascade(novel.id, 'local-user');
      }
    }
  });

  it('rolls back a claimed mutation when its durable receipt is corrupt', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createNovel,
      deleteNovelCascade,
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
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Corrupt receipt rollback',
    });
    const userMessageId = 'corrupt-receipt-turn';
    const claim = beginChatTurn({
      novelId: novel.id,
      userMessageId,
      requestHash: hashChatTurnRequest({
        content: 'Write through a corrupt receipt',
        mode: 'ordinary',
      }),
      assistantMessageId: 'corrupt-receipt-assistant',
    });

    try {
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected corrupt receipt test claim');
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
      getDb().prepare(
        'UPDATE brainstorm_receipts SET entries_json = ? WHERE id = ?',
      ).run('[{"unexpected":true}]', receiptId);

      const tools = createBrainstormTools(novel.id, {
        receiptId,
        userMessageId,
        claimToken: claim.turn.claimToken,
      });
      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool).execute({
          entries: [{
            type: 'character',
            title: 'Mira',
            summary: 'Must roll back.',
            details: {},
          }],
        } as never),
      ).rejects.toThrow('invalid entries_json shape');
      expect(await getKnowledgeEntries(novel.id)).toEqual([]);
      expect(getDb().prepare(
        `SELECT response_text FROM chat_turns
          WHERE novel_id = ? AND user_message_id = ?`,
      ).get(novel.id, userMessageId)).toEqual({
        response_text: expect.stringContaining('"status":"prepared"'),
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('serializes semantic calls, reserves colliding paths, and keeps exact replays cache-only', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
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
      __setBrainstormMutationFaultForTest,
      consumeLatestBrainstormReceipt,
      ensureBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');

    const novel = await createNovel({
      userId: 'local-user',
      title: 'Semantic tool identity',
    });
    const userMessageId = 'semantic-identity-turn';
    const claim = beginChatTurn({
      novelId: novel.id,
      userMessageId,
      requestHash: hashChatTurnRequest({
        content: 'Two independent deck writes',
        mode: 'ordinary',
      }),
      assistantMessageId: 'semantic-identity-assistant',
    });

    try {
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected semantic identity claim');
      }
      const receiptId = ensureBrainstormReceipt(novel.id);
      expect(attachChatTurnBrainstormReceipt(
        novel.id,
        userMessageId,
        receiptId,
        claim.turn.claimToken,
      )).toBe(true);
      let tools = createBrainstormTools(novel.id, {
        receiptId,
        userMessageId,
        claimToken: claim.turn.claimToken,
      });
      const genreInput = { genre: 'Mystery' };
      const storyInput = { storySummary: 'A librarian hears erased names.' };
      __setBrainstormMutationFaultForTest({ point: 'after_prepare' });
      const [failedIntent, blockedMutation] = await Promise.allSettled([
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(genreInput as never),
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(storyInput as never),
      ]);
      expect(failedIntent).toMatchObject({
        status: 'rejected',
        reason: { message: 'INJECTED_BRAINSTORM_FAULT_AFTER_PREPARE' },
      });
      expect(blockedMutation).toMatchObject({
        status: 'rejected',
        reason: { message: 'Durable brainstorm tool queue stopped after prior failure' },
      });
      expect(await getNovel(novel.id)).toMatchObject({ genre: '', storySummary: '' });

      expect(failChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken: claim.turn.claimToken,
        errorCode: 'provider_failed',
      })).toMatchObject({ status: 'failed' });
      const reclaimed = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({
          content: 'Two independent deck writes',
          mode: 'ordinary',
        }),
        assistantMessageId: 'semantic-identity-assistant',
      });
      if (reclaimed.kind !== 'acquired' || !reclaimed.turn.claimToken) {
        throw new Error('Expected reclaimed semantic identity claim');
      }
      tools = createBrainstormTools(novel.id, {
        receiptId,
        userMessageId,
        claimToken: reclaimed.turn.claimToken,
      });
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(storyInput as never),
      ).rejects.toThrow('Durable brainstorm tool waiting for earlier prepared intent');
      expect(await getNovel(novel.id)).toMatchObject({ genre: '', storySummary: '' });
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(genreInput as never),
      ).resolves.toEqual({ ok: true });
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(storyInput as never),
      ).resolves.toEqual({ ok: true });
      const beforeNoOpRevision = (await getNovel(novel.id))!.updatedAt;
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute({ genre: 'Mystery', targetWords: 80_000 } as never),
      ).resolves.toEqual({ ok: true });
      expect((await getNovel(novel.id))!.updatedAt).toBe(beforeNoOpRevision);
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(genreInput as never),
      ).resolves.toEqual({ ok: true });
      expect(await getNovel(novel.id)).toMatchObject({
        genre: 'Mystery',
        storySummary: 'A librarian hears erased names.',
      });
      const miraInput = {
        entries: [{
          type: 'character' as const,
          title: 'Mira',
          summary: 'A skeptical archivist.',
          details: { arc: 'Learns to trust the uncanny' },
        }],
      };
      const collidingSlugInput = {
        entries: [{
          type: 'character' as const,
          title: 'Mira*',
          summary: 'A night librarian.',
          details: { arc: 'Keeps the erased names' },
        }],
      };

      const [miraResult, collidingSlugResult] = await Promise.all([
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(miraInput as never),
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(collidingSlugInput as never),
      ]);
      expect(miraResult).toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      expect(collidingSlugResult).toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))
        .map(entry => entry.title).sort()).toEqual(['Mira', 'Mira*']);

      const beforeReplay = await getKnowledgeEntries(novel.id, { type: 'character' });
      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(miraInput as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      expect(await getKnowledgeEntries(novel.id, { type: 'character' }))
        .toEqual(beforeReplay);

      for (const entry of beforeReplay) {
        expect(getDb().prepare(
          'SELECT id FROM knowledge_index WHERE id = ?',
        ).get(entry.id)).toEqual({ id: entry.id });
        expect(getDb().prepare(
          `SELECT operation, status FROM knowledge_vault_outbox WHERE entry_id = ?`,
        ).get(entry.id)).toMatchObject({ operation: 'upsert', status: 'pending' });
      }
      const indexPaths = getDb().prepare(
        `SELECT path FROM knowledge_index
          WHERE novel_id = ? AND type = 'character'`,
      ).all(novel.id) as Array<{ path: string }>;
      expect(new Set(indexPaths.map(row => row.path)).size).toBe(2);

      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool).execute({
          entries: [
            {
              type: 'character',
              title: 'Atlas',
              summary: 'A mapmaker.',
              details: {},
            },
            {
              type: 'character',
              title: 'Atlas*',
              summary: 'A map thief.',
              details: {},
            },
          ],
        } as never),
      ).resolves.toEqual({ ok: true, created: 2, updated: 0, unchanged: 0 });
      const batchEntries = (await getKnowledgeEntries(novel.id, { type: 'character' }))
        .filter(entry => entry.title.startsWith('Atlas'));
      const batchPaths = batchEntries.map(entry => (
        getDb().prepare('SELECT path FROM knowledge_index WHERE id = ?')
          .get(entry.id) as { path: string }
      ).path);
      expect(batchEntries).toHaveLength(2);
      expect(new Set(batchPaths).size).toBe(2);

      const unicodeFirstInput = {
        entries: [{
          type: 'character' as const,
          title: 'E\u0301lan',
          summary: 'First version.',
          details: {},
        }],
      };
      const unicodeSecondInput = {
        entries: [{
          type: 'character' as const,
          title: 'Élan',
          summary: 'Second version.',
          details: {},
        }],
      };
      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(unicodeFirstInput as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(unicodeSecondInput as never),
      ).resolves.toEqual({ ok: true, created: 0, updated: 1, unchanged: 0 });
      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(unicodeFirstInput as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      expect((await getKnowledgeEntries(novel.id, { type: 'character' }))
        .find(entry => entry.title.normalize('NFC') === 'Élan')).toMatchObject({
        summary: 'Second version.',
      });

      await expect(
        (tools.finalizeBrainstorm as unknown as ExecutableTool).execute({
          profile: {
            genre: 'Mystery',
            targetWords: 60_000,
            storySummary: 'A librarian hears erased names.',
            characterSummary: 'Mira protects the archive.',
            arcSummary: 'The archive reveals a betrayal.',
          },
          entries: [
            ...miraInput.entries,
            {
              type: 'world',
              title: 'The Archive',
              summary: 'Erased histories speak at night.',
              details: {},
            },
            {
              type: 'outline',
              title: 'The Locked Shelf',
              summary: 'Mira exposes the betrayal.',
              details: {},
            },
          ],
        } as never),
      ).resolves.toEqual({
        ok: true,
        coverage: { character: 1, world: 1, outline: 1 },
      });
      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(miraInput as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      expect((await getNovel(novel.id))?.stage).toBe('ready_for_greenlight');
      expect(consumeLatestBrainstormReceipt(novel.id)).toMatchObject({ id: receiptId });
      expect(await undoBrainstormReceipt(novel.id, receiptId)).toEqual({ ok: true });
      expect(await getKnowledgeEntries(novel.id)).toEqual([]);
      expect((await getNovel(novel.id))?.stage).toBe('discovery_interview');
    } finally {
      __setBrainstormMutationFaultForTest(null);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('refuses stale undo after a user restores the same profile value', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createNovel,
      deleteNovelCascade,
      getNovel,
      hashChatTurnRequest,
      updateNovel,
    } = await import('@/lib/db');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const { persistChatTurnAssistantMessage } = await import('@/lib/db/queries-chat-turns');
    const {
      consumeLatestBrainstormReceipt,
      ensureBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');

    const novel = await createNovel({
      userId: 'local-user',
      title: 'Profile ABA fence',
    });
    const userMessageId = 'profile-aba-fence-turn';
    const claim = beginChatTurn({
      novelId: novel.id,
      userMessageId,
      requestHash: hashChatTurnRequest({
        content: 'Use Mystery',
        mode: 'ordinary',
      }),
      assistantMessageId: 'profile-aba-fence-assistant',
    });

    try {
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected profile ABA claim');
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
      const input = { genre: 'Mystery' };
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(input as never),
      ).resolves.toEqual({ ok: true });

      await updateNovel(novel.id, { genre: 'Romance' });
      await updateNovel(novel.id, { genre: 'Mystery' });
      await expect(
        (tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute(input as never),
      ).resolves.toEqual({ ok: true });

      expect(persistChatTurnAssistantMessage({
        novelId: novel.id,
        userMessageId,
        claimToken: claim.turn.claimToken,
        assistantMessageId: 'profile-aba-fence-assistant',
        responseText: 'Mystery retained.',
      })).toMatchObject({ content: 'Mystery retained.' });
      expect(consumeLatestBrainstormReceipt(novel.id)).toMatchObject({ id: receiptId });
      expect(await undoBrainstormReceipt(novel.id, receiptId))
        .toEqual({ ok: false, reason: 'conflict' });
      expect((await getNovel(novel.id))?.genre).toBe('Mystery');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects receipt chains that cross intervening user edits', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getNovel,
      hashChatTurnRequest,
      updateNovel,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      consumeLatestBrainstormReceipt,
      ensureBrainstormReceipt,
      undoBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');

    const acquire = async (title: string, userMessageId: string) => {
      const novel = await createNovel({ userId: 'local-user', title });
      const claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({ content: title, mode: 'ordinary' }),
        assistantMessageId: `${userMessageId}-assistant`,
      });
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected intervening-edit claim');
      }
      const receiptId = ensureBrainstormReceipt(novel.id);
      expect(attachChatTurnBrainstormReceipt(
        novel.id,
        userMessageId,
        receiptId,
        claim.turn.claimToken,
      )).toBe(true);
      return {
        novel,
        receiptId,
        tools: createBrainstormTools(novel.id, {
          receiptId,
          userMessageId,
          claimToken: claim.turn.claimToken,
        }),
      };
    };

    const profileCase = await acquire('Profile chain fence', 'profile-chain-fence');
    const entryCase = await acquire('Entry chain fence', 'entry-chain-fence');
    try {
      await expect(
        (profileCase.tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute({ genre: 'Fantasy' } as never),
      ).resolves.toEqual({ ok: true });
      await updateNovel(profileCase.novel.id, { genre: 'Romance' });
      await expect(
        (profileCase.tools.updateBrainstormProfile as unknown as ExecutableTool)
          .execute({ genre: 'Mystery' } as never),
      ).rejects.toThrow('Durable brainstorm receipt mutation conflict');
      expect((await getNovel(profileCase.novel.id))?.genre).toBe('Romance');
      expect(consumeLatestBrainstormReceipt(profileCase.novel.id))
        .toMatchObject({ id: profileCase.receiptId });
      expect(await undoBrainstormReceipt(profileCase.novel.id, profileCase.receiptId))
        .toEqual({ ok: false, reason: 'conflict' });

      const firstEntryInput = {
        entries: [{
          type: 'character' as const,
          title: 'Mira',
          summary: 'Tool first version.',
          details: {},
        }],
      };
      await expect(
        (entryCase.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute(firstEntryInput as never),
      ).resolves.toEqual({ ok: true, created: 1, updated: 0, unchanged: 0 });
      const entry = (await getKnowledgeEntries(
        entryCase.novel.id,
        { type: 'character' },
      ))[0];
      getDb().prepare(
        `UPDATE knowledge_entries
            SET summary = ?, data = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        'Writer-owned version.',
        JSON.stringify({ writerOwned: true }),
        new Date(Date.now() + 1_000).toISOString(),
        entry.id,
      );
      await expect(
        (entryCase.tools.upsertStoryDeckEntries as unknown as ExecutableTool)
          .execute({
            entries: [{
              ...firstEntryInput.entries[0],
              summary: 'Tool second version.',
            }],
          } as never),
      ).rejects.toThrow('Durable brainstorm receipt mutation conflict');
      expect((await getKnowledgeEntries(
        entryCase.novel.id,
        { type: 'character' },
      ))[0]).toMatchObject({ summary: 'Writer-owned version.' });
      expect(consumeLatestBrainstormReceipt(entryCase.novel.id))
        .toMatchObject({ id: entryCase.receiptId });
      expect(await undoBrainstormReceipt(entryCase.novel.id, entryCase.receiptId))
        .toEqual({ ok: false, reason: 'conflict' });
    } finally {
      await deleteNovelCascade(profileCase.novel.id, 'local-user');
      await deleteNovelCascade(entryCase.novel.id, 'local-user');
    }
  });

  it('rolls back entry, index, and outbox together when a claimed Story Deck mutation faults', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      hashChatTurnRequest,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const { createBrainstormTools } = await import('@/lib/brainstorm-agent');
    const {
      __setBrainstormMutationFaultForTest,
      ensureBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');

    const novel = await createNovel({
      userId: 'local-user',
      title: 'Atomic story deck rollback',
    });
    const userMessageId = 'atomic-story-deck-rollback';
    const claim = beginChatTurn({
      novelId: novel.id,
      userMessageId,
      requestHash: hashChatTurnRequest({
        content: 'Atomic rollback',
        mode: 'ordinary',
      }),
      assistantMessageId: 'atomic-story-deck-assistant',
    });

    try {
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected atomic rollback claim');
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
      __setBrainstormMutationFaultForTest({ point: 'after_first_mutation' });
      await expect(
        (tools.upsertStoryDeckEntries as unknown as ExecutableTool).execute({
          entries: [{
            type: 'world',
            title: 'The Archive',
            summary: 'Must not partially land.',
            details: {},
          }],
        } as never),
      ).rejects.toThrow('INJECTED_BRAINSTORM_FAULT_AFTER_FIRST_MUTATION');
      expect(await getKnowledgeEntries(novel.id)).toEqual([]);
      expect(getDb().prepare(
        'SELECT COUNT(*) AS count FROM knowledge_index WHERE novel_id = ?',
      ).get(novel.id)).toEqual({ count: 0 });
      expect(getDb().prepare(
        'SELECT COUNT(*) AS count FROM knowledge_vault_outbox WHERE novel_id = ?',
      ).get(novel.id)).toEqual({ count: 0 });
    } finally {
      __setBrainstormMutationFaultForTest(null);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('claim-fences and atomically receipts repair and explicit-approval branches', async () => {
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      createKnowledgeEntry,
      createNovel,
      deleteNovelCascade,
      getKnowledgeEntries,
      getNovel,
      hashChatTurnRequest,
      updateNovel,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      approveExplicitWritingPlanForClaim,
      finalizeApprovedStoryDeckForClaim,
    } = await import('@/lib/brainstorm-agent');
    const {
      __setBrainstormMutationFaultForTest,
      ensureBrainstormReceipt,
    } = await import('@/lib/brainstorm-receipts');

    const acquire = (novelId: string, userMessageId: string) => {
      const claim = beginChatTurn({
        novelId,
        userMessageId,
        requestHash: hashChatTurnRequest({
          content: userMessageId,
          mode: 'ordinary',
        }),
        assistantMessageId: `assistant-${userMessageId}`,
      });
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected special branch claim');
      }
      const receiptId = ensureBrainstormReceipt(
        novelId,
        claim.turn.brainstormReceiptId,
      );
      expect(attachChatTurnBrainstormReceipt(
        novelId,
        userMessageId,
        receiptId,
        claim.turn.claimToken,
      )).toBe(true);
      return { claimToken: claim.turn.claimToken, receiptId };
    };
    const expectEmptyReceipt = (receiptId: string) => {
      expect(getDb().prepare(
        'SELECT profile_json, entries_json FROM brainstorm_receipts WHERE id = ?',
      ).get(receiptId)).toEqual({ profile_json: null, entries_json: '[]' });
    };

    const repairNovel = await createNovel({
      userId: 'local-user',
      title: 'Claimed repair',
    });
    const approvalNovel = await createNovel({
      userId: 'local-user',
      title: 'Claimed approval',
    });
    try {
      const repair = acquire(repairNovel.id, 'claimed-repair-turn');
      __setBrainstormMutationFaultForTest({ point: 'during_receipt_persist' });
      await expect(finalizeApprovedStoryDeckForClaim({
        novelId: repairNovel.id,
        locale: 'en',
        receiptId: repair.receiptId,
        userMessageId: 'claimed-repair-turn',
        claimToken: repair.claimToken,
      })).rejects.toThrow('INJECTED_BRAINSTORM_FAULT_DURING_RECEIPT_PERSIST');
      expect((await getNovel(repairNovel.id))?.stage).toBe('discovery_interview');
      expect(await getKnowledgeEntries(repairNovel.id)).toEqual([]);
      expect(getDb().prepare(
        'SELECT COUNT(*) AS count FROM knowledge_index WHERE novel_id = ?',
      ).get(repairNovel.id)).toEqual({ count: 0 });
      expect(getDb().prepare(
        'SELECT COUNT(*) AS count FROM knowledge_vault_outbox WHERE novel_id = ?',
      ).get(repairNovel.id)).toEqual({ count: 0 });
      expectEmptyReceipt(repair.receiptId);
      await expect(finalizeApprovedStoryDeckForClaim({
        novelId: repairNovel.id,
        locale: 'en',
        receiptId: repair.receiptId,
        userMessageId: 'claimed-repair-turn',
        claimToken: 'stale-claim-token',
      })).rejects.toThrow('Chat turn claim lost');
      expect(await getKnowledgeEntries(repairNovel.id)).toEqual([]);

      await updateNovel(approvalNovel.id, {
        genre: 'Mystery',
        storySummary: 'A complete story.',
        characterSummary: 'A complete cast.',
        arcSummary: 'A complete arc.',
      });
      const now = '2026-07-30T06:07:08.000Z';
      for (const [index, type] of (
        ['character', 'world', 'outline'] as const
      ).entries()) {
        await createKnowledgeEntry({
          id: crypto.randomUUID(),
          novelId: approvalNovel.id,
          type,
          title: `${type} card`,
          summary: `${type} summary`,
          data: '{}',
          sortOrder: index,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
      }
      const approval = acquire(approvalNovel.id, 'claimed-approval-turn');
      __setBrainstormMutationFaultForTest({ point: 'during_receipt_persist' });
      await expect(approveExplicitWritingPlanForClaim({
        novelId: approvalNovel.id,
        receiptId: approval.receiptId,
        userMessageId: 'claimed-approval-turn',
        claimToken: approval.claimToken,
      })).rejects.toThrow('INJECTED_BRAINSTORM_FAULT_DURING_RECEIPT_PERSIST');
      expect((await getNovel(approvalNovel.id))?.stage).toBe('discovery_interview');
      expectEmptyReceipt(approval.receiptId);

      await expect(approveExplicitWritingPlanForClaim({
        novelId: approvalNovel.id,
        receiptId: approval.receiptId,
        userMessageId: 'claimed-approval-turn',
        claimToken: approval.claimToken,
      })).resolves.toMatchObject({ ok: true, alreadyReady: false });
      expect((await getNovel(approvalNovel.id))?.stage).toBe('ready_for_greenlight');
      expect(getDb().prepare(
        'SELECT profile_json FROM brainstorm_receipts WHERE id = ?',
      ).get(approval.receiptId)).toEqual({
        profile_json: expect.stringContaining('"fields"'),
      });
    } finally {
      __setBrainstormMutationFaultForTest(null);
      await deleteNovelCascade(repairNovel.id, 'local-user');
      await deleteNovelCascade(approvalNovel.id, 'local-user');
    }
  });
});
