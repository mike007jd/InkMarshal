import { mapNovel, type Novel } from '@/lib/db-types';
import { getDb } from '@/lib/db/connection';
import { applyNovelUpdate, hydrateNovelRow } from '@/lib/db/queries-novel';
import {
  insertKnowledgeEntryWithIndexInTx,
  type KnowledgeEntryRow,
  readKnowledgeEntryByNormalizedIdentity,
  updateKnowledgeEntryWithIndexInTx,
  upsertKnowledgeIndexAndVaultOutboxInTx,
} from '@/lib/db/queries-knowledge';
import type { KnowledgeIndexInsert } from '@/lib/db/queries-vault';
import { toJsonb, type InterviewState } from '@/lib/interview-state';

const EDITABLE_STAGES = new Set(['discovery_interview', 'ready_for_greenlight']);
const STORY_DECK_TYPES = ['character', 'world', 'outline'] as const;

export type BrainstormFinalizationEntry = {
  id: string;
  type: 'character' | 'world' | 'outline';
  title: string;
  summary: string;
  data: Record<string, unknown>;
  tags: string[];
  updatedAt: string;
  index: KnowledgeIndexInsert | null;
};

export type BrainstormProjectionRepair = {
  entry: KnowledgeEntryRow;
  index: KnowledgeIndexInsert;
};

type BrainstormEntryMutation = {
  action: 'created' | 'updated' | 'unchanged';
  before: KnowledgeEntryRow | null;
  after: KnowledgeEntryRow;
};

export type FinalizeBrainstormResult =
  | {
      ok: true;
      beforeNovel: Novel;
      novel: Novel;
      mutations: BrainstormEntryMutation[];
      coverage: Record<BrainstormFinalizationEntry['type'], number>;
    }
  | { ok: false; reason: 'not_found' | 'not_editable' | 'incomplete' };

export type ApproveExistingBrainstormResult =
  | {
      ok: true;
      alreadyReady: boolean;
      beforeNovel: Novel;
      novel: Novel;
      coverage: Record<BrainstormFinalizationEntry['type'], number>;
    }
  | { ok: false; reason: 'not_found' | 'not_editable' | 'incomplete' };

function storyDeckCoverage(db: ReturnType<typeof getDb>, novelId: string) {
  const coverage = { character: 0, world: 0, outline: 0 };
  const rows = db.prepare(
    `SELECT type, COUNT(*) AS count
       FROM knowledge_entries
      WHERE novel_id = ? AND type IN ('character', 'world', 'outline')
      GROUP BY type`,
  ).all(novelId) as { type: BrainstormFinalizationEntry['type']; count: number }[];
  for (const row of rows) coverage[row.type] = row.count;
  return coverage;
}

function hasCompleteExistingProfile(novel: Novel): boolean {
  return Boolean(
    novel.storySummary.trim()
    && novel.characterSummary.trim()
    && novel.arcSummary.trim(),
  );
}

function proposalReviewStateFromExistingProfile(novel: Novel): InterviewState {
  const collectedProfile = {
    genre: novel.genre,
    targetWords: String(novel.targetWords),
    storySummary: novel.storySummary,
    characterSummary: novel.characterSummary,
    arcSummary: novel.arcSummary,
  };
  const proposalSummary = [
    collectedProfile.storySummary && `Story: ${collectedProfile.storySummary}`,
    collectedProfile.characterSummary && `Characters: ${collectedProfile.characterSummary}`,
    collectedProfile.arcSummary && `Arc: ${collectedProfile.arcSummary}`,
  ].filter(Boolean).join('\n');

  return {
    mode: 'proposal_review',
    currentQuestionId: null,
    currentQuestion: null,
    currentHelperText: null,
    currentOptions: [],
    recommendedOptionId: null,
    slotTarget: null,
    missingFields: [],
    collectedProfile,
    proposalSummary: proposalSummary || null,
    proposalVersion: 1,
    interviewStage: 'proposal_review',
    stageProgress: { current: 6, total: 6 },
  };
}

/**
 * Strict chat-approval primitive: advance to ready_for_greenlight only when the
 * current profile summaries and existing Story Deck coverage are already
 * complete. Never inserts/updates knowledge cards and never falls back to title.
 */
export function approveExistingBrainstormAtomicSync(
  novelId: string,
): ApproveExistingBrainstormResult {
  const db = getDb();
  const tx = db.transaction((): ApproveExistingBrainstormResult => {
    const currentRow = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as
      | Record<string, unknown>
      | undefined;
    if (!currentRow) return { ok: false, reason: 'not_found' };
    const beforeNovel = mapNovel(hydrateNovelRow(currentRow));
    const coverage = storyDeckCoverage(db, novelId);

    if (!EDITABLE_STAGES.has(beforeNovel.stage)) {
      return { ok: false, reason: 'not_editable' };
    }
    if (
      !hasCompleteExistingProfile(beforeNovel)
      || STORY_DECK_TYPES.some(type => coverage[type] < 1)
    ) {
      return { ok: false, reason: 'incomplete' };
    }
    if (beforeNovel.stage === 'ready_for_greenlight') {
      return {
        ok: true,
        alreadyReady: true,
        beforeNovel,
        novel: beforeNovel,
        coverage,
      };
    }

    const novel = applyNovelUpdate(db, novelId, {
      stage: 'ready_for_greenlight',
      progress: 0,
      interviewState: toJsonb(proposalReviewStateFromExistingProfile(beforeNovel)),
    });
    if (!novel) throw new Error('Novel disappeared during brainstorm approval');
    return {
      ok: true,
      alreadyReady: false,
      beforeNovel,
      novel,
      coverage,
    };
  });
  return tx();
}

function sameEntry(
  row: KnowledgeEntryRow,
  entry: BrainstormFinalizationEntry,
): boolean {
  return row.title === entry.title
    && row.summary === entry.summary
    && row.data === JSON.stringify(entry.data)
    && row.tags === JSON.stringify(entry.tags);
}

function sameKnowledgeEntryRow(
  left: KnowledgeEntryRow,
  right: KnowledgeEntryRow,
): boolean {
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

/**
 * Synchronous finalize body. Safe to nest inside an outer SQLite transaction
 * (savepoint) so claim fencing, receipts, and ledger completion stay atomic.
 */
export function finalizeBrainstormAtomicSync(args: {
  novelId: string;
  profile: Partial<Novel>;
  entries: readonly BrainstormFinalizationEntry[];
  preserveExistingStoryDeck?: boolean;
  projectionRepairs?: readonly BrainstormProjectionRepair[];
}): FinalizeBrainstormResult {
  const submittedCoverage = args.entries.reduce<Record<BrainstormFinalizationEntry['type'], number>>(
    (counts, entry) => {
      counts[entry.type] += 1;
      return counts;
    },
    { character: 0, world: 0, outline: 0 },
  );
  if (!args.preserveExistingStoryDeck && Object.values(submittedCoverage).some(count => count < 1)) {
    return { ok: false, reason: 'incomplete' };
  }

  const db = getDb();
  const tx = db.transaction((): FinalizeBrainstormResult => {
    const currentRow = db.prepare('SELECT stage FROM novels WHERE id = ?').get(args.novelId) as
      | { stage: string }
      | undefined;
    if (!currentRow) return { ok: false, reason: 'not_found' };
    if (!EDITABLE_STAGES.has(currentRow.stage)) {
      return { ok: false, reason: 'not_editable' };
    }

    const existingCoverage = args.preserveExistingStoryDeck
      ? storyDeckCoverage(db, args.novelId)
      : { character: 0, world: 0, outline: 0 };
    const entriesToApply = args.preserveExistingStoryDeck
      ? args.entries.filter(entry => existingCoverage[entry.type] === 0)
      : args.entries;
    const coverage = entriesToApply.reduce<Record<BrainstormFinalizationEntry['type'], number>>(
      (counts, entry) => {
        counts[entry.type] += 1;
        return counts;
      },
      { ...existingCoverage },
    );
    if (Object.values(coverage).some(count => count < 1)) {
      return { ok: false, reason: 'incomplete' };
    }

    for (const repair of args.projectionRepairs ?? []) {
      const current = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?')
        .get(repair.entry.id) as KnowledgeEntryRow | undefined;
      if (
        !current
        || !sameKnowledgeEntryRow(current, repair.entry)
        || repair.index.id !== repair.entry.id
        || repair.index.novelId !== args.novelId
      ) {
        throw new Error('Brainstorm projection repair state conflict');
      }
      upsertKnowledgeIndexAndVaultOutboxInTx(
        db,
        repair.index,
        repair.entry.updated_at,
      );
    }

    const beforeRow = db.prepare('SELECT * FROM novels WHERE id = ?')
      .get(args.novelId) as Record<string, unknown> | undefined;
    if (!beforeRow) return { ok: false, reason: 'not_found' };
    const beforeNovel = mapNovel(hydrateNovelRow(beforeRow));

    const mutations: BrainstormEntryMutation[] = [];
    for (const entry of entriesToApply) {
      const before = readKnowledgeEntryByNormalizedIdentity(
        db,
        args.novelId,
        entry.type,
        entry.title,
      );
      let action: BrainstormEntryMutation['action'];
      if (before) {
        if (entry.id !== before.id) {
          throw new Error('Brainstorm finalization entry identity changed');
        }
        action = sameEntry(before, entry) ? 'unchanged' : 'updated';
        if (action === 'updated') {
          if (!entry.index) {
            throw new Error('Brainstorm finalization missing planned index');
          }
          updateKnowledgeEntryWithIndexInTx(db, entry.id, {
            title: entry.title,
            summary: entry.summary,
            data: JSON.stringify(entry.data),
            tags: JSON.stringify(entry.tags),
            updatedAt: entry.updatedAt,
          }, entry.index);
        }
      } else {
        if (!entry.index) {
          throw new Error('Brainstorm finalization missing planned index');
        }
        action = 'created';
        insertKnowledgeEntryWithIndexInTx(db, {
          id: entry.id,
          novelId: args.novelId,
          type: entry.type,
          title: entry.title,
          summary: entry.summary,
          data: JSON.stringify(entry.data),
          sortOrder: 0,
          tags: JSON.stringify(entry.tags),
          createdAt: entry.updatedAt,
          updatedAt: entry.updatedAt,
        }, entry.index);
      }
      const after = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?')
        .get(entry.id) as KnowledgeEntryRow;
      mutations.push({ action, before: before ?? null, after });
    }

    const novel = applyNovelUpdate(db, args.novelId, {
      ...args.profile,
      stage: 'ready_for_greenlight',
      progress: 0,
    });
    if (!novel) throw new Error('Novel disappeared during brainstorm finalization');
    return { ok: true, beforeNovel, novel, mutations, coverage };
  });
  return tx();
}
