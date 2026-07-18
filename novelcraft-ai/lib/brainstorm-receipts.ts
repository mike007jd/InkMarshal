import 'server-only';

import {
  deleteKnowledgeEntry,
  getKnowledgeEntries,
  getNovel,
  updateNovel,
  type KnowledgeEntryRow,
  type Novel,
} from '@/lib/db';
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
type ProfileSnapshot = Pick<Novel, ProfileField>;

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
    before: ProfileSnapshot;
    after: ProfileSnapshot;
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
};

const registryGlobal = globalThis as RegistryGlobal;
const receipts: Map<string, InternalReceipt> = registryGlobal.__inkmarshalBrainstormReceipts
  ?? (registryGlobal.__inkmarshalBrainstormReceipts = new Map<string, InternalReceipt>());

function cleanupExpiredReceipts(now = Date.now()): void {
  for (const [id, receipt] of receipts) {
    if (receipt.expiresAt <= now || (receipt.undone && receipt.consumedAt !== null)) {
      receipts.delete(id);
    }
  }
}

function profileSnapshot(novel: Novel): ProfileSnapshot {
  return Object.fromEntries(PROFILE_FIELDS.map(field => [field, novel[field]])) as ProfileSnapshot;
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

export function recordBrainstormProfileMutation(
  receiptId: string,
  beforeNovel: Novel,
  afterNovel: Novel,
): void {
  const receipt = receipts.get(receiptId);
  if (!receipt || receipt.novelId !== beforeNovel.id || receipt.novelId !== afterNovel.id) return;
  const before = profileSnapshot(beforeNovel);
  const after = profileSnapshot(afterNovel);
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
