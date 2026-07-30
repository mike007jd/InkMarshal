import 'server-only';

import { createHash } from 'node:crypto';
import {
  getKnowledgeEntries,
  getNovel,
  type KnowledgeEntryRow,
  type Novel,
} from '@/lib/db';
import { getDb } from '@/lib/db/connection';
import {
  type ChatTurnToolSnapshotInput,
  mutateAndCompleteChatTurnToolCall,
  prepareChatTurnToolCall,
  readChatTurnToolSnapshot,
} from '@/lib/db/queries-chat-turns';
import { applyNovelUpdate, hydrateNovelRow } from '@/lib/db/queries-novel';
import {
  enqueueKnowledgeVaultDelete,
  enqueueKnowledgeVaultUpsert,
} from '@/lib/db/queries-knowledge-vault-outbox';
import { upsertKnowledgeIndex } from '@/lib/db/queries-vault';
import { mapNovel } from '@/lib/db-types';
import { buildKnowledgeIndexInsert } from '@/lib/knowledge/index-sync';
import { knowledgeEntryIdentityKey } from '@/lib/knowledge/entry-identity';
import type { InterviewStageName } from '@/lib/interview-state';
import { type NovelStage } from '@/lib/novel-stages';
import {
  KNOWLEDGE_TYPES as KNOWLEDGE_TYPE_VALUES,
  type KnowledgeType,
} from '@/lib/types/knowledge';
import { nowIso, parseJsonField } from '@/lib/utils';

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
export type BrainstormProfileSnapshot =
  & Pick<Novel, ProfileField>
  & Partial<Pick<Novel, 'updatedAt'>>;

interface EntryMutation {
  key: string;
  before: KnowledgeEntryRow | null;
  after: KnowledgeEntryRow;
  action: 'created' | 'updated';
}

interface ProfileMutation {
  before: BrainstormProfileSnapshot;
  after: BrainstormProfileSnapshot;
  fields: ProfileField[];
}

interface DurableReceipt {
  id: string;
  novelId: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  undoExpiresAt: number | null;
  undone: boolean;
  profile: ProfileMutation | null;
  entries: EntryMutation[];
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

type BrainstormMutationFaultPoint =
  | 'after_prepare'
  | 'after_recover'
  | 'after_first_mutation'
  | 'during_receipt_persist';

type RegistryGlobal = typeof globalThis & {
  __inkmarshalBrainstormToolExecutions?: Map<string, Promise<unknown>>;
  __inkmarshalBrainstormToolQueues?: Map<string, Promise<void>>;
  __inkmarshalBrainstormUndoFault?: (() => void) | null;
  __inkmarshalBrainstormMutationFault?: {
    point: BrainstormMutationFaultPoint;
    error?: Error;
    hook?: () => void;
  } | null;
};

const registryGlobal = globalThis as RegistryGlobal;
const toolExecutions = registryGlobal.__inkmarshalBrainstormToolExecutions
  ?? (registryGlobal.__inkmarshalBrainstormToolExecutions = new Map<string, Promise<unknown>>());
const toolQueues = registryGlobal.__inkmarshalBrainstormToolQueues
  ?? (registryGlobal.__inkmarshalBrainstormToolQueues = new Map<string, Promise<void>>());

/** Test-only: throw inside the undo transaction after the first inverse op. */
export function __setBrainstormUndoFaultForTest(hook: (() => void) | null): void {
  registryGlobal.__inkmarshalBrainstormUndoFault = hook;
}

/** Test-only: throw once at a deterministic durable-mutation fault point. */
export function __setBrainstormMutationFaultForTest(
  fault: { point: BrainstormMutationFaultPoint; error?: Error; hook?: () => void } | null,
): void {
  registryGlobal.__inkmarshalBrainstormMutationFault = fault;
}

function maybeThrowMutationFault(point: BrainstormMutationFaultPoint): void {
  const fault = registryGlobal.__inkmarshalBrainstormMutationFault;
  if (!fault || fault.point !== point) return;
  registryGlobal.__inkmarshalBrainstormMutationFault = null;
  if (fault.hook) {
    fault.hook();
    return;
  }
  throw fault.error ?? new Error(`INJECTED_BRAINSTORM_FAULT_${point.toUpperCase()}`);
}

/** Test/helper checkpoint inside claim-fenced mutations. */
export function brainstormMutationCheckpoint(
  point: Exclude<BrainstormMutationFaultPoint, 'after_prepare' | 'after_recover'>,
): void {
  maybeThrowMutationFault(point);
}

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
 * Claim validation, the semantic mutation, receipt persistence, and ledger
 * completion share one SQLite transaction. The in-process promise only
 * coalesces exact duplicates; different inputs for the same tool serialize so
 * each prepare step sees paths and rows committed by the previous call.
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
  /**
   * Synchronous authoritative mutation. Must validate/perform user-state
   * writes and receipt updates; it runs inside the claim-fenced ledger tx.
   */
  execute: (prepared: TPrepared) => TResult;
  recover: (prepared: TPrepared) => Promise<DurableToolRecovery<TResult>>;
  /** Revalidate a recovered no-op inside the same transaction as ledger completion. */
  validateRecovered: (prepared: TPrepared, result: TResult) => void;
}): Promise<TResult> {
  const canonicalInput = canonicalJson(args.input);
  // Semantic identity is toolName + canonical input. Same-name calls with
  // different inputs get independent ledger slots and in-process promises;
  // exact replay under the same turn coalesces and remains idempotent.
  // Do not key on provider toolCallId — those are not stable across app replay.
  const argsHash = createHash('sha256')
    .update('inkmarshal.brainstorm-tool-args:v1:')
    .update(args.toolName)
    .update('\0')
    .update(canonicalInput)
    .digest('hex');
  const toolKey = createHash('sha256')
    .update('inkmarshal.brainstorm-tool-slot:v1:')
    .update(args.toolName)
    .update('\0')
    .update(canonicalInput)
    .digest('hex');
  const executionKey = [
    args.novelId,
    args.context.userMessageId,
    args.context.claimToken,
    toolKey,
  ].join(':');
  const active = toolExecutions.get(executionKey) as Promise<TResult> | undefined;
  if (active) return active;
  const queueKey = [
    args.novelId,
    args.context.userMessageId,
    args.context.claimToken,
    args.toolName,
  ].join(':');
  const previous = toolQueues.get(queueKey) ?? Promise.resolve();

  const execution = (async (): Promise<TResult> => {
    await previous;
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
    maybeThrowMutationFault('after_prepare');
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
      return ledger.result as TResult;
    }

    const prepared = hydrate(ledger.preparedData);
    let shouldExecute = false;
    let alreadyAfter: TResult | undefined;
    const recovery = await args.recover(prepared);
    if (recovery.state === 'conflict') {
      throw new Error('Durable brainstorm tool state conflict');
    }
    if (recovery.state === 'already_after') {
      alreadyAfter = recovery.result;
    } else {
      shouldExecute = true;
    }
    maybeThrowMutationFault('after_recover');

    const completed = mutateAndCompleteChatTurnToolCall({
      novelId: args.novelId,
      userMessageId: args.context.userMessageId,
      claimToken: args.context.claimToken,
      toolKey,
      toolName: args.toolName,
      argsHash,
      mutate: () => {
        if (alreadyAfter !== undefined) {
          args.validateRecovered(prepared, alreadyAfter);
          maybeThrowMutationFault('during_receipt_persist');
          return alreadyAfter;
        }
        if (!shouldExecute) {
          throw new Error('Durable brainstorm tool reached mutate without work');
        }
        return args.execute(prepared);
      },
    });
    if (completed.kind === 'lost_claim') {
      throw new Error('Chat turn claim lost during brainstorm tool execution');
    }
    return completed.result as TResult;
  })();
  const queueTail = execution.then(() => undefined, () => undefined);
  toolExecutions.set(executionKey, execution);
  toolQueues.set(queueKey, queueTail);
  try {
    return await execution;
  } finally {
    if (toolExecutions.get(executionKey) === execution) {
      toolExecutions.delete(executionKey);
    }
    if (toolQueues.get(queueKey) === queueTail) {
      toolQueues.delete(queueKey);
    }
  }
}

class CorruptReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptReceiptError';
  }
}

type ReceiptRow = {
  id: string;
  novel_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
  undo_expires_at_ms: number | null;
  undone: number;
  profile_json: string | null;
  entries_json: string;
};

type LoadReceiptResult =
  | { status: 'ok'; receipt: DurableReceipt }
  | { status: 'missing' }
  | { status: 'corrupt' };

const NOVEL_STAGES: readonly NovelStage[] = [
  'discovery_interview',
  'ready_for_greenlight',
  'autonomous_writing',
  'whole_book_unification',
  'completed',
];

const INTERVIEW_STAGES: readonly InterviewStageName[] = [
  'icebreaker',
  'framework',
  'world_and_characters',
  'plot_and_tone',
  'ai_dynamic',
  'proposal_review',
];

function isProfileField(value: unknown): value is ProfileField {
  return typeof value === 'string'
    && (PROFILE_FIELDS as readonly string[]).includes(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInterviewStateValue(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const allowed = new Set([
    '_v',
    'mode',
    'currentQuestionId',
    'currentQuestion',
    'currentHelperText',
    'currentOptions',
    'recommendedOptionId',
    'slotTarget',
    'missingFields',
    'collectedProfile',
    'proposalSummary',
    'proposalVersion',
    'interviewStage',
    'stageProgress',
  ]);
  if (Object.keys(state).some(key => !allowed.has(key))) return false;
  for (const key of allowed) {
    if (key !== '_v' && !Object.hasOwn(state, key)) return false;
  }
  if (state._v !== undefined && state._v !== 1) return false;
  if (state.mode !== 'interview' && state.mode !== 'proposal_review') return false;
  if (!(INTERVIEW_STAGES as readonly string[]).includes(state.interviewStage as string)) {
    return false;
  }
  if (typeof state.proposalVersion !== 'number' || !Number.isInteger(state.proposalVersion)) {
    return false;
  }
  if (!state.stageProgress || typeof state.stageProgress !== 'object' || Array.isArray(state.stageProgress)) {
    return false;
  }
  const progress = state.stageProgress as Record<string, unknown>;
  if (!hasExactKeys(progress, ['current', 'total'])) return false;
  if (!isFiniteNumber(progress.current) || !Number.isInteger(progress.current) || progress.current < 0) {
    return false;
  }
  if (!isFiniteNumber(progress.total) || !Number.isInteger(progress.total) || progress.total < 0) {
    return false;
  }
  if (!state.collectedProfile || typeof state.collectedProfile !== 'object' || Array.isArray(state.collectedProfile)) {
    return false;
  }
  if (!Array.isArray(state.missingFields) || !state.missingFields.every(item => typeof item === 'string')) {
    return false;
  }
  if (!Array.isArray(state.currentOptions)) return false;
  for (const option of state.currentOptions) {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return false;
    if (!hasExactKeys(option, ['id', 'label', 'description'])) return false;
    const row = option as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.label !== 'string' || typeof row.description !== 'string') {
      return false;
    }
  }
  for (const key of [
    'currentQuestionId',
    'currentQuestion',
    'currentHelperText',
    'recommendedOptionId',
    'slotTarget',
    'proposalSummary',
  ] as const) {
    const field = state[key];
    if (!(field === null || typeof field === 'string')) return false;
  }
  return Object.values(state.collectedProfile as Record<string, unknown>)
    .every(item => typeof item === 'string');
}

function isProfileSnapshot(value: unknown): value is BrainstormProfileSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    !hasExactKeys(value, PROFILE_FIELDS)
    && !hasExactKeys(value, [...PROFILE_FIELDS, 'updatedAt'])
  ) {
    return false;
  }
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.genre !== 'string') return false;
  if (
    typeof snapshot.targetWords !== 'number'
    || !Number.isInteger(snapshot.targetWords)
    || snapshot.targetWords < 1_000
    || snapshot.targetWords > 1_000_000
  ) {
    return false;
  }
  if (typeof snapshot.storySummary !== 'string') return false;
  if (typeof snapshot.characterSummary !== 'string') return false;
  if (typeof snapshot.arcSummary !== 'string') return false;
  if (!(NOVEL_STAGES as readonly string[]).includes(snapshot.stage as string)) return false;
  if (
    typeof snapshot.progress !== 'number'
    || !Number.isFinite(snapshot.progress)
    || snapshot.progress < 0
    || snapshot.progress > 100
  ) {
    return false;
  }
  if (
    snapshot.updatedAt !== undefined
    && (typeof snapshot.updatedAt !== 'number' || !Number.isFinite(snapshot.updatedAt))
  ) {
    return false;
  }
  return isInterviewStateValue(snapshot.interviewState);
}

function isIsoTimestamp(value: string): boolean {
  return value.includes('T') && Number.isFinite(Date.parse(value));
}

function parseJsonObjectText(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function parseJsonStringArrayText(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string');
  } catch {
    return false;
  }
}

function normalizeKnowledgeEntryRow(
  value: unknown,
): KnowledgeEntryRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    'id',
    'novel_id',
    'series_id',
    'type',
    'title',
    'summary',
    'data',
    'data_v',
    'sort_order',
    'tags',
    'created_at',
    'updated_at',
  ]);
  if (Object.keys(row).some(key => !allowed.has(key))) return null;
  for (const key of [
    'id',
    'novel_id',
    'type',
    'title',
    'summary',
    'data',
    'sort_order',
    'tags',
    'created_at',
    'updated_at',
  ] as const) {
    if (!Object.hasOwn(row, key)) return null;
  }
  if (
    typeof row.id !== 'string'
    || row.id.trim() === ''
    || typeof row.novel_id !== 'string'
    || row.novel_id.trim() === ''
    || (row.series_id !== undefined && row.series_id !== null && typeof row.series_id !== 'string')
    || typeof row.type !== 'string'
    || !(KNOWLEDGE_TYPE_VALUES as readonly string[]).includes(row.type)
    || typeof row.title !== 'string'
    || typeof row.summary !== 'string'
    || typeof row.data !== 'string'
    || !parseJsonObjectText(row.data)
    || (
      row.data_v !== undefined
      && row.data_v !== null
      && (
        typeof row.data_v !== 'number'
        || !Number.isSafeInteger(row.data_v)
      )
    )
    || typeof row.sort_order !== 'number'
    || !Number.isSafeInteger(row.sort_order)
    || typeof row.tags !== 'string'
    || !parseJsonStringArrayText(row.tags)
    || typeof row.created_at !== 'string'
    || !isIsoTimestamp(row.created_at)
    || typeof row.updated_at !== 'string'
    || !isIsoTimestamp(row.updated_at)
  ) {
    return null;
  }
  return {
    id: row.id,
    novel_id: row.novel_id,
    series_id: (row.series_id as string | null | undefined) ?? null,
    type: row.type,
    title: row.title,
    summary: row.summary,
    data: row.data,
    data_v: (row.data_v as number | null | undefined) ?? null,
    sort_order: row.sort_order,
    tags: row.tags,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isKnowledgeEntryRow(value: unknown): value is KnowledgeEntryRow {
  return normalizeKnowledgeEntryRow(value) !== null;
}

function profileValuesDiffer(
  before: BrainstormProfileSnapshot,
  after: BrainstormProfileSnapshot,
  field: ProfileField,
): boolean {
  return JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null);
}

function isProfileMutation(value: unknown): value is ProfileMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ['before', 'after', 'fields'])) return false;
  const mutation = value as Record<string, unknown>;
  if (!isProfileSnapshot(mutation.before) || !isProfileSnapshot(mutation.after)) {
    return false;
  }
  if (!Array.isArray(mutation.fields) || mutation.fields.length === 0) return false;
  if (!mutation.fields.every(isProfileField)) return false;
  if (new Set(mutation.fields).size !== mutation.fields.length) return false;
  const fields = mutation.fields as ProfileField[];
  const beforeHasRevision = Object.hasOwn(mutation.before as object, 'updatedAt');
  const afterHasRevision = Object.hasOwn(mutation.after as object, 'updatedAt');
  if (beforeHasRevision !== afterHasRevision) return false;
  const changedFields = PROFILE_FIELDS.filter(field =>
    profileValuesDiffer(
      mutation.before as BrainstormProfileSnapshot,
      mutation.after as BrainstormProfileSnapshot,
      field,
    )
  );
  return changedFields.length === fields.length
    && changedFields.every(field => fields.includes(field));
}

function isEntryMutation(value: unknown): value is EntryMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ['key', 'before', 'after', 'action'])) return false;
  const mutation = value as Record<string, unknown>;
  if (typeof mutation.key !== 'string') return false;
  if (mutation.action !== 'created' && mutation.action !== 'updated') return false;
  if (mutation.before !== null && !isKnowledgeEntryRow(mutation.before)) return false;
  if (!isKnowledgeEntryRow(mutation.after)) return false;
  if (
    (mutation.action === 'created' && mutation.before !== null)
    || (mutation.action === 'updated' && mutation.before === null)
  ) {
    return false;
  }
  return true;
}

function isReceiptTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function parseJsonOrCorrupt(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new CorruptReceiptError(`malformed ${label}`);
  }
}

function parseProfileMutation(profileJson: string | null): ProfileMutation | null {
  if (profileJson == null) return null;
  const parsed = parseJsonOrCorrupt(profileJson, 'profile_json');
  if (!isProfileMutation(parsed)) {
    throw new CorruptReceiptError('invalid profile_json shape');
  }
  return parsed;
}

function parseEntryMutations(entriesJson: string): EntryMutation[] {
  const parsed = parseJsonOrCorrupt(entriesJson, 'entries_json');
  if (!Array.isArray(parsed) || !parsed.every(isEntryMutation)) {
    throw new CorruptReceiptError('invalid entries_json shape');
  }
  return parsed;
}

function mapReceiptRow(row: ReceiptRow): DurableReceipt {
  if (typeof row.id !== 'string' || typeof row.novel_id !== 'string') {
    throw new CorruptReceiptError('invalid receipt identity');
  }
  if (!isReceiptTimestamp(row.created_at_ms) || !isReceiptTimestamp(row.expires_at_ms)) {
    throw new CorruptReceiptError('invalid receipt timestamps');
  }
  if (row.consumed_at_ms !== null && !isReceiptTimestamp(row.consumed_at_ms)) {
    throw new CorruptReceiptError('invalid receipt consumed_at');
  }
  if (row.undo_expires_at_ms !== null && !isReceiptTimestamp(row.undo_expires_at_ms)) {
    throw new CorruptReceiptError('invalid receipt undo_expires_at');
  }
  if (row.undone !== 0 && row.undone !== 1) {
    throw new CorruptReceiptError('invalid receipt undone flag');
  }
  const entries: EntryMutation[] = [];
  for (const mutation of parseEntryMutations(row.entries_json)) {
    const expectedKey = knowledgeEntryIdentityKey(mutation.after);
    const legacyKey = legacyEntryIdentityKey(mutation.after);
    if (
      (mutation.key !== expectedKey && mutation.key !== legacyKey)
      || mutation.after.novel_id !== row.novel_id
      || (mutation.before !== null && (
        mutation.before.id !== mutation.after.id
        || mutation.before.novel_id !== row.novel_id
      ))
    ) {
      throw new CorruptReceiptError('entry mutation identity mismatch');
    }
    const existing = entries.find(entry => entry.key === expectedKey);
    if (existing) {
      if (!mutation.before || !sameKnowledgeEntry(existing.after, mutation.before)) {
        throw new CorruptReceiptError('entry mutation chain mismatch');
      }
      existing.after = mutation.after;
      existing.action = existing.before ? 'updated' : 'created';
    } else {
      entries.push({ ...mutation, key: expectedKey });
    }
  }
  return {
    id: row.id,
    novelId: row.novel_id,
    createdAt: row.created_at_ms,
    expiresAt: row.expires_at_ms,
    consumedAt: row.consumed_at_ms,
    undoExpiresAt: row.undo_expires_at_ms,
    undone: row.undone === 1,
    profile: parseProfileMutation(row.profile_json),
    entries,
  };
}

function selectReceiptRow(receiptId: string): ReceiptRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, novel_id, created_at_ms, expires_at_ms, consumed_at_ms,
              undo_expires_at_ms, undone, profile_json, entries_json
         FROM brainstorm_receipts
        WHERE id = ?`,
    )
    .get(receiptId) as ReceiptRow | undefined;
}

function loadReceiptResult(receiptId: string): LoadReceiptResult {
  const row = selectReceiptRow(receiptId);
  if (!row) return { status: 'missing' };
  try {
    return { status: 'ok', receipt: mapReceiptRow(row) };
  } catch (error) {
    if (error instanceof CorruptReceiptError) return { status: 'corrupt' };
    throw error;
  }
}

function loadReceipt(receiptId: string): DurableReceipt | null {
  const loaded = loadReceiptResult(receiptId);
  return loaded.status === 'ok' ? loaded.receipt : null;
}

/** Persist only when the row is absent or already owned by the same novel. */
function persistReceipt(receipt: DurableReceipt): boolean {
  const db = getDb();
  const updatedAt = nowIso();
  const result = db.prepare(
    `INSERT INTO brainstorm_receipts (
       id, novel_id, created_at_ms, expires_at_ms, consumed_at_ms,
       undo_expires_at_ms, undone, profile_json, entries_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       expires_at_ms = excluded.expires_at_ms,
       consumed_at_ms = excluded.consumed_at_ms,
       undo_expires_at_ms = excluded.undo_expires_at_ms,
       undone = excluded.undone,
       profile_json = excluded.profile_json,
       entries_json = excluded.entries_json,
       updated_at = excluded.updated_at
     WHERE brainstorm_receipts.novel_id = excluded.novel_id`,
  ).run(
    receipt.id,
    receipt.novelId,
    receipt.createdAt,
    receipt.expiresAt,
    receipt.consumedAt,
    receipt.undoExpiresAt,
    receipt.undone ? 1 : 0,
    receipt.profile ? JSON.stringify(receipt.profile) : null,
    JSON.stringify(receipt.entries),
    updatedAt,
  );
  return result.changes > 0;
}

function cleanupExpiredReceipts(now = Date.now()): void {
  getDb()
    .prepare(
      `DELETE FROM brainstorm_receipts
        WHERE (
          expires_at_ms <= ?
          OR (undone = 1 AND consumed_at_ms IS NOT NULL)
        )
          AND NOT EXISTS (
            SELECT 1 FROM chat_turns
             WHERE chat_turns.brainstorm_receipt_id = brainstorm_receipts.id
               AND chat_turns.status = 'running'
          )`,
    )
    .run(now);
}

export function brainstormProfileSnapshot(novel: Novel): BrainstormProfileSnapshot {
  if (!isInterviewStateValue(novel.interviewState)) {
    throw new CorruptReceiptError(
      'refusing to snapshot an invalid brainstorm interview state',
    );
  }
  return {
    genre: novel.genre,
    targetWords: novel.targetWords,
    storySummary: novel.storySummary,
    characterSummary: novel.characterSummary,
    arcSummary: novel.arcSummary,
    stage: novel.stage,
    progress: novel.progress,
    interviewState: novel.interviewState,
    updatedAt: novel.updatedAt,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameKnowledgeEntry(left: KnowledgeEntryRow, right: KnowledgeEntryRow): boolean {
  return left.id === right.id
    && left.novel_id === right.novel_id
    && (left.series_id ?? null) === (right.series_id ?? null)
    && left.type === right.type
    && left.title === right.title
    && left.summary === right.summary
    && left.data === right.data
    && (left.data_v ?? null) === (right.data_v ?? null)
    && left.tags === right.tags
    && left.sort_order === right.sort_order
    && left.created_at === right.created_at
    && left.updated_at === right.updated_at;
}

function legacyEntryIdentityKey(entry: Pick<KnowledgeEntryRow, 'type' | 'title'>): string {
  return `${entry.type}:${entry.title.trim().toLowerCase()}`;
}

function emptyReceipt(novelId: string, id = crypto.randomUUID()): DurableReceipt {
  return {
    id,
    novelId,
    createdAt: Date.now(),
    expiresAt: Date.now() + RECEIPT_LIFETIME_MS,
    consumedAt: null,
    undoExpiresAt: null,
    undone: false,
    profile: null,
    entries: [],
  };
}

function beginBrainstormReceipt(novelId: string): string {
  cleanupExpiredReceipts();
  const receipt = emptyReceipt(novelId);
  if (!persistReceipt(receipt)) {
    // Extremely unlikely UUID collision against a foreign novel_id guard.
    const retry = emptyReceipt(novelId);
    if (!persistReceipt(retry)) {
      throw new Error('Failed to persist brainstorm receipt');
    }
    return retry.id;
  }
  return receipt.id;
}

/**
 * Reuse a durable chat-turn receipt id across retries. After process restart the
 * SQLite row remains authoritative for undo metadata.
 *
 * An id already owned by another novel is never overwritten or reused; a fresh
 * id is minted instead. Corrupt payloads are treated the same way.
 */
export function ensureBrainstormReceipt(
  novelId: string,
  existingId?: string | null,
): string {
  cleanupExpiredReceipts();
  if (!existingId) return beginBrainstormReceipt(novelId);

  const loaded = loadReceiptResult(existingId);
  if (loaded.status === 'corrupt') {
    // Leave the corrupt foreign-or-local row untouched; mint a clean receipt.
    return beginBrainstormReceipt(novelId);
  }
  if (loaded.status === 'ok') {
    if (loaded.receipt.novelId !== novelId) {
      return beginBrainstormReceipt(novelId);
    }
    if (!loaded.receipt.undone) {
      loaded.receipt.expiresAt = Date.now() + RECEIPT_LIFETIME_MS;
      if (!persistReceipt(loaded.receipt)) {
        return beginBrainstormReceipt(novelId);
      }
      return existingId;
    }
  }

  const receipt = emptyReceipt(novelId, existingId);
  if (!persistReceipt(receipt)) {
    return beginBrainstormReceipt(novelId);
  }
  return existingId;
}

function applyProfileMutationToReceipt(
  receipt: DurableReceipt,
  before: BrainstormProfileSnapshot,
  after: BrainstormProfileSnapshot,
): boolean {
  if (!isProfileSnapshot(before) || !isProfileSnapshot(after)) {
    throw new CorruptReceiptError('refusing to persist invalid profile snapshot');
  }
  const changedFields = PROFILE_FIELDS.filter(field => !sameValue(before[field], after[field]));
  if (changedFields.length === 0) return false;

  if (!receipt.profile) {
    receipt.profile = { before, after, fields: changedFields };
  } else {
    if (!sameValue(receipt.profile.after, before)) {
      throw new Error('Durable brainstorm receipt mutation conflict');
    }
    receipt.profile.after = after;
    const fields = new Set(receipt.profile.fields);
    for (const field of changedFields) fields.add(field);
    receipt.profile.fields = Array.from(fields);
  }
  if (!isProfileMutation(receipt.profile)) {
    throw new CorruptReceiptError('refusing to persist invalid profile mutation');
  }
  return true;
}

function applyEntryMutationToReceipt(
  receipt: DurableReceipt,
  before: KnowledgeEntryRow | null,
  after: KnowledgeEntryRow,
  action: 'created' | 'updated',
): void {
  const normalizedBefore = before === null
    ? null
    : normalizeKnowledgeEntryRow(before);
  const normalizedAfter = normalizeKnowledgeEntryRow(after);
  if ((before !== null && !normalizedBefore) || !normalizedAfter) {
    throw new CorruptReceiptError('refusing to persist invalid entry mutation');
  }
  const key = knowledgeEntryIdentityKey(normalizedAfter);
  const existing = receipt.entries.find(entry => entry.key === key);
  if (existing) {
    if (!normalizedBefore || !sameKnowledgeEntry(existing.after, normalizedBefore)) {
      throw new Error('Durable brainstorm receipt mutation conflict');
    }
    existing.after = normalizedAfter;
    // A row created earlier in this receipt remains a net creation even when a
    // later tool updates it; undo must still delete it rather than "restore"
    // a nonexistent pre-image.
    existing.action = existing.before ? 'updated' : 'created';
  } else {
    receipt.entries.push({
      key,
      before: normalizedBefore,
      after: normalizedAfter,
      action,
    });
  }
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

/** Claim-fenced callers may pass an open db handle to join an outer transaction. */
function recordBrainstormProfileSnapshotMutation(
  receiptId: string,
  novelId: string,
  before: BrainstormProfileSnapshot,
  afterNovel: Novel,
  db: ReturnType<typeof getDb> = getDb(),
): void {
  const receipt = loadReceiptInTx(db, receiptId);
  if (!receipt || receipt.novelId !== novelId || receipt.novelId !== afterNovel.id) {
    throw new CorruptReceiptError('brainstorm profile receipt missing or mismatched');
  }
  const after = brainstormProfileSnapshot(afterNovel);
  if (!applyProfileMutationToReceipt(receipt, before, after)) return;
  persistReceiptInTx(db, receipt);
}

export function recordBrainstormEntryMutation(
  receiptId: string,
  before: KnowledgeEntryRow | null,
  after: KnowledgeEntryRow,
  action: 'created' | 'updated',
  options: { profileRevisionBeforeMutation?: number } = {},
  db: ReturnType<typeof getDb> = getDb(),
): void {
  const receipt = loadReceiptInTx(db, receiptId);
  if (!receipt || receipt.novelId !== after.novel_id) {
    throw new CorruptReceiptError('brainstorm entry receipt missing or mismatched');
  }
  applyEntryMutationToReceipt(receipt, before, after, action);
  if (
    receipt.profile
    && options.profileRevisionBeforeMutation !== undefined
  ) {
    const currentNovel = getNovelSync(db, after.novel_id);
    if (!currentNovel) {
      throw new CorruptReceiptError('brainstorm profile receipt novel missing');
    }
    const receiptRevision = receipt.profile.after.updatedAt;
    if (receiptRevision === options.profileRevisionBeforeMutation) {
      receipt.profile.after.updatedAt = currentNovel.updatedAt;
    } else if (receiptRevision !== currentNovel.updatedAt) {
      throw new Error('Durable brainstorm receipt mutation conflict');
    }
  }
  persistReceiptInTx(db, receipt);
}

function loadReceiptInTx(
  db: ReturnType<typeof getDb>,
  receiptId: string,
): DurableReceipt | null {
  const row = db.prepare(
    `SELECT id, novel_id, created_at_ms, expires_at_ms, consumed_at_ms,
            undo_expires_at_ms, undone, profile_json, entries_json
       FROM brainstorm_receipts
      WHERE id = ?`,
  ).get(receiptId) as ReceiptRow | undefined;
  if (!row) return null;
  return mapReceiptRow(row);
}

export function consumeLatestBrainstormReceipt(novelId: string): BrainstormReceiptView | null {
  cleanupExpiredReceipts();
  const row = getDb()
    .prepare(
      `SELECT id, novel_id, created_at_ms, expires_at_ms, consumed_at_ms,
              undo_expires_at_ms, undone, profile_json, entries_json
         FROM brainstorm_receipts
        WHERE novel_id = ?
          AND consumed_at_ms IS NULL
          AND undone = 0
          AND (
            profile_json IS NOT NULL
            OR (entries_json IS NOT NULL AND entries_json != '[]')
          )
        ORDER BY created_at_ms DESC
        LIMIT 1`,
    )
    .get(novelId) as ReceiptRow | undefined;
  if (!row) return null;

  let receipt: DurableReceipt;
  try {
    receipt = mapReceiptRow(row);
  } catch (error) {
    if (error instanceof CorruptReceiptError) {
      // Fail closed: never consume/mutate a receipt whose inverse cannot be trusted.
      return null;
    }
    throw error;
  }
  if (receipt.profile == null && receipt.entries.length === 0) {
    // Non-null JSON that validated as empty inverse payload is not consumable.
    return null;
  }
  const now = Date.now();
  receipt.consumedAt = now;
  receipt.undoExpiresAt = now + BRAINSTORM_UNDO_WINDOW_MS;
  if (!persistReceipt(receipt)) return null;
  return {
    id: receipt.id,
    profileFields: receipt.profile ? receipt.profile.fields : [],
    storyEntries: receipt.entries.map(entry => ({
      type: entry.after.type,
      title: entry.after.title,
      action: entry.action,
    })),
    undoExpiresAt: receipt.undoExpiresAt,
  };
}

function deleteKnowledgeEntryInTx(
  db: ReturnType<typeof getDb>,
  entry: KnowledgeEntryRow,
): void {
  const pathRow = db
    .prepare('SELECT path FROM knowledge_index WHERE id = ?')
    .get(entry.id) as { path: string | null } | undefined;
  enqueueKnowledgeVaultDelete(db, {
    entryId: entry.id,
    novelId: entry.novel_id,
    relPath: pathRow?.path ?? null,
    updatedAt: nowIso(),
  });
  db.prepare('DELETE FROM knowledge_embeddings WHERE id = ?').run(entry.id);
  db.prepare('DELETE FROM knowledge_index WHERE id = ?').run(entry.id);
  db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(entry.id);
}

function restoreKnowledgeEntryInTx(
  db: ReturnType<typeof getDb>,
  before: KnowledgeEntryRow,
  index: Awaited<ReturnType<typeof buildKnowledgeIndexInsert>>,
): void {
  const result = db.prepare(
    `UPDATE knowledge_entries
        SET series_id = ?, type = ?, title = ?, summary = ?,
            data = ?, data_v = ?, tags = ?, sort_order = ?, created_at = ?, updated_at = ?
      WHERE id = ?
        AND novel_id = ?`,
  ).run(
    before.series_id ?? null,
    before.type,
    before.title,
    before.summary,
    before.data,
    before.data_v ?? null,
    before.tags,
    before.sort_order,
    before.created_at,
    before.updated_at,
    before.id,
    before.novel_id,
  );
  if (result.changes !== 1) {
    throw Object.assign(new Error('conflict'), { reason: 'conflict' as const });
  }
  upsertKnowledgeIndex(db, index);
  enqueueKnowledgeVaultUpsert(db, {
    entryId: index.id,
    novelId: index.novelId,
    relPath: index.path,
    updatedAt: before.updated_at,
  });
}

export async function undoBrainstormReceipt(
  novelId: string,
  receiptId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'expired' | 'conflict' }> {
  cleanupExpiredReceipts();
  const loaded = loadReceiptResult(receiptId);
  if (loaded.status === 'corrupt') {
    // Never treat a discarded inverse payload as an empty successful undo.
    return { ok: false, reason: 'conflict' };
  }
  const receipt = loaded.status === 'ok' ? loaded.receipt : null;
  if (!receipt || receipt.novelId !== novelId || receipt.undone) {
    return { ok: false, reason: 'not_found' };
  }
  if (!receipt.undoExpiresAt || Date.now() > receipt.undoExpiresAt) {
    return { ok: false, reason: 'expired' };
  }

  const currentNovel = await getNovel(novelId);
  if (!currentNovel) return { ok: false, reason: 'not_found' };
  if (receipt.profile) {
    if (
      receipt.profile.after.updatedAt !== undefined
      && currentNovel.updatedAt !== receipt.profile.after.updatedAt
    ) {
      return { ok: false, reason: 'conflict' };
    }
    for (const field of receipt.profile.fields) {
      if (!sameValue(currentNovel[field], receipt.profile.after[field])) {
        return { ok: false, reason: 'conflict' };
      }
    }
  }

  const currentByKey = new Map(
    (await getKnowledgeEntries(novelId)).map(entry => [
      knowledgeEntryIdentityKey(entry),
      entry,
    ]),
  );
  for (const mutation of receipt.entries) {
    const current = currentByKey.get(mutation.key);
    if (!current || !sameKnowledgeEntry(current, mutation.after)) {
      return { ok: false, reason: 'conflict' };
    }
  }

  // Prepare index restores outside the sync transaction (hashing is async).
  const restoreIndexes = new Map<string, Awaited<ReturnType<typeof buildKnowledgeIndexInsert>>>();
  for (const mutation of receipt.entries) {
    if (!mutation.before) continue;
    restoreIndexes.set(
      mutation.before.id,
      await buildKnowledgeIndexInsert({
        id: mutation.before.id,
        novelId,
        type: mutation.before.type as KnowledgeType,
        title: mutation.before.title,
        summary: mutation.before.summary,
        data: parseJsonField<Record<string, unknown>>(mutation.before.data, {}),
        tags: parseJsonField<string[]>(mutation.before.tags, []),
        updatedAt: mutation.before.updated_at,
      }),
    );
  }

  const db = getDb();
  try {
    const tx = db.transaction(() => {
      const lockedLoad = loadReceiptResult(receiptId);
      if (lockedLoad.status === 'corrupt') {
        throw Object.assign(new Error('conflict'), { reason: 'conflict' as const });
      }
      const locked = lockedLoad.status === 'ok' ? lockedLoad.receipt : null;
      if (!locked || locked.novelId !== novelId || locked.undone) {
        throw Object.assign(new Error('not_found'), { reason: 'not_found' as const });
      }
      if (!locked.undoExpiresAt || Date.now() > locked.undoExpiresAt) {
        throw Object.assign(new Error('expired'), { reason: 'expired' as const });
      }

      const novelRow = db
        .prepare('SELECT * FROM novels WHERE id = ?')
        .get(novelId) as Record<string, unknown> | undefined;
      if (!novelRow) {
        throw Object.assign(new Error('not_found'), { reason: 'not_found' as const });
      }

      // Re-check conflicts under the write lock of this transaction.
      if (locked.profile) {
        const live = getNovelSync(db, novelId);
        if (!live) {
          throw Object.assign(new Error('not_found'), { reason: 'not_found' as const });
        }
        if (
          locked.profile.after.updatedAt !== undefined
          && live.updatedAt !== locked.profile.after.updatedAt
        ) {
          throw Object.assign(new Error('conflict'), { reason: 'conflict' as const });
        }
        for (const field of locked.profile.fields) {
          if (!sameValue(live[field], locked.profile.after[field])) {
            throw Object.assign(new Error('conflict'), { reason: 'conflict' as const });
          }
        }
      }
      const liveEntries = db
        .prepare('SELECT * FROM knowledge_entries WHERE novel_id = ?')
        .all(novelId) as KnowledgeEntryRow[];
      const liveByKey = new Map(
        liveEntries.map(entry => [
          knowledgeEntryIdentityKey(entry),
          entry,
        ]),
      );
      for (const mutation of locked.entries) {
        const current = liveByKey.get(mutation.key);
        if (!current || !sameKnowledgeEntry(current, mutation.after)) {
          throw Object.assign(new Error('conflict'), { reason: 'conflict' as const });
        }
        if (!mutation.before) {
          // Brainstorm tools never create relations, so a receipt-created entry's
          // authoritative completion baseline is empty. Any live relation was
          // added later and must block the cascading entry delete.
          const laterRelation = db.prepare(
            `SELECT 1
               FROM knowledge_relations
              WHERE source_id = ? OR target_id = ?
              LIMIT 1`,
          ).get(mutation.after.id, mutation.after.id);
          if (laterRelation) {
            throw Object.assign(new Error('conflict'), { reason: 'conflict' as const });
          }
        }
      }

      let inversesApplied = 0;
      for (const mutation of [...locked.entries].reverse()) {
        if (!mutation.before) {
          deleteKnowledgeEntryInTx(db, mutation.after);
        } else {
          const index = restoreIndexes.get(mutation.before.id);
          if (!index) {
            throw Object.assign(new Error('conflict'), { reason: 'conflict' as const });
          }
          restoreKnowledgeEntryInTx(db, mutation.before, index);
        }
        inversesApplied += 1;
        const fault = registryGlobal.__inkmarshalBrainstormUndoFault;
        if (fault && inversesApplied === 1) fault();
      }

      if (locked.profile) {
        // Restore only declared, validated fields — reject undeclared-field
        // tampering by never applying the whole before snapshot object.
        const restore = Object.fromEntries(
          locked.profile.fields.map(field => [field, locked.profile!.before[field]]),
        ) as Partial<Novel>;
        applyNovelUpdate(db, novelId, restore);
      }

      locked.undone = true;
      persistReceiptInTx(db, locked);
    });
    tx();
  } catch (error) {
    const reason = (error as { reason?: 'not_found' | 'expired' | 'conflict' }).reason;
    if (reason === 'not_found' || reason === 'expired' || reason === 'conflict') {
      return { ok: false, reason };
    }
    throw error;
  }

  return { ok: true };
}

function persistReceiptInTx(db: ReturnType<typeof getDb>, receipt: DurableReceipt): void {
  maybeThrowMutationFault('during_receipt_persist');
  const result = db.prepare(
    `UPDATE brainstorm_receipts
        SET expires_at_ms = ?,
            consumed_at_ms = ?,
            undo_expires_at_ms = ?,
            undone = ?,
            profile_json = ?,
            entries_json = ?,
            updated_at = ?
      WHERE id = ?
        AND novel_id = ?`,
  ).run(
    receipt.expiresAt,
    receipt.consumedAt,
    receipt.undoExpiresAt,
    receipt.undone ? 1 : 0,
    receipt.profile ? JSON.stringify(receipt.profile) : null,
    JSON.stringify(receipt.entries),
    nowIso(),
    receipt.id,
    receipt.novelId,
  );
  if (result.changes !== 1) {
    throw Object.assign(new Error('conflict'), { reason: 'conflict' as const });
  }
}

function getNovelSync(db: ReturnType<typeof getDb>, novelId: string): Novel | null {
  const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return mapNovel(hydrateNovelRow(row));
}
