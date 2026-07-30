import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db/connection';
import { mapMessage, type Message } from '@/lib/db-types';
import { touchNovelUpdatedAt } from '@/lib/db/transactions';
import { nowIso } from '@/lib/utils';

const CHAT_TURN_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type ChatTurnStatus = (typeof CHAT_TURN_STATUSES)[number];

/**
 * Conservative lease for reclaiming abandoned `running` rows.
 * Must exceed route `maxDuration` (300s); 10 minutes leaves headroom for
 * cleanup after a crashed provider stream.
 */
export const CHAT_TURN_STALE_LEASE_MS = 10 * 60 * 1000;

export const CHAT_TURN_MODES = [
  'ordinary',
  'repair_story_deck',
  'explicit_approval',
  'conversation',
] as const;

export type ChatTurnMode = (typeof CHAT_TURN_MODES)[number];

export interface ChatTurn {
  novelId: string;
  userMessageId: string;
  requestHash: string;
  assistantMessageId: string;
  status: ChatTurnStatus;
  /** Present only while this process owns the current running generation. */
  claimToken: string | null;
  brainstormReceiptId: string | null;
  responseText: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BeginChatTurnResult =
  | { kind: 'acquired'; turn: ChatTurn }
  | { kind: 'replay'; turn: ChatTurn }
  | { kind: 'in_progress'; turn: ChatTurn }
  | { kind: 'collision'; turn: ChatTurn };

const TOOL_LEDGER_PREFIX = 'INKMARSHAL_CHAT_TOOL_LEDGER_V1:';

interface ChatToolLedgerEntry {
  toolName: string;
  argsHash: string;
  status: 'prepared' | 'completed';
  preparedData: unknown;
  result?: unknown;
}

interface ChatToolLedger {
  version: 1;
  entries: Record<string, ChatToolLedgerEntry>;
}

export type PrepareChatTurnToolCallResult =
  | { kind: 'lost_claim' }
  | {
      kind: 'prepared' | 'completed';
      preparedData: unknown;
      result?: unknown;
      newlyPrepared: boolean;
    };

export interface ChatTurnToolSnapshotInput {
  snapshotKey: string;
  payload: string;
}

interface ChatTurnRow {
  novel_id: string;
  user_message_id: string;
  request_hash: string;
  assistant_message_id: string;
  status: ChatTurnStatus;
  brainstorm_receipt_id: string | null;
  response_text: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

function mapChatTurn(row: ChatTurnRow): ChatTurn {
  const responseText = row.response_text?.startsWith(TOOL_LEDGER_PREFIX)
    ? null
    : row.response_text;
  return {
    novelId: row.novel_id,
    userMessageId: row.user_message_id,
    requestHash: row.request_hash,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    claimToken: row.status === 'running' ? row.error_code : null,
    brainstormReceiptId: row.brainstorm_receipt_id,
    responseText,
    errorCode: row.status === 'running' ? null : row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseChatToolLedger(value: string | null): ChatToolLedger {
  if (!value?.startsWith(TOOL_LEDGER_PREFIX)) {
    return { version: 1, entries: {} };
  }
  try {
    const parsed = JSON.parse(value.slice(TOOL_LEDGER_PREFIX.length)) as ChatToolLedger;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      throw new Error('invalid ledger shape');
    }
    return parsed;
  } catch {
    throw new Error('Corrupt durable chat tool ledger');
  }
}

function serializeChatToolLedger(ledger: ChatToolLedger): string {
  const serialized = `${TOOL_LEDGER_PREFIX}${JSON.stringify(ledger)}`;
  if (Buffer.byteLength(serialized, 'utf8') > 512 * 1024) {
    throw new Error('Durable chat tool ledger exceeds 512 KiB');
  }
  return serialized;
}

/** Stable request fingerprint — mode/conversation bind semantic branch identity. */
export function hashChatTurnRequest(args: {
  content: string;
  mode: ChatTurnMode;
  conversationId?: string | null;
}): string {
  return createHash('sha256')
    .update('inkmarshal.chat-turn-request:v1:')
    .update(args.mode)
    .update('\0')
    .update(args.conversationId ?? '')
    .update('\0')
    .update(args.content)
    .digest('hex');
}

export function getChatTurn(
  novelId: string,
  userMessageId: string,
): ChatTurn | null {
  const row = getDb()
    .prepare(
      `SELECT novel_id, user_message_id, request_hash, assistant_message_id, status,
              brainstorm_receipt_id, response_text, error_code, created_at, updated_at
         FROM chat_turns
        WHERE novel_id = ? AND user_message_id = ?`,
    )
    .get(novelId, userMessageId) as ChatTurnRow | undefined;
  return row ? mapChatTurn(row) : null;
}

/**
 * Claim or classify a durable chat turn.
 *
 * Uses INSERT ON CONFLICT (never SELECT-then-INSERT). Reclaims failed/cancelled
 * rows and stale `running` rows past {@link CHAT_TURN_STALE_LEASE_MS}. Retains
 * `brainstorm_receipt_id` across retries so tool undo stays correlated.
 */
export function beginChatTurn(args: {
  novelId: string;
  userMessageId: string;
  requestHash: string;
  assistantMessageId: string;
}): BeginChatTurnResult {
  const db = getDb();
  const now = nowIso();
  const claimToken = randomUUID();
  const staleBefore = new Date(Date.now() - CHAT_TURN_STALE_LEASE_MS).toISOString();

  const insert = db.prepare(
    `INSERT INTO chat_turns (
       novel_id, user_message_id, request_hash, assistant_message_id,
       status, brainstorm_receipt_id, response_text, error_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, ?, ?)
     ON CONFLICT(novel_id, user_message_id) DO UPDATE SET
       status = 'running',
       updated_at = excluded.updated_at,
       error_code = excluded.error_code
     WHERE chat_turns.request_hash = excluded.request_hash
       AND (
         chat_turns.status IN ('failed', 'cancelled')
         OR (
           chat_turns.status = 'running'
           AND chat_turns.updated_at < ?
         )
       )`,
  );

  const write = insert.run(
    args.novelId,
    args.userMessageId,
    args.requestHash,
    args.assistantMessageId,
    claimToken,
    now,
    now,
    staleBefore,
  );

  const turn = getChatTurn(args.novelId, args.userMessageId);
  if (!turn) {
    throw new Error('chat_turns begin failed: row missing after upsert');
  }

  if (turn.requestHash !== args.requestHash) {
    return { kind: 'collision', turn };
  }

  if (turn.status === 'succeeded') {
    return { kind: 'replay', turn };
  }

  if (turn.status === 'running' && write.changes > 0) {
    return { kind: 'acquired', turn };
  }

  if (turn.status === 'running') {
    return { kind: 'in_progress', turn };
  }

  // failed/cancelled with matching hash but reclaim lost the race — treat as in-progress
  // if another worker reclaimed, otherwise surface collision for unexpected states.
  if (turn.status === 'failed' || turn.status === 'cancelled') {
    return { kind: 'in_progress', turn };
  }

  return { kind: 'collision', turn };
}

export function attachChatTurnBrainstormReceipt(
  novelId: string,
  userMessageId: string,
  brainstormReceiptId: string,
  claimToken: string,
): boolean {
  const now = nowIso();
  const write = getDb()
    .prepare(
      `UPDATE chat_turns
          SET brainstorm_receipt_id = ?, updated_at = ?
        WHERE novel_id = ? AND user_message_id = ?
          AND status = 'running'
          AND error_code = ?
          AND (
            brainstorm_receipt_id IS NULL
            OR brainstorm_receipt_id = ?
          )`,
    )
    .run(
      brainstormReceiptId,
      now,
      novelId,
      userMessageId,
      claimToken,
      brainstormReceiptId,
    );
  return write.changes > 0;
}

export function completeChatTurn(args: {
  novelId: string;
  userMessageId: string;
  claimToken: string;
  responseText: string;
}): ChatTurn | null {
  const now = nowIso();
  const db = getDb();
  const write = db.transaction(() => {
    const completed = db.prepare(
      `UPDATE chat_turns
          SET status = 'succeeded',
              response_text = ?,
              error_code = NULL,
              updated_at = ?
        WHERE novel_id = ? AND user_message_id = ?
          AND status = 'running'
          AND error_code = ?`,
    ).run(
      args.responseText,
      now,
      args.novelId,
      args.userMessageId,
      args.claimToken,
    );
    if (completed.changes === 1) {
      db.prepare(
        `DELETE FROM chat_turn_tool_snapshots
          WHERE novel_id = ? AND user_message_id = ?`,
      ).run(args.novelId, args.userMessageId);
    }
    return completed;
  })();
  if (write.changes === 0) return null;
  return getChatTurn(args.novelId, args.userMessageId);
}

export function failChatTurn(args: {
  novelId: string;
  userMessageId: string;
  claimToken: string;
  errorCode?: string;
}): ChatTurn | null {
  const now = nowIso();
  const write = getDb()
    .prepare(
      `UPDATE chat_turns
          SET status = 'failed',
              error_code = ?,
              updated_at = ?
        WHERE novel_id = ? AND user_message_id = ?
          AND status = 'running'
          AND error_code = ?`,
    )
    .run(
      args.errorCode ?? 'provider_failed',
      now,
      args.novelId,
      args.userMessageId,
      args.claimToken,
    );
  if (write.changes === 0) return null;
  return getChatTurn(args.novelId, args.userMessageId);
}

export function cancelChatTurn(args: {
  novelId: string;
  userMessageId: string;
  claimToken: string;
  responseText?: string | null;
}): ChatTurn | null {
  const now = nowIso();
  const write = getDb()
    .prepare(
      `UPDATE chat_turns
          SET status = 'cancelled',
              response_text = CASE
                WHEN instr(response_text, ?) = 1 THEN response_text
                ELSE COALESCE(?, response_text)
              END,
              error_code = NULL,
              updated_at = ?
        WHERE novel_id = ? AND user_message_id = ?
          AND status = 'running'
          AND error_code = ?`,
    )
    .run(
      TOOL_LEDGER_PREFIX,
      args.responseText ?? null,
      now,
      args.novelId,
      args.userMessageId,
      args.claimToken,
    );
  if (write.changes === 0) return null;
  return getChatTurn(args.novelId, args.userMessageId);
}

/**
 * Persist the deterministic assistant row and terminal turn state in one
 * fenced transaction. A reclaimed worker can neither win the message id nor
 * stamp the newer generation complete.
 */
export function persistChatTurnAssistantMessage(args: {
  novelId: string;
  userMessageId: string;
  claimToken: string;
  assistantMessageId: string;
  responseText: string;
  conversationId?: string | null;
}): Message | null {
  const db = getDb();
  const now = nowIso();
  const conversationId = args.conversationId ?? null;

  return db.transaction((): Message | null => {
    const owned = db.prepare(
      `SELECT 1
         FROM chat_turns
        WHERE novel_id = ? AND user_message_id = ?
          AND status = 'running' AND error_code = ?`,
    ).get(args.novelId, args.userMessageId, args.claimToken);
    if (!owned) return null;

    if (conversationId) {
      const conversation = db
        .prepare('SELECT id FROM conversations WHERE id = ? AND novel_id = ?')
        .get(conversationId, args.novelId);
      if (!conversation) throw new Error('Conversation not found');
    }

    const insert = db.prepare(
      `INSERT INTO messages (id, novel_id, role, content, conversation_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      args.assistantMessageId,
      args.novelId,
      args.responseText,
      conversationId,
      now,
    );
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(args.assistantMessageId) as Record<string, unknown> | undefined;
    if (
      !row
      || row.novel_id !== args.novelId
      || row.role !== 'assistant'
      || row.content !== args.responseText
      || ((row.conversation_id as string | null) ?? null) !== conversationId
    ) {
      throw new Error('Message id collision');
    }

    const completed = db.prepare(
      `UPDATE chat_turns
          SET status = 'succeeded',
              response_text = ?,
              error_code = NULL,
              updated_at = ?
        WHERE novel_id = ? AND user_message_id = ?
          AND status = 'running' AND error_code = ?`,
    ).run(
      args.responseText,
      now,
      args.novelId,
      args.userMessageId,
      args.claimToken,
    );
    if (completed.changes !== 1) {
      throw new Error('Chat turn claim lost while persisting assistant');
    }
    db.prepare(
      `DELETE FROM chat_turn_tool_snapshots
        WHERE novel_id = ? AND user_message_id = ?`,
    ).run(args.novelId, args.userMessageId);

    if (insert.changes > 0) {
      if (conversationId) {
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND novel_id = ?')
          .run(now, conversationId, args.novelId);
      }
      touchNovelUpdatedAt(db, args.novelId);
    }
    return mapMessage({
      id: row.id as string,
      novel_id: row.novel_id as string,
      role: 'assistant',
      content: row.content as string,
      conversation_id: conversationId,
      created_at: row.created_at as string,
    });
  })();
}

/**
 * Legacy repair for a succeeded row written by an older build without a
 * replay payload. This is a compare-and-swap repair, not a worker transition.
 */
export function resetEmptySucceededChatTurn(args: {
  novelId: string;
  userMessageId: string;
  requestHash: string;
  assistantMessageId: string;
}): boolean {
  const write = getDb().prepare(
    `UPDATE chat_turns
        SET status = 'failed',
            error_code = 'response_missing',
            updated_at = ?
      WHERE novel_id = ? AND user_message_id = ?
        AND request_hash = ? AND assistant_message_id = ?
        AND status = 'succeeded'
        AND (response_text IS NULL OR response_text = '')`,
  ).run(
    nowIso(),
    args.novelId,
    args.userMessageId,
    args.requestHash,
    args.assistantMessageId,
  );
  return write.changes === 1;
}

/**
 * Persist a tool intent before its database mutation. The existing intent or
 * result wins on retry, so provider-generated tool call ids are irrelevant.
 */
export function prepareChatTurnToolCall(args: {
  novelId: string;
  userMessageId: string;
  claimToken: string;
  toolKey: string;
  toolName: string;
  argsHash: string;
  preparedData: unknown;
  snapshots?: readonly ChatTurnToolSnapshotInput[];
}): PrepareChatTurnToolCallResult {
  const db = getDb();
  return db.transaction((): PrepareChatTurnToolCallResult => {
    const row = db.prepare(
      `SELECT status, error_code, response_text
         FROM chat_turns
        WHERE novel_id = ? AND user_message_id = ?`,
    ).get(args.novelId, args.userMessageId) as
      | { status: ChatTurnStatus; error_code: string | null; response_text: string | null }
      | undefined;
    if (
      !row
      || row.status !== 'running'
      || row.error_code !== args.claimToken
    ) {
      return { kind: 'lost_claim' };
    }

    const ledger = parseChatToolLedger(row.response_text);
    const existing = ledger.entries[args.toolKey];
    if (existing) {
      if (existing.toolName !== args.toolName || existing.argsHash !== args.argsHash) {
        throw new Error('Durable chat tool ledger key collision');
      }
      return {
        kind: existing.status,
        preparedData: existing.preparedData,
        result: existing.result,
        newlyPrepared: false,
      };
    }

    ledger.entries[args.toolKey] = {
      toolName: args.toolName,
      argsHash: args.argsHash,
      status: 'prepared',
      preparedData: args.preparedData,
    };
    for (const snapshot of args.snapshots ?? []) {
      const payloadSha256 = createHash('sha256').update(snapshot.payload).digest('hex');
      if (snapshot.snapshotKey !== payloadSha256) {
        throw new Error('Durable chat tool snapshot key does not match payload');
      }
      db.prepare(
        `INSERT INTO chat_turn_tool_snapshots (
           novel_id, user_message_id, tool_key, snapshot_key,
           payload, payload_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(novel_id, user_message_id, tool_key, snapshot_key) DO NOTHING`,
      ).run(
        args.novelId,
        args.userMessageId,
        args.toolKey,
        snapshot.snapshotKey,
        snapshot.payload,
        payloadSha256,
        nowIso(),
      );
      const stored = db.prepare(
        `SELECT payload, payload_sha256
           FROM chat_turn_tool_snapshots
          WHERE novel_id = ? AND user_message_id = ?
            AND tool_key = ? AND snapshot_key = ?`,
      ).get(
        args.novelId,
        args.userMessageId,
        args.toolKey,
        snapshot.snapshotKey,
      ) as { payload: string; payload_sha256: string } | undefined;
      if (
        !stored
        || stored.payload !== snapshot.payload
        || stored.payload_sha256 !== payloadSha256
      ) {
        throw new Error('Durable chat tool snapshot collision');
      }
    }
    const write = db.prepare(
      `UPDATE chat_turns
          SET response_text = ?, updated_at = ?
        WHERE novel_id = ? AND user_message_id = ?
          AND status = 'running' AND error_code = ?`,
    ).run(
      serializeChatToolLedger(ledger),
      nowIso(),
      args.novelId,
      args.userMessageId,
      args.claimToken,
    );
    if (write.changes !== 1) return { kind: 'lost_claim' };
    return {
      kind: 'prepared',
      preparedData: args.preparedData,
      newlyPrepared: true,
    };
  })();
}

/** Read one claim-fenced, turn-scoped snapshot and verify its payload digest. */
export function readChatTurnToolSnapshot<T>(args: {
  novelId: string;
  userMessageId: string;
  claimToken: string;
  toolKey: string;
  snapshotKey: string;
}): T {
  const row = getDb().prepare(
    `SELECT snapshot.payload, snapshot.payload_sha256
       FROM chat_turn_tool_snapshots snapshot
       JOIN chat_turns turn_row
         ON turn_row.novel_id = snapshot.novel_id
        AND turn_row.user_message_id = snapshot.user_message_id
      WHERE snapshot.novel_id = ? AND snapshot.user_message_id = ?
        AND snapshot.tool_key = ? AND snapshot.snapshot_key = ?
        AND turn_row.status = 'running' AND turn_row.error_code = ?`,
  ).get(
    args.novelId,
    args.userMessageId,
    args.toolKey,
    args.snapshotKey,
    args.claimToken,
  ) as { payload: string; payload_sha256: string } | undefined;
  if (!row) throw new Error('Durable chat tool snapshot missing or claim lost');
  const digest = createHash('sha256').update(row.payload).digest('hex');
  if (digest !== args.snapshotKey || row.payload_sha256 !== digest) {
    throw new Error('Durable chat tool snapshot integrity check failed');
  }
  return JSON.parse(row.payload) as T;
}

/** Stamp a cached tool result only if the caller still owns this generation. */
export function completeChatTurnToolCall(args: {
  novelId: string;
  userMessageId: string;
  claimToken: string;
  toolKey: string;
  toolName: string;
  argsHash: string;
  result: unknown;
}): boolean {
  const db = getDb();
  return db.transaction((): boolean => {
    const row = db.prepare(
      `SELECT status, error_code, response_text
         FROM chat_turns
        WHERE novel_id = ? AND user_message_id = ?`,
    ).get(args.novelId, args.userMessageId) as
      | { status: ChatTurnStatus; error_code: string | null; response_text: string | null }
      | undefined;
    if (
      !row
      || row.status !== 'running'
      || row.error_code !== args.claimToken
    ) {
      return false;
    }
    const ledger = parseChatToolLedger(row.response_text);
    const entry = ledger.entries[args.toolKey];
    if (
      !entry
      || entry.toolName !== args.toolName
      || entry.argsHash !== args.argsHash
    ) {
      throw new Error('Durable chat tool intent missing or mismatched');
    }
    if (entry.status === 'completed') {
      return JSON.stringify(entry.result) === JSON.stringify(args.result);
    }
    entry.status = 'completed';
    entry.result = args.result;
    const write = db.prepare(
      `UPDATE chat_turns
          SET response_text = ?, updated_at = ?
        WHERE novel_id = ? AND user_message_id = ?
          AND status = 'running' AND error_code = ?`,
    ).run(
      serializeChatToolLedger(ledger),
      nowIso(),
      args.novelId,
      args.userMessageId,
      args.claimToken,
    );
    return write.changes === 1;
  })();
}

/** Whether a novel-scoped message row already exists (ignores client metadata). */
export function findNovelMessageById(
  novelId: string,
  messageId: string,
): { id: string; role: string; content: string; conversationId: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT id, role, content, conversation_id
         FROM messages
        WHERE novel_id = ? AND id = ?`,
    )
    .get(novelId, messageId) as
    | { id: string; role: string; content: string; conversation_id: string | null }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    conversationId: row.conversation_id,
  };
}
