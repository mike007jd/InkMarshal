import 'server-only';

import { createHash } from 'node:crypto';
import {
  deleteKnowledgeEntry,
  getKnowledgeEntries,
  getNovel,
  updateNovel,
  type KnowledgeEntryRow,
  type Novel,
} from '@/lib/db';
import {
  type ChatTurnToolSnapshotInput,
  completeChatTurnToolCall,
  prepareChatTurnToolCall,
  readChatTurnToolSnapshot,
} from '@/lib/db/queries-chat-turns';
import { upsertKnowledgeEntryByTitle } from '@/lib/knowledge/upsert-entry';
import type { KnowledgeType } from '@/lib/types/knowledge';
import { parseJsonField } from '@/lib/utils';

const RECEIPT_LIFETIME_MS = 10 * 60_000;
const BRAINSTORM_UNDO_WINDOW_MS = 30_000;

const PROFILE_FIELDS = [
  'genre',
  'targetWords',
  'storySummary',
  'characterSummary',
  'arcSummary',
  'stage',
  'progress',
  'interviewState',
] as const;

type ProfileField = typeof PROFILE_FIELDS[number];
export type BrainstormProfileSnapshot = Pick<Novel, ProfileField>;

interface EntryMutation {
  key: string;
  before: KnowledgeEntryRow | null;
  after: KnowledgeEntryRow;
  action: 'created' | 'updated';
}

interface InternalReceipt {
  id: string;
  novelId: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  undoExpiresAt: number | null;
  undone: boolean;
  profile: {
    before: BrainstormProfileSnapshot;
    after: BrainstormProfileSnapshot;
    fields: Set<ProfileField>;
  } | null;
  entries: Map<string, EntryMutation>;
}

export interface BrainstormReceiptView {
  id: string;
  profileFields: ProfileField[];
  storyEntries: Array<{
    type: string;
    title: string;
    action: 'created' | 'updated';
  }>;
  undoExpiresAt: number;
}

type RegistryGlobal = typeof globalThis & {
  __inkmarshalBrainstormReceipts?: Map<string, InternalReceipt>;
  __inkmarshalBrainstormToolExecutions?: Map<string, Promise<unknown>>;
};

const registryGlobal = globalThis as RegistryGlobal;
const receipts: Map<string, InternalReceipt> = registryGlobal.__inkmarshalBrainstormReceipts
  ?? (registryGlobal.__inkmarshalBrainstormReceipts = new Map<string, InternalReceipt>());
const toolExecutions = registryGlobal.__inkmarshalBrainstormToolExecutions
  ?? (registryGlobal.__inkmarshalBrainstormToolExecutions = new Map<string, Promise<unknown>>());

export interface DurableBrainstormToolContext {
  receiptId: string;
  userMessageId: string;
  claimToken: string;
}

export type DurableToolRecovery<TResult> =
  | { state: 'already_after'; result: TResult }
  | { state: 'safe_to_execute' }
  | { state: 'conflict' };

export function durableBrainstormSnapshot(value: unknown): ChatTurnToolSnapshotInput {
  const payload = JSON.stringify(value);
  return {
    snapshotKey: createHash('sha256').update(payload).digest('hex'),
    payload,
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value !== 'object') {
    return `${typeof value}:${JSON.stringify(value)}`;
  }
  if (Array.isArray(value)) return `array:[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `object:{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}

/**
 * Execute one semantic tool mutation exactly once for a durable chat turn.
 * The SQLite ledger survives provider failure/process restart; the in-process
 * promise only coalesces parallel duplicate calls from one provider step.
 */
export async function runDurableBrainstormTool<TPrepared, TResult>(args: {
  novelId: string;
  context: DurableBrainstormToolContext;
  toolName: string;
  input: unknown;
  prepare: () => Promise<TPrepared>;
  externalizePrepared?: (prepared: TPrepared) => {
    preparedData: unknown;
    snapshots: readonly ChatTurnToolSnapshotInput[];
  };
  hydratePrepared?: (
    preparedData: unknown,
    readSnapshot: <T>(snapshotKey: string) => T,
  ) => TPrepared;
  execute: (prepared: TPrepared) => Promise<TResult>;
  recover: (prepared: TPrepared) => Promise<DurableToolRecovery<TResult>>;
}): Promise<TResult> {
  const canonicalInput = canonicalJson(args.input);
  const argsHash = createHash('sha256')
    .update('inkmarshal.brainstorm-tool-args:v1:')
    .update(args.toolName)
    .update('\0')
    .update(canonicalInput)
    .digest('hex');
  // One semantic slot per tool name in a turn. A provider retry may emit a
  // different tool-call id or even different arguments; neither may create a
  // second mutation after the first intent was durably frozen.
  const toolKey = createHash('sha256')
    .update('inkmarshal.brainstorm-tool-slot:v1:')
    .update(args.toolName)
    .digest('hex');
  const executionKey = [
    args.novelId,
    args.context.userMessageId,
    args.context.claimToken,
    toolKey,
  ].join(':');
  const active = toolExecutions.get(executionKey) as Promise<TResult> | undefined;
  if (active) return active;

  const execution = (async (): Promise<TResult> => {
    const proposedPrepared = await args.prepare();
    const externalized = args.externalizePrepared?.(proposedPrepared) ?? {
      preparedData: proposedPrepared,
      snapshots: [],
    };
    const ledger = prepareChatTurnToolCall({
      novelId: args.novelId,
      userMessageId: args.context.userMessageId,
      claimToken: args.context.claimToken,
      toolKey,
      toolName: args.toolName,
      argsHash,
      preparedData: externalized.preparedData,
      snapshots: externalized.snapshots,
    });
    if (ledger.kind === 'lost_claim') {
      throw new Error('Chat turn claim lost before brainstorm tool execution');
    }
    const hydrate = (preparedData: unknown): TPrepared => {
      if (!args.hydratePrepared) return preparedData as TPrepared;
      return args.hydratePrepared(
        preparedData,
        <T>(snapshotKey: string) => readChatTurnToolSnapshot<T>({
          novelId: args.novelId,
          userMessageId: args.context.userMessageId,
          claimToken: args.context.claimToken,
          toolKey,
          snapshotKey,
        }),
      );
    };
    if (ledger.kind === 'completed') {
      // Rebuild the in-memory undo receipt after a process restart. The cached
      // result remains authoritative; recovery only verifies the postcondition
      // and reconstructs before/after receipt metadata when it still matches.
      const recovery = await args.recover(hydrate(ledger.preparedData));
      if (recovery.state === 'conflict') {
        throw new Error('Durable brainstorm tool state conflict');
      }
      return ledger.result as TResult;
    }

    const prepared = hydrate(ledger.preparedData);
    let result: TResult;
    if (ledger.newlyPrepared) {
      result = await args.execute(prepared);
    } else {
      const recovery = await args.recover(prepared);
      if (recovery.state === 'conflict') {
        throw new Error('Durable brainstorm tool state conflict');
      }
      result = recovery.state === 'already_after'
        ? recovery.result
        : await args.execute(prepared);
    }
    if (!completeChatTurnToolCall({
      novelId: args.novelId,
      userMessageId: args.context.userMessageId,
      claimToken: args.context.claimToken,
      toolKey,
      toolName: args.toolName,
      argsHash,
      result,
    })) {
      throw new Error('Chat turn claim lost after brainstorm tool execution');
    }
    return result;
  })();
  toolExecutions.set(executionKey, execution);
  try {
    return await execution;
  } finally {
    if (toolExecutions.get(executionKey) === execution) {
      toolExecutions.delete(executionKey);
    }
  }
}

function cleanupExpiredReceipts(now = Date.now()): void {
  for (const [id, receipt] of receipts) {
    if (receipt.expiresAt <= now || (receipt.undone && receipt.consumedAt !== null)) {
      receipts.delete(id);
    }
  }
}

export function brainstormProfileSnapshot(novel: Novel): BrainstormProfileSnapshot {
  return Object.fromEntries(
    PROFILE_FIELDS.map(field => [field, novel[field]]),
  ) as BrainstormProfileSnapshot;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameKnowledgeEntry(left: KnowledgeEntryRow, right: KnowledgeEntryRow): boolean {
  return left.id === right.id
    && left.type === right.type
    && left.title === right.title
    && left.summary === right.summary
    && left.data === right.data
    && left.tags === right.tags
    && left.updated_at === right.updated_at;
}

export function beginBrainstormReceipt(novelId: string): string {
  cleanupExpiredReceipts();
  const id = crypto.randomUUID();
  receipts.set(id, {
    id,
    novelId,
    createdAt: Date.now(),
    expiresAt: Date.now() + RECEIPT_LIFETIME_MS,
    consumedAt: null,
    undoExpiresAt: null,
    undone: false,
    profile: null,
    entries: new Map(),
  });
  return id;
}

/**
 * Reuse a durable chat-turn receipt id across retries. After process restart the
 * in-memory undo shell is empty — knowledge/profile writes stay upsert-idempotent
 * (or fail-closed); only the undo window metadata is lost.
 */
export function ensureBrainstormReceipt(
  novelId: string,
  existingId?: string | null,
): string {
  cleanupExpiredReceipts();
  if (!existingId) return beginBrainstormReceipt(novelId);

  const existing = receipts.get(existingId);
  if (existing && existing.novelId === novelId && !existing.undone) {
    existing.expiresAt = Date.now() + RECEIPT_LIFETIME_MS;
    return existingId;
  }

  receipts.set(existingId, {
    id: existingId,
    novelId,
    createdAt: Date.now(),
    expiresAt: Date.now() + RECEIPT_LIFETIME_MS,
    consumedAt: null,
    undoExpiresAt: null,
    undone: false,
    profile: null,
    entries: new Map(),
  });
  return existingId;
}

export function recordBrainstormProfileMutation(
  receiptId: string,
  beforeNovel: Novel,
  afterNovel: Novel,
): void {
  recordBrainstormProfileSnapshotMutation(
    receiptId,
    beforeNovel.id,
    brainstormProfileSnapshot(beforeNovel),
    afterNovel,
  );
}

export function recordBrainstormProfileSnapshotMutation(
  receiptId: string,
  novelId: string,
  before: BrainstormProfileSnapshot,
  afterNovel: Novel,
): void {
  const receipt = receipts.get(receiptId);
  if (!receipt || receipt.novelId !== novelId || receipt.novelId !== afterNovel.id) return;
  const after = brainstormProfileSnapshot(afterNovel);
  const changedFields = PROFILE_FIELDS.filter(field => !sameValue(before[field], after[field]));
  if (changedFields.length === 0) return;

  if (!receipt.profile) {
    receipt.profile = { before, after, fields: new Set(changedFields) };
    return;
  }
  receipt.profile.after = after;
  for (const field of changedFields) receipt.profile.fields.add(field);
}

export function recordBrainstormEntryMutation(
  receiptId: string,
  before: KnowledgeEntryRow | null,
  after: KnowledgeEntryRow,
  action: 'created' | 'updated',
): void {
  const receipt = receipts.get(receiptId);
  if (!receipt || receipt.novelId !== after.novel_id) return;
  const key = `${after.type}:${after.title.trim().toLowerCase()}`;
  const existing = receipt.entries.get(key);
  receipt.entries.set(key, {
    key,
    before: existing?.before ?? before,
    after,
    action: existing?.before ? 'updated' : action,
  });
}

export function consumeLatestBrainstormReceipt(novelId: string): BrainstormReceiptView | null {
  cleanupExpiredReceipts();
  const receipt = Array.from(receipts.values())
    .filter(candidate => (
      candidate.novelId === novelId
      && candidate.consumedAt === null
      && !candidate.undone
      && (candidate.profile !== null || candidate.entries.size > 0)
    ))
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (!receipt) return null;

  const now = Date.now();
  receipt.consumedAt = now;
  receipt.undoExpiresAt = now + BRAINSTORM_UNDO_WINDOW_MS;
  return {
    id: receipt.id,
    profileFields: receipt.profile ? Array.from(receipt.profile.fields) : [],
    storyEntries: Array.from(receipt.entries.values()).map(entry => ({
      type: entry.after.type,
      title: entry.after.title,
      action: entry.action,
    })),
    undoExpiresAt: receipt.undoExpiresAt,
  };
}

export async function undoBrainstormReceipt(
  novelId: string,
  receiptId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'expired' | 'conflict' }> {
  cleanupExpiredReceipts();
  const receipt = receipts.get(receiptId);
  if (!receipt || receipt.novelId !== novelId || receipt.undone) {
    return { ok: false, reason: 'not_found' };
  }
  if (!receipt.undoExpiresAt || Date.now() > receipt.undoExpiresAt) {
    return { ok: false, reason: 'expired' };
  }

  const currentNovel = await getNovel(novelId);
  if (!currentNovel) return { ok: false, reason: 'not_found' };
  if (receipt.profile) {
    for (const field of receipt.profile.fields) {
      if (!sameValue(currentNovel[field], receipt.profile.after[field])) {
        return { ok: false, reason: 'conflict' };
      }
    }
  }

  const currentByKey = new Map(
    (await getKnowledgeEntries(novelId)).map(entry => [
      `${entry.type}:${entry.title.trim().toLowerCase()}`,
      entry,
    ]),
  );
  for (const mutation of receipt.entries.values()) {
    const current = currentByKey.get(mutation.key);
    if (!current || !sameKnowledgeEntry(current, mutation.after)) {
      return { ok: false, reason: 'conflict' };
    }
  }

  for (const mutation of Array.from(receipt.entries.values()).reverse()) {
    if (!mutation.before) {
      await deleteKnowledgeEntry(mutation.after.id);
      continue;
    }
    await upsertKnowledgeEntryByTitle({
      novelId,
      type: mutation.before.type as KnowledgeType,
      title: mutation.before.title,
      data: parseJsonField<Record<string, unknown>>(mutation.before.data, {}),
      tags: parseJsonField<string[]>(mutation.before.tags, []),
      context: 'brainstormReceipt.undo',
    });
  }
  if (receipt.profile) {
    await updateNovel(novelId, receipt.profile.before);
  }

  receipt.undone = true;
  return { ok: true };
}
