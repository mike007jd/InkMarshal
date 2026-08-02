import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-chat-turns-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('chat_turns persistence primitives', () => {
  it('classifies only an unambiguous novel-scoped v0.1.5 Stop receipt', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { insertAiRun } = await import('@/lib/db/queries-ai-runs');
    const { getDb } = await import('@/lib/db/connection');
    const { countWords } = await import('@/lib/utils');
    const {
      beginChatTurn,
      getChatTurn,
      hasLegacyStoppedChatTurn,
      hashChatTurnRequest,
      persistChatTurnAssistantMessage,
    } = await import('@/lib/db/queries-chat-turns');
    const novel = await createNovel({ userId: 'local-user', title: 'Legacy Stop Scope' });
    const otherNovel = await createNovel({ userId: 'local-user', title: 'Other Legacy Scope' });

    const persistSucceeded = (userMessageId: string, assistantMessageId: string, text: string) => {
      const claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({ content: userMessageId, mode: 'conversation' }),
        assistantMessageId,
      });
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected legacy test claim');
      }
      persistChatTurnAssistantMessage({
        novelId: novel.id,
        userMessageId,
        claimToken: claim.turn.claimToken,
        assistantMessageId,
        responseText: text,
      });
      const turn = getChatTurn(novel.id, userMessageId);
      if (!turn) throw new Error('Expected persisted legacy test turn');
      return turn;
    };

    try {
      const partial = 'A durable partial from the old conversation Stop path.';
      let turn = persistSucceeded('legacy-user', 'legacy-assistant', partial);
      const legacyAt = '2042-03-04T05:06:07.000Z';
      getDb().prepare(
        'UPDATE chat_turns SET updated_at = ? WHERE novel_id = ? AND user_message_id = ?',
      ).run(legacyAt, novel.id, turn.userMessageId);
      turn = getChatTurn(novel.id, turn.userMessageId) ?? turn;
      insertAiRun({
        novelId: otherNovel.id,
        operation: 'chat',
        outcome: 'cancelled',
        generatedWords: countWords(partial),
      });
      expect(hasLegacyStoppedChatTurn(turn)).toBe(false);

      const legacyRunId = insertAiRun({
        operation: 'chat',
        outcome: 'cancelled',
        generatedWords: countWords(partial) + 4,
      });
      getDb().prepare('UPDATE ai_runs SET created_at = ? WHERE id = ?')
        .run(legacyAt, legacyRunId);
      expect(hasLegacyStoppedChatTurn(turn)).toBe(true);

      const ambiguousRunId = insertAiRun({
        operation: 'chat',
        outcome: 'cancelled',
        generatedWords: countWords(partial) + 8,
      });
      getDb().prepare('UPDATE ai_runs SET created_at = ? WHERE id = ?')
        .run(legacyAt, ambiguousRunId);
      expect(hasLegacyStoppedChatTurn(turn)).toBe(false);

      const competing = persistSucceeded('competing-user', 'competing-assistant', 'Concurrent response');
      getDb().prepare(
        'UPDATE chat_turns SET updated_at = ? WHERE novel_id = ? AND user_message_id = ?',
      ).run(legacyAt, novel.id, competing.userMessageId);
      expect(hasLegacyStoppedChatTurn(turn)).toBe(false);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
      await deleteNovelCascade(otherNovel.id, 'local-user');
    }
  });

  it('acquires via INSERT ON CONFLICT, rejects collisions, and reclaims failed turns', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const {
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      completeChatTurn,
      failChatTurn,
      getChatTurn,
      hashChatTurnRequest,
    } = await import('@/lib/db/queries-chat-turns');

    const novel = await createNovel({ userId: 'local-user', title: 'Chat Turns' });
    const userMessageId = 'turn-user-1';
    const requestHash = hashChatTurnRequest({ content: 'hello', mode: 'ordinary' });
    const assistantMessageId = 'assistant-1';

    try {
      const first = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId,
      });
      expect(first.kind).toBe('acquired');
      if (first.kind !== 'acquired' || !first.turn.claimToken) {
        throw new Error('Expected first claim');
      }

      const concurrent = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId,
      });
      expect(concurrent.kind).toBe('in_progress');

      const collision = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({ content: 'different', mode: 'ordinary' }),
        assistantMessageId,
      });
      expect(collision.kind).toBe('collision');

      expect(attachChatTurnBrainstormReceipt(
        novel.id,
        userMessageId,
        'receipt-keep-me',
        first.turn.claimToken,
      )).toBe(true);
      failChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken: first.turn.claimToken,
        errorCode: 'provider_failed',
      });
      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'failed',
        claimToken: null,
        errorCode: 'provider_failed',
        brainstormReceiptId: 'receipt-keep-me',
      });

      const retry = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId,
      });
      expect(retry.kind).toBe('acquired');
      expect(retry.turn.brainstormReceiptId).toBe('receipt-keep-me');
      if (retry.kind !== 'acquired' || !retry.turn.claimToken) {
        throw new Error('Expected retry claim');
      }

      completeChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken: retry.turn.claimToken,
        responseText: 'stable reply',
      });
      const replay = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId,
      });
      expect(replay).toMatchObject({
        kind: 'replay',
        turn: { status: 'succeeded', responseText: 'stable reply' },
      });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('fences a reclaimed generation from stale complete, fail, cancel, and receipt writes', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      CHAT_TURN_STALE_LEASE_MS,
      attachChatTurnBrainstormReceipt,
      beginChatTurn,
      cancelChatTurn,
      failChatTurn,
      findNovelMessageById,
      getChatTurn,
      hashChatTurnRequest,
      persistChatTurnAssistantMessage,
    } = await import('@/lib/db/queries-chat-turns');
    const novel = await createNovel({ userId: 'local-user', title: 'Fenced Chat Turn' });
    const userMessageId = 'fenced-user';
    const requestHash = hashChatTurnRequest({ content: 'fence me', mode: 'ordinary' });

    try {
      const workerA = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId: 'fenced-assistant',
      });
      if (workerA.kind !== 'acquired' || !workerA.turn.claimToken) {
        throw new Error('Worker A did not acquire');
      }
      getDb().prepare(
        `UPDATE chat_turns SET updated_at = ?
          WHERE novel_id = ? AND user_message_id = ?`,
      ).run(
        new Date(Date.now() - CHAT_TURN_STALE_LEASE_MS - 1_000).toISOString(),
        novel.id,
        userMessageId,
      );
      const workerB = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash,
        assistantMessageId: 'fenced-assistant',
      });
      if (workerB.kind !== 'acquired' || !workerB.turn.claimToken) {
        throw new Error('Worker B did not reclaim');
      }
      expect(workerB.turn.claimToken).not.toBe(workerA.turn.claimToken);

      expect(attachChatTurnBrainstormReceipt(
        novel.id,
        userMessageId,
        'stale-receipt',
        workerA.turn.claimToken,
      )).toBe(false);
      expect(persistChatTurnAssistantMessage({
        novelId: novel.id,
        userMessageId,
        claimToken: workerA.turn.claimToken,
        assistantMessageId: 'fenced-assistant',
        responseText: 'stale completion',
      })).toBeNull();
      expect(findNovelMessageById(novel.id, 'fenced-assistant')).toBeNull();
      expect(failChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken: workerA.turn.claimToken,
      })).toBeNull();
      expect(cancelChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken: workerA.turn.claimToken,
      })).toBeNull();
      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'running',
        claimToken: workerB.turn.claimToken,
        brainstormReceiptId: null,
      });

      expect(attachChatTurnBrainstormReceipt(
        novel.id,
        userMessageId,
        'winner-receipt',
        workerB.turn.claimToken,
      )).toBe(true);
      expect(persistChatTurnAssistantMessage({
        novelId: novel.id,
        userMessageId,
        claimToken: workerB.turn.claimToken,
        assistantMessageId: 'fenced-assistant',
        responseText: 'winner completion',
      })).toMatchObject({
        role: 'assistant',
        content: 'winner completion',
      });
      expect(getChatTurn(novel.id, userMessageId)).toMatchObject({
        status: 'succeeded',
        claimToken: null,
        errorCode: null,
        responseText: 'winner completion',
      });
      expect(failChatTurn({
        novelId: novel.id,
        userMessageId,
        claimToken: workerA.turn.claimToken,
      })).toBeNull();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('keeps a fresh running row in_progress and reclaims a stale running row with one winner', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      CHAT_TURN_STALE_LEASE_MS,
      beginChatTurn,
      getChatTurn,
      hashChatTurnRequest,
    } = await import('@/lib/db/queries-chat-turns');

    const novel = await createNovel({ userId: 'local-user', title: 'Stale Chat Turns' });
    const freshId = 'fresh-running-user';
    const staleId = 'stale-running-user';
    const requestHash = hashChatTurnRequest({ content: 'lease me', mode: 'ordinary' });

    try {
      expect(CHAT_TURN_STALE_LEASE_MS).toBeGreaterThan(300_000);

      const fresh = beginChatTurn({
        novelId: novel.id,
        userMessageId: freshId,
        requestHash,
        assistantMessageId: 'assistant-fresh',
      });
      expect(fresh.kind).toBe('acquired');
      expect(beginChatTurn({
        novelId: novel.id,
        userMessageId: freshId,
        requestHash,
        assistantMessageId: 'assistant-fresh',
      }).kind).toBe('in_progress');

      const staleAcquire = beginChatTurn({
        novelId: novel.id,
        userMessageId: staleId,
        requestHash,
        assistantMessageId: 'assistant-stale',
      });
      expect(staleAcquire.kind).toBe('acquired');
      getDb()
        .prepare(
          `UPDATE chat_turns
              SET brainstorm_receipt_id = ?, updated_at = ?
            WHERE novel_id = ? AND user_message_id = ?`,
        )
        .run(
          'stale-receipt',
          new Date(Date.now() - CHAT_TURN_STALE_LEASE_MS - 1_000).toISOString(),
          novel.id,
          staleId,
        );
      expect(getChatTurn(novel.id, staleId)?.status).toBe('running');

      const started = [
        beginChatTurn({
          novelId: novel.id,
          userMessageId: staleId,
          requestHash,
          assistantMessageId: 'assistant-stale',
        }),
        beginChatTurn({
          novelId: novel.id,
          userMessageId: staleId,
          requestHash,
          assistantMessageId: 'assistant-stale',
        }),
      ];
      const kinds = started.map(result => result.kind).sort();
      expect(kinds).toEqual(['acquired', 'in_progress']);
      const winner = started.find(result => result.kind === 'acquired');
      expect(winner?.turn.brainstormReceiptId).toBe('stale-receipt');
      expect(getChatTurn(novel.id, freshId)?.status).toBe('running');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('hashes distinguish semantic operation modes for the same content', async () => {
    const { hashChatTurnRequest } = await import('@/lib/db/queries-chat-turns');
    const content = 'Approve writing and begin chapter one.';
    expect(hashChatTurnRequest({ content, mode: 'ordinary' }))
      .not.toBe(hashChatTurnRequest({ content, mode: 'explicit_approval' }));
    expect(hashChatTurnRequest({ content, mode: 'ordinary' }))
      .not.toBe(hashChatTurnRequest({ content, mode: 'repair_story_deck' }));
    expect(hashChatTurnRequest({ content, mode: 'conversation', conversationId: 'a' }))
      .not.toBe(hashChatTurnRequest({ content, mode: 'conversation', conversationId: 'b' }));
  });

  it('fails closed when a durable tool snapshot payload is tampered', async () => {
    const { createHash } = await import('node:crypto');
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const {
      beginChatTurn,
      hashChatTurnRequest,
      prepareChatTurnToolCall,
      readChatTurnToolSnapshot,
    } = await import('@/lib/db/queries-chat-turns');
    const novel = await createNovel({ userId: 'local-user', title: 'Snapshot Integrity' });
    const userMessageId = 'snapshot-integrity-turn';
    const toolKey = createHash('sha256').update('integrity-tool').digest('hex');
    const payload = JSON.stringify({ before: 'writer-owned state' });
    const snapshotKey = createHash('sha256').update(payload).digest('hex');

    try {
      const claim = beginChatTurn({
        novelId: novel.id,
        userMessageId,
        requestHash: hashChatTurnRequest({ content: 'integrity', mode: 'ordinary' }),
        assistantMessageId: 'snapshot-integrity-assistant',
      });
      if (claim.kind !== 'acquired' || !claim.turn.claimToken) {
        throw new Error('Expected snapshot integrity claim');
      }
      const claimToken = claim.turn.claimToken;
      expect(prepareChatTurnToolCall({
        novelId: novel.id,
        userMessageId,
        claimToken,
        toolKey,
        toolName: 'integrityTool',
        argsHash: createHash('sha256').update('integrity-args').digest('hex'),
        preparedData: { snapshotKey },
        snapshots: [{ snapshotKey, payload }],
      }).kind).toBe('prepared');

      getDb().prepare(
        `UPDATE chat_turn_tool_snapshots
            SET payload = ?
          WHERE novel_id = ? AND user_message_id = ?
            AND tool_key = ? AND snapshot_key = ?`,
      ).run(
        JSON.stringify({ before: 'tampered state' }),
        novel.id,
        userMessageId,
        toolKey,
        snapshotKey,
      );
      expect(() => readChatTurnToolSnapshot({
        novelId: novel.id,
        userMessageId,
        claimToken,
        toolKey,
        snapshotKey,
      })).toThrow('snapshot integrity check failed');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
