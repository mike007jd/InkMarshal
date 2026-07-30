import { createHash } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';

import {
  getKnowledgeEntries,
  getNovel,
  type KnowledgeEntryRow,
} from '@/lib/db';
import { getDb } from '@/lib/db/connection';
import {
  insertKnowledgeEntryWithIndexInTx,
  readKnowledgeEntryByNormalizedIdentity,
  updateKnowledgeEntryWithIndexInTx,
} from '@/lib/db/queries-knowledge';
import { getKnowledgeVaultOutboxRow } from '@/lib/db/queries-knowledge-vault-outbox';
import type { KnowledgeIndexInsert } from '@/lib/db/queries-vault';
import { mapNovel, type Novel } from '@/lib/db-types';
import type { Locale } from '@/lib/i18n';
import { toJsonb, type InterviewState } from '@/lib/interview-state';
import { buildKnowledgeEntrySummary } from '@/lib/knowledge';
import { knowledgeEntryIdentityKey } from '@/lib/knowledge/entry-identity';
import { buildKnowledgeIndexInsert } from '@/lib/knowledge/index-sync';
import {
  attemptKnowledgeVaultUpsert,
  clearStaleEmbedding,
  scheduleEmbeddingRefresh,
} from '@/lib/knowledge/apply-write';
import {
  approveExistingBrainstormAtomicSync,
  finalizeBrainstormAtomicSync,
  type BrainstormProjectionRepair,
} from '@/lib/db/brainstorm-finalization';
import { mutateClaimedChatTurn } from '@/lib/db/queries-chat-turns';
import { applyNovelUpdate, hydrateNovelRow } from '@/lib/db/queries-novel';
import { isInStages, type NovelStage } from '@/lib/novel-stages';
import type { KnowledgeType } from '@/lib/types/knowledge';
import { nowIso, parseJsonField } from '@/lib/utils';
import {
  brainstormMutationCheckpoint,
  brainstormProfileSnapshot,
  type BrainstormProfileSnapshot,
  durableBrainstormSnapshot,
  type DurableBrainstormToolContext,
  recordBrainstormEntryMutation,
  recordBrainstormProfileMutation,
  runDurableBrainstormTool,
} from '@/lib/brainstorm-receipts';

const EDITABLE_BRAINSTORM_STAGES: readonly NovelStage[] = [
  'discovery_interview',
  'ready_for_greenlight',
];

const STORY_DECK_TYPES = ['character', 'world', 'outline'] as const;
type StoryDeckType = typeof STORY_DECK_TYPES[number];

const updateBrainstormProfileSchema = z.object({
  genre: z.string().max(120).optional(),
  targetWords: z.number().int().min(1_000).max(1_000_000).optional(),
  storySummary: z.string().max(2_000).optional(),
  characterSummary: z.string().max(2_000).optional(),
  arcSummary: z.string().max(2_000).optional(),
});

const storyDeckEntrySchema = z.object({
  type: z.enum(STORY_DECK_TYPES),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1_000),
  details: z.record(z.string().max(64), z.string().max(500)).default({}),
});

const finalizeBrainstormSchema = z.object({
  profile: updateBrainstormProfileSchema,
  entries: z.array(storyDeckEntrySchema).min(3).max(24),
}).superRefine((value, ctx) => {
  for (const type of STORY_DECK_TYPES) {
    if (!value.entries.some(entry => entry.type === type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries'],
        message: `Story Deck requires at least one ${type} entry`,
      });
    }
  }
});

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function storyDeckData(type: StoryDeckType, summary: string, details: Record<string, string>) {
  if (type === 'character') {
    return {
      role: 'supporting',
      description: summary,
      backstory: details.backstory ?? '',
      motivation: details.motivation ?? '',
      traits: Object.values(details).filter(Boolean).slice(0, 6),
      arc: details.arc ?? '',
      aliases: [],
    };
  }
  if (type === 'world') {
    return {
      category: 'rule',
      description: summary,
      details,
    };
  }
  return {
    chapterId: '',
    chapterNumber: Number(details.chapterNumber) || 1,
    synopsis: summary,
    keyEvents: Object.values(details).filter(Boolean).slice(0, 8),
    characters: [],
    pov: details.pov ?? '',
    status: 'planned',
    wordCountTarget: Number(details.wordCountTarget) || 0,
    notes: details.notes ?? '',
    level: 'chapter',
    parentId: '',
    sceneMeta: {
      pov: details.pov ?? '',
      time: details.time ?? '',
      location: details.location ?? '',
      conflict: details.conflict ?? '',
      outcome: details.outcome ?? '',
    },
    plotlineTags: [],
    characterArcTags: [],
    customMeta: {},
  };
}

function greenlightProposalState(
  novel: Pick<
    Novel,
    'genre' | 'targetWords' | 'storySummary' | 'characterSummary' | 'arcSummary'
  >,
  input: z.infer<typeof updateBrainstormProfileSchema>,
): InterviewState {
  const collectedProfile = {
    genre: trimOptional(input.genre) ?? novel.genre,
    targetWords: input.targetWords ? String(input.targetWords) : String(novel.targetWords),
    storySummary: trimOptional(input.storySummary) ?? novel.storySummary,
    characterSummary: trimOptional(input.characterSummary) ?? novel.characterSummary,
    arcSummary: trimOptional(input.arcSummary) ?? novel.arcSummary,
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

type FinalizeBrainstormInput = z.infer<typeof finalizeBrainstormSchema>;

type PlannedStoryDeckWrite = {
  entryKey: string;
  type: StoryDeckType;
  title: string;
  id: string;
  action: 'created' | 'updated' | 'unchanged';
  updatedAt: string;
  summary: string;
  data: Record<string, unknown>;
  tags: string[];
  index: KnowledgeIndexInsert | null;
};

function storyDeckInputMatchesRow(
  entry: z.infer<typeof storyDeckEntrySchema>,
  row: KnowledgeEntryRow | undefined,
): row is KnowledgeEntryRow {
  if (!row) return false;
  const data = storyDeckData(entry.type, entry.summary.trim(), entry.details);
  return row.title === entry.title.trim()
    && row.summary === buildKnowledgeEntrySummary(entry.type, data)
    && row.data === JSON.stringify(data)
    && row.tags === JSON.stringify(['brainstorm']);
}

/** Post-commit only: the transaction already committed index + outbox intent. */
async function drainCommittedBrainstormEntryEffects(
  novelId: string,
  entries: readonly KnowledgeEntryRow[],
): Promise<void> {
  await Promise.allSettled(entries.map(async entry => {
    const intent = getKnowledgeVaultOutboxRow(entry.id);
    if (
      intent?.operation === 'upsert'
      && intent.status === 'pending'
    ) {
      await attemptKnowledgeVaultUpsert(
        novelId,
        entry.id,
        intent.intentRevision,
        'brainstormAgent.storyDeck',
      );
    }
    await clearStaleEmbedding(entry.id, novelId);
    scheduleEmbeddingRefresh(entry.id);
  }));
}

async function planStoryDeckWrites(
  novelId: string,
  entries: readonly z.infer<typeof storyDeckEntrySchema>[],
  beforeByKey: ReadonlyMap<string, KnowledgeEntryRow>,
  reservedPaths = new Set<string>(),
): Promise<PlannedStoryDeckWrite[]> {
  const plans: PlannedStoryDeckWrite[] = [];
  for (const entry of entries) {
    const key = knowledgeEntryIdentityKey(entry);
    const before = beforeByKey.get(key);
    const title = entry.title.trim();
    const summaryInput = entry.summary.trim();
    const data = storyDeckData(entry.type, summaryInput, entry.details);
    const summary = buildKnowledgeEntrySummary(entry.type, data);
    const tags = ['brainstorm'];
    const action = !before
      ? 'created' as const
      : (storyDeckInputMatchesRow(entry, before) ? 'unchanged' as const : 'updated' as const);
    const id = before?.id ?? crypto.randomUUID();
    const updatedAt = nowIso();
    const index = action === 'unchanged'
      ? null
      : await buildKnowledgeIndexInsert({
        id,
        novelId,
        type: entry.type as KnowledgeType,
        title,
        summary,
        data,
        tags,
        updatedAt,
      }, reservedPaths);
    if (index) reservedPaths.add(index.path);
    plans.push({
      entryKey: key,
      type: entry.type,
      title,
      id,
      action,
      updatedAt,
      summary,
      data,
      tags,
      index,
    });
  }
  return plans;
}

function buildFinalizeEntries(plannedWrites: readonly PlannedStoryDeckWrite[]) {
  return plannedWrites.map(plan => ({
    id: plan.id,
    type: plan.type,
    title: plan.title,
    summary: plan.summary,
    data: plan.data,
    tags: plan.tags,
    updatedAt: plan.updatedAt,
    index: plan.index,
  }));
}

function commitFinalizedBrainstormSync(
  novelId: string,
  input: FinalizeBrainstormInput,
  plannedWrites: readonly PlannedStoryDeckWrite[],
  receiptId: string | undefined,
  options: {
    preserveExistingStoryDeck?: boolean;
    projectionRepairs?: readonly BrainstormProjectionRepair[];
  } = {},
) {
  const db = getDb();
  const novel = readBrainstormNovel(db, novelId);
  if (!novel || !isInStages(novel.stage, EDITABLE_BRAINSTORM_STAGES)) {
    return { ok: false as const, reason: 'not_editable' as const };
  }
  const profileUpdate = Object.fromEntries(Object.entries({
    genre: trimOptional(input.profile.genre),
    targetWords: input.profile.targetWords,
    storySummary: trimOptional(input.profile.storySummary),
    characterSummary: trimOptional(input.profile.characterSummary),
    arcSummary: trimOptional(input.profile.arcSummary),
  }).filter(([, value]) => value !== undefined));
  const result = finalizeBrainstormAtomicSync({
    novelId,
    profile: {
      ...profileUpdate,
      interviewState: toJsonb(greenlightProposalState(novel, input.profile)),
    },
    entries: buildFinalizeEntries(plannedWrites),
    preserveExistingStoryDeck: options.preserveExistingStoryDeck,
    projectionRepairs: options.projectionRepairs,
  });
  if (!result.ok) return result;

  brainstormMutationCheckpoint('after_first_mutation');
  if (receiptId) {
    recordBrainstormProfileMutation(receiptId, result.beforeNovel, result.novel);
    for (const mutation of result.mutations) {
      if (mutation.action !== 'unchanged') {
        recordBrainstormEntryMutation(
          receiptId,
          mutation.before,
          mutation.after,
          mutation.action,
        );
      }
    }
  }
  return {
    ok: true as const,
    coverage: result.coverage,
    mutations: result.mutations,
  };
}

function upsertStoryDeckEntryInTx(
  db: ReturnType<typeof getDb>,
  novelId: string,
  entry: z.infer<typeof storyDeckEntrySchema>,
  plan: PlannedStoryDeckWrite,
): {
  action: 'created' | 'updated' | 'unchanged';
  before: KnowledgeEntryRow | null;
  after: KnowledgeEntryRow | null;
} {
  const title = entry.title.trim();
  const tagsJson = JSON.stringify(plan.tags);
  const dataJson = JSON.stringify(plan.data);
  const before = readKnowledgeEntryByNormalizedIdentity(
    db,
    novelId,
    entry.type,
    title,
  ) ?? null;

  if (plan.action === 'unchanged') {
    return { action: 'unchanged', before, after: before };
  }
  if (!plan.index) throw new Error('Durable brainstorm tool missing planned index');
  if (plan.action === 'created') {
    insertKnowledgeEntryWithIndexInTx(db, {
      id: plan.id,
      novelId,
      type: entry.type,
      title,
      summary: plan.summary,
      data: dataJson,
      sortOrder: 0,
      tags: tagsJson,
      createdAt: plan.updatedAt,
      updatedAt: plan.updatedAt,
    }, plan.index);
    const after = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(plan.id) as KnowledgeEntryRow;
    return { action: 'created', before: null, after };
  }
  updateKnowledgeEntryWithIndexInTx(db, plan.id, {
    title,
    summary: plan.summary,
    data: dataJson,
    tags: tagsJson,
    updatedAt: plan.updatedAt,
  }, plan.index);
  const after = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(plan.id) as KnowledgeEntryRow;
  return { action: 'updated', before, after };
}

function buildApprovedStoryDeckInput(novel: Novel, locale: Locale): FinalizeBrainstormInput {
  const storySummary = novel.storySummary.trim() || novel.arcSummary.trim() || novel.title;
  const characterSummary = novel.characterSummary.trim() || storySummary;
  const arcSummary = novel.arcSummary.trim() || storySummary;
  const zh = locale !== 'en';
  return {
    profile: {
      genre: novel.genre,
      targetWords: novel.targetWords,
      storySummary,
      characterSummary,
      arcSummary,
    },
    entries: [
      {
        type: 'character',
        title: zh ? '主要角色' : 'Main Cast',
        summary: characterSummary,
        details: { motivation: arcSummary, arc: arcSummary },
      },
      {
        type: 'world',
        title: zh ? '故事世界' : 'Story World',
        summary: storySummary,
        details: { genre: novel.genre, premise: storySummary },
      },
      {
        type: 'outline',
        title: zh ? '故事大纲' : 'Story Outline',
        summary: arcSummary,
        details: { notes: storySummary, chapterNumber: '1' },
      },
    ],
  };
}

async function prepareApprovedStoryDeck(
  novelId: string,
  locale: Locale,
) {
  const novel = await getNovel(novelId);
  if (!novel || !isInStages(novel.stage, EDITABLE_BRAINSTORM_STAGES)) {
    return { ok: false as const, reason: 'not_editable' as const };
  }
  const input = buildApprovedStoryDeckInput(novel, locale);
  const entries = input.entries;
  const scopedEntries = (await Promise.all(STORY_DECK_TYPES.map(
    type => getKnowledgeEntries(novelId, { type }),
  ))).flat();
  const reservedPaths = new Set<string>();
  const projectionRepairs: BrainstormProjectionRepair[] = [];
  for (const entry of scopedEntries) {
    const index = await buildKnowledgeIndexInsert({
      id: entry.id,
      novelId,
      type: entry.type as KnowledgeType,
      title: entry.title,
      summary: entry.summary,
      data: parseJsonField<Record<string, unknown>>(entry.data, {}),
      tags: parseJsonField<string[]>(entry.tags, []),
      updatedAt: entry.updated_at,
    }, reservedPaths);
    reservedPaths.add(index.path);
    projectionRepairs.push({ entry, index });
  }
  const existingTypes = new Set(scopedEntries.map(entry => entry.type));
  const missingEntries = entries.filter(entry => !existingTypes.has(entry.type));
  const plannedWrites = await planStoryDeckWrites(
    novelId,
    missingEntries,
    new Map(scopedEntries.map(entry => [knowledgeEntryIdentityKey(entry), entry])),
    reservedPaths,
  );
  return {
    ok: true as const,
    input,
    beforeProfile: brainstormProfileSnapshot(novel),
    beforeStage: novel.stage,
    beforeEntries: scopedEntries,
    beforeScopeFingerprint: knowledgeEntriesFingerprint(scopedEntries),
    plannedWrites,
    projectionRepairs,
  };
}

export async function finalizeApprovedStoryDeckForClaim(args: {
  novelId: string;
  locale: Locale;
  receiptId: string;
  userMessageId: string;
  claimToken: string;
}) {
  const prepared = await prepareApprovedStoryDeck(args.novelId, args.locale);
  if (!prepared.ok) return prepared;
  const claimed = mutateClaimedChatTurn({
    novelId: args.novelId,
    userMessageId: args.userMessageId,
    claimToken: args.claimToken,
    mutate: db => {
      const currentNovel = readBrainstormNovel(db, args.novelId);
      if (
        !sameBrainstormProfile(currentNovel, prepared.beforeProfile)
        || knowledgeEntriesFingerprint(readBrainstormState(db, args.novelId).entries)
          !== prepared.beforeScopeFingerprint
        || !storyDeckKeysMatchPreparedBefore(db, args.novelId, prepared)
      ) {
        throw new Error('Story Deck repair state conflict');
      }
      return commitFinalizedBrainstormSync(
        args.novelId,
        prepared.input,
        prepared.plannedWrites,
        args.receiptId,
        {
          preserveExistingStoryDeck: true,
          projectionRepairs: prepared.projectionRepairs,
        },
      );
    },
  });
  if (claimed.kind === 'lost_claim') {
    throw new Error('Chat turn claim lost before Story Deck repair');
  }
  const result = claimed.result;
  if (!result.ok) return result;
  const entriesToDrain = new Map(prepared.projectionRepairs.map(
    repair => [repair.entry.id, repair.entry],
  ));
  for (const mutation of result.mutations) {
    if (mutation.action !== 'unchanged') {
      entriesToDrain.set(mutation.after.id, mutation.after);
    }
  }
  await drainCommittedBrainstormEntryEffects(
    args.novelId,
    [...entriesToDrain.values()],
  );
  return { ok: true as const, coverage: result.coverage };
}

export async function approveExplicitWritingPlanForClaim(args: {
  novelId: string;
  receiptId: string;
  userMessageId: string;
  claimToken: string;
}) {
  const claimed = mutateClaimedChatTurn({
    novelId: args.novelId,
    userMessageId: args.userMessageId,
    claimToken: args.claimToken,
    mutate: () => {
      const result = approveExistingBrainstormAtomicSync(args.novelId);
      if (result.ok && !result.alreadyReady) {
        recordBrainstormProfileMutation(
          args.receiptId,
          result.beforeNovel,
          result.novel,
        );
      }
      return result;
    },
  });
  if (claimed.kind === 'lost_claim') {
    throw new Error('Chat turn claim lost before explicit brainstorm approval');
  }
  return claimed.result;
}

function hasWritingApprovalVeto(text: string): boolean {
  // Questions always fail closed — even when they mention approve/begin writing.
  if (/[?？]/.test(text)) return true;
  if (/(?:吗|嗎|么|麼|呢)\s*[。.!！]*\s*$/u.test(text)) return true;
  if (
    /(?:什么时候|什麼時候|何时|何時).{0,24}(?:批准|开始写|開始寫|动笔|動筆|begin\s+writing|start\s+writing|approve)/i.test(text)
    || /^(?:请问|請問|when\b)/i.test(text)
    || /\b(?:can|could|should|may)\s+(?:i|we)\b/i.test(text)
    || /\bdo\s+we\b.+\b(?:approve|begin|start)\b/i.test(text)
  ) {
    return true;
  }

  // Mentions, deliberation, future intent, and help requests are not approval.
  if (
    /(?:明天|以后|以後|之后|之後|稍后|稍後|可能|也许|也許|或许|或許|考虑|考慮|想想|不是要|并非要|並非要).{0,24}(?:批准|开始写|開始寫|动笔|動筆)/.test(text)
    || /(?:告诉我|告訴我|解释|解釋|说明|說明).{0,24}(?:如何|怎么|怎麼).{0,24}(?:批准|开始写|開始寫|动笔|動筆)/.test(text)
    || /\b(?:might|maybe|perhaps|consider|considering|wonder|wondering|intend|planning|tomorrow|later|eventually|someday)\b.{0,32}\bapprove\b/i.test(text)
    || /\bapprove\b.{0,24}\b(?:tomorrow|later|eventually|someday)\b/i.test(text)
    || /\b(?:tell|show|explain)\b.{0,24}\bhow\s+to\s+approve\b/i.test(text)
  ) {
    return true;
  }

  // Negation is bound to the approval action itself. Channel constraints such
  // as "do not write prose in chat; approve writing" must remain approvable.
  if (
    /(?:不要|不用|不能|不可|先别|先別|暂不|暫不|还没|還沒|尚未|别急|別急|先不)\s*(?:再|现在|現在|马上|馬上)?\s*(?:批准|开始写|開始寫|动笔|動筆)/.test(text)
    || /批准(?:写作|寫作|动笔|動筆)?前/.test(text)
    || /don'?t\s+(?:yet\s+)?(?:approve|start\s+writing|begin\s+writing)/i.test(text)
    || /(?:do\s+not|not\s+(?:yet\s+)?ready\s+to)\s+approve/i.test(text)
    || /\bnot\s+(?:yet\s+)?(?:approve|start\s+writing|begin\s+writing)\b/i.test(text)
    || /(?:before|without)\s+approving/i.test(text)
    || /\bafter\s+(?:we\s+)?(?:adjust|revise|change)\b/i.test(text)
  ) {
    return true;
  }

  return false;
}

function hasAffirmativePlanChangeIntent(text: string): boolean {
  const planObject = '(?:方案|大纲|大綱|设定|設定|结局|結局|角色|世界观|世界觀)';
  const changeAction = '(?:改|调整|調整|修改|换|換)';
  const changeCandidateText = text
    .replace(
      new RegExp(
        `(?:不要|不用|不必|无需|無需|别|別)\\s*(?:再)?\\s*(?:(?:把|将|將)\\s*)?(?:${planObject}\\s*)?${changeAction}(?:.{0,16}${planObject})?`,
        'g',
      ),
      '',
    )
    .replace(
      new RegExp(
        `${planObject}\\s*(?:不要|不用|不必|无需|無需|别|別)\\s*(?:再)?\\s*${changeAction}`,
        'g',
      ),
      '',
    )
    .replace(
      /\b(?:do\s+not|don'?t|no\s+need\s+to|need\s+not|should\s+not|shouldn'?t)\s+(?:adjust|revise|change|rewrite|fix|make)\b.{0,24}\b(?:plan|outline|story|ending|character|world)\b/gi,
      '',
    );

  // Any same-turn plan change is multi-intent and must return to Brainstorm.
  if (
    /(?:把|将|將)?\s*(?:方案|大纲|大綱|设定|設定|结局|結局|角色|世界观|世界觀).{0,16}(?:改|调整|調整|修改|换|換)/.test(changeCandidateText)
    || /(?:改|调整|調整|修改|换|換).{0,16}(?:方案|大纲|大綱|设定|設定|结局|結局|角色|世界观|世界觀)/.test(changeCandidateText)
    || /\b(?:adjust|revise|change|rewrite|fix|make)\b.{0,24}\b(?:plan|outline|story|ending|character|world)\b/i.test(changeCandidateText)
  ) {
    return true;
  }

  return false;
}

function hasExplicitApproveNow(text: string): boolean {
  return (
    /^\s*(?:请|請)?\s*(?:批准(?:开始|開始)?(?:写作|寫作|动笔|動筆)(?:(?:并|並)?(?:开始|開始|启动|啟動)(?:写作|寫作|(?:第一章|第1章|一章)(?:写作|寫作)?)(?:任务|任務)?)?|同意(?:开始|開始)(?:写作|寫作|动笔|動筆)|(?:大纲|大綱)(?:无误|無誤|没问题|沒問題)|方案(?:没问题|沒問題|无误|無誤)|(?:就)?按(?:这个|這個|此)方案(?:开始写|開始寫)(?:第一章|第1章|一章)?|批准(?:当前|當前)?(?:的)?(?:故事)?方案(?:(?:并|並)(?:开始|開始|启动|啟動)(?:写作|寫作|(?:第一章|第1章|一章)(?:写作|寫作)?)(?:任务|任務)?)?)\s*(?:吧)?$/.test(text)
    || /^\s*(?:请|請)?(?:使用系统写作工具|使用系統寫作工具).{0,24}批准(?:当前|當前)?(?:的)?(?:故事)?方案(?:(?:并|並)(?:开始|開始|启动|啟動)(?:写作|寫作|(?:第一章|第1章|一章)(?:写作|寫作)?)(?:任务|任務)?)?\s*$/.test(text)
    || /^\s*(?:yes\s*)?(?:please\s+)?(?:approve\s*(?:and|&)\s*(?:begin|start)\s+writing|approve\s+writing(?:(?:\s+and\s+(?:begin|start)\s+(?:writing|chapter\s+(?:one|1)|the\s+first\s+chapter)(?:\s+now)?)|\s+now)?|approve(?:\s+the)?\s+(?:current\s+)?(?:story\s+)?(?:plan|outline|deck)(?:\s+and\s+(?:begin|start)\s+(?:writing|chapter\s+(?:one|1)|the\s+first\s+chapter)(?:\s+now)?)?|(?:begin|start)\s+writing\s+now|go\s+ahead\s+with\s+chapter\s+(?:one|1)|(?:begin|start)\s+(?:with\s+)?chapter\s+(?:one|1))\s*$/i.test(text)
    || /^\s*(?:yes\s*)?i\s+approve\s+(?:writing|the\s+(?:current\s+)?(?:story\s+)?(?:plan|outline|deck))\s*$/i.test(text)
  );
}

function isReportedApprovalLead(text: string): boolean {
  return (
    /\b(?:ui|interface|screen|button|label|editor|document|note)\b.{0,24}\b(?:says?|shows?|reads?|wrote|states?)\s*$/i.test(text)
    || /(?:界面|介面|按钮|按鈕|标签|標籤|编辑|編輯|文档|文檔|笔记|筆記).{0,16}(?:显示|顯示|写着|寫著|说|說|标注|標註)\s*$/.test(text)
  );
}

function isDeferredApprovalLead(text: string): boolean {
  return /^(?:tomorrow|later|eventually|someday|明天|以后|以後|之后|之後|稍后|稍後)$/i.test(
    text.trim(),
  );
}

/**
 * True when the user is explicitly approving the plan to leave Brainstorm and
 * proceed toward writing. Ordinary brainstorm prompts, questions, deferred
 * approval, plan adjustments, and "ready-to-approve" phrasing must stay false
 * so small models cannot be "helped" into a silent finalize.
 */
export function isExplicitWritingApproval(text: string): boolean {
  const raw = text.normalize('NFKC').trim();
  if (!raw) return false;

  // "可批准写作" means the plan is ready for review, not that the user approved.
  const normalized = raw.replace(/可批准(?:写作|寫作)/g, '可就绪');
  if (/[?？]/.test(normalized) || hasAffirmativePlanChangeIntent(normalized)) return false;

  const clauses = normalized
    .split(/[。.!！?？；;，,\n]+/)
    .map(clause => clause.trim())
    .filter(Boolean);
  return clauses.some((clause, index) => {
    if (!hasExplicitApproveNow(clause) || hasWritingApprovalVeto(clause)) return false;
    const previousClause = clauses[index - 1];
    return !previousClause
      || (!isReportedApprovalLead(previousClause) && !isDeferredApprovalLead(previousClause));
  });
}

export function brainstormAgentSystemAddon(locale: Locale, stage?: NovelStage): string {
  const zh = locale !== 'en';
  if (stage === 'ready_for_greenlight') {
    return zh
      ? `当前处于方案审阅阶段。禁止生成小说正文、章节试写或继续冒险情节。只回答方案调整问题；如果 Story Deck 不完整，或用户批准了调整，必须调用 finalizeBrainstorm 一次性保存完整 profile、character、world、outline。调用 finalizeBrainstorm 后立即结束本轮，不再输出正文。`
      : `This is proposal review. Do not generate manuscript prose, sample chapters, or continue the plot. Only discuss plan adjustments. If the Story Deck is incomplete or the user approves a change, call finalizeBrainstorm with the complete profile plus character, world, and outline entries. End the turn immediately after finalizeBrainstorm and do not output prose.`;
  }
  return zh
    ? `你正在主持一本小说的 Brainstorm。不要用固定问卷，不要在开场罗列问题清单，也不要要求用户按顺序填写。自然地覆盖篇幅、题材、参考作品、叙事视角、世界观、角色、核心冲突、结局倾向和读后感；每次最多追问一个最关键的问题。\n\n只有用户明确说出的事实才可以调用工具写入 Brainstorm profile 和 Story Deck；合理推断、补全和创意建议只能在回复中标为建议，等待用户明确同意后再写入，绝不能静默覆盖已有设定。信息足够形成完整创作方案时，必须调用 finalizeBrainstorm，一次性保存 profile 以及至少一张 character、world、outline 卡片。调用后立即结束本轮，只给出简短完成提示，禁止继续写小说正文。`
    : `You are running a novel Brainstorm. Do not use a fixed questionnaire, open with a checklist, or force the user through slots in order. Cover length, genre, references, point of view, world, characters, central conflict, ending direction, and target reader feeling naturally, asking at most one high-value follow-up at a time.\n\nOnly facts explicitly stated by the user may be written to the Brainstorm profile or Story Deck with tools. Inferences, gap-filling, and creative ideas must be labeled as suggestions and require explicit approval. When the complete writing brief is ready, call finalizeBrainstorm once with the profile and at least one character, world, and outline entry. End the turn immediately after that tool and never continue into manuscript prose.`;
}

function knowledgeEntriesFingerprint(entries: readonly KnowledgeEntryRow[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...entries].sort((left, right) =>
      `${left.type}\0${left.title}\0${left.id}`.localeCompare(
        `${right.type}\0${right.title}\0${right.id}`,
      )
    )))
    .digest('hex');
}

function sameKnowledgeEntryRow(
  left: KnowledgeEntryRow,
  right: KnowledgeEntryRow,
): boolean {
  return left.id === right.id
    && left.novel_id === right.novel_id
    && left.series_id === right.series_id
    && left.type === right.type
    && left.title === right.title
    && left.summary === right.summary
    && left.data === right.data
    && left.data_v === right.data_v
    && left.tags === right.tags
    && left.sort_order === right.sort_order
    && left.created_at === right.created_at
    && left.updated_at === right.updated_at;
}

/** Per-key fencing so concurrent same-name tool calls with different titles can commit. */
function storyDeckKeysMatchPreparedBefore(
  db: ReturnType<typeof getDb>,
  novelId: string,
  prepared: {
    beforeStage: NovelStage | null;
    beforeEntries: readonly KnowledgeEntryRow[];
    plannedWrites: readonly PlannedStoryDeckWrite[];
  },
): boolean {
  const novelRow = db.prepare('SELECT stage FROM novels WHERE id = ?').get(novelId) as
    | { stage: NovelStage }
    | undefined;
  if ((novelRow?.stage ?? null) !== prepared.beforeStage) return false;
  const beforeByKey = new Map(
    prepared.beforeEntries.map(entry => [knowledgeEntryIdentityKey(entry), entry]),
  );
  for (const plan of prepared.plannedWrites) {
    const current = readKnowledgeEntryByNormalizedIdentity(
      db,
      novelId,
      plan.type,
      plan.title,
    );
    const before = beforeByKey.get(plan.entryKey);
    if (plan.action === 'created') {
      if (current) return false;
      continue;
    }
    if (!before || !current || !sameKnowledgeEntryRow(before, current)) return false;
  }
  return true;
}

function readBrainstormNovel(
  db: ReturnType<typeof getDb>,
  novelId: string,
): Novel | null {
  const row = db.prepare('SELECT * FROM novels WHERE id = ?').get(novelId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapNovel(hydrateNovelRow(row)) : null;
}

function readBrainstormState(
  db: ReturnType<typeof getDb>,
  novelId: string,
) {
  const entries = STORY_DECK_TYPES.flatMap(type =>
    db.prepare(
      'SELECT * FROM knowledge_entries WHERE novel_id = ? AND type = ?',
    ).all(novelId, type) as KnowledgeEntryRow[]
  );
  return {
    novel: readBrainstormNovel(db, novelId),
    entries,
  };
}

function sameBrainstormProfile(
  novel: Novel | null | undefined,
  snapshot: BrainstormProfileSnapshot | null,
): boolean {
  return Boolean(
    novel
    && snapshot
    && Object.entries(snapshot).every(
      ([field, value]) => sameJsonValue(novel[field as keyof Novel], value),
    ),
  );
}

function profileAfterSnapshot(
  before: BrainstormProfileSnapshot,
  update: Record<string, unknown>,
): BrainstormProfileSnapshot {
  return { ...before, ...update };
}

function isRecoveredProfileNoop(
  prepared: {
    beforeProfile: BrainstormProfileSnapshot | null;
    result: { ok: boolean };
  },
  current: Novel | null | undefined,
  novelUpdate: Record<string, unknown>,
): boolean {
  if (!prepared.result.ok || !prepared.beforeProfile) {
    return (
      (!current && !prepared.beforeProfile)
      || sameBrainstormProfile(current, prepared.beforeProfile)
    );
  }
  const expectedAfter = profileAfterSnapshot(prepared.beforeProfile, novelUpdate);
  return sameJsonValue(expectedAfter, prepared.beforeProfile)
    && sameBrainstormProfile(current, prepared.beforeProfile);
}

interface KnowledgeSnapshotReference {
  snapshotKey: string;
}

function externalizeKnowledgeBeforeEntries<
  T extends { beforeEntries: KnowledgeEntryRow[] },
>(prepared: T) {
  const stored = prepared.beforeEntries.map(entry => ({
    entry,
    snapshot: durableBrainstormSnapshot(entry),
  }));
  return {
    preparedData: {
      ...prepared,
      beforeEntries: stored.map(({ snapshot }) => ({
        snapshotKey: snapshot.snapshotKey,
      })),
    },
    snapshots: stored.map(({ snapshot }) => snapshot),
  };
}

function hydrateKnowledgeBeforeEntries<
  T extends { beforeEntries: KnowledgeEntryRow[] },
>(
  preparedData: unknown,
  readSnapshot: <TValue>(snapshotKey: string) => TValue,
): T {
  const stored = preparedData as Omit<T, 'beforeEntries'> & {
    beforeEntries: KnowledgeSnapshotReference[];
  };
  return {
    ...stored,
    beforeEntries: stored.beforeEntries.map(reference =>
      readSnapshot<KnowledgeEntryRow>(reference.snapshotKey)
    ),
  } as T;
}

export function createBrainstormTools(
  novelId: string,
  context: DurableBrainstormToolContext,
) {
  const { receiptId } = context;
  return {
    updateBrainstormProfile: tool({
      description: 'Merge the current conversation into the novel brainstorm profile.',
      inputSchema: updateBrainstormProfileSchema,
      execute: async input => {
        const update = {
          genre: trimOptional(input.genre),
          targetWords: input.targetWords,
          storySummary: trimOptional(input.storySummary),
          characterSummary: trimOptional(input.characterSummary),
          arcSummary: trimOptional(input.arcSummary),
        };
        const novelUpdate = Object.fromEntries(
          Object.entries(update).filter(([, value]) => value !== undefined),
        );
        const prepare = async () => {
          const beforeNovel = await getNovel(novelId);
          return {
            beforeProfile: beforeNovel ? brainstormProfileSnapshot(beforeNovel) : null,
            result: !beforeNovel || !isInStages(beforeNovel.stage, EDITABLE_BRAINSTORM_STAGES)
              ? { ok: false as const, reason: 'not_editable' as const }
              : { ok: true as const },
          };
        };
        const executeSync = (prepared: Awaited<ReturnType<typeof prepare>>) => {
          if (!prepared.result.ok || !prepared.beforeProfile) return prepared.result;
          const db = getDb();
          const current = readBrainstormNovel(db, novelId);
          if (!current || !isInStages(current.stage, EDITABLE_BRAINSTORM_STAGES)) {
            return { ok: false as const, reason: 'not_editable' as const };
          }
          if (!sameBrainstormProfile(current, prepared.beforeProfile)) {
            throw new Error('Durable brainstorm tool state conflict');
          }
          if (sameJsonValue(
            profileAfterSnapshot(prepared.beforeProfile, novelUpdate),
            prepared.beforeProfile,
          )) {
            return { ok: true as const };
          }
          const updatedNovel = applyNovelUpdate(db, novelId, novelUpdate);
          brainstormMutationCheckpoint('after_first_mutation');
          if (updatedNovel) {
            recordBrainstormProfileMutation(receiptId, current, updatedNovel);
          }
          return { ok: true as const };
        };
        return runDurableBrainstormTool({
          novelId,
          context,
          toolName: 'updateBrainstormProfile',
          input: novelUpdate,
          prepare,
          execute: executeSync,
          validateRecovered: (prepared, result) => {
            const current = readBrainstormNovel(getDb(), novelId);
            if (isRecoveredProfileNoop({ ...prepared, result }, current, novelUpdate)) {
              return;
            }
            throw new Error('Durable brainstorm tool state conflict');
          },
          recover: async prepared => {
            const current = await getNovel(novelId);
            if (isRecoveredProfileNoop(prepared, current, novelUpdate)) {
              return { state: 'already_after', result: prepared.result };
            }
            if (
              prepared.result.ok
              && prepared.beforeProfile
              && sameBrainstormProfile(current, prepared.beforeProfile)
            ) {
              return { state: 'safe_to_execute' };
            }
            return { state: 'conflict' };
          },
        });
      },
    }),
    upsertStoryDeckEntries: tool({
      description: 'Create or update Story Deck entries from brainstormed characters, world rules, and outline beats.',
      inputSchema: z.object({
        entries: z.array(storyDeckEntrySchema).min(1).max(6),
      }),
      execute: async input => {
        const uniqueEntries = Array.from(
          new Map(input.entries.map(entry => [
            knowledgeEntryIdentityKey(entry),
            entry,
          ])).values(),
        );
        const touchedTypes = Array.from(new Set(uniqueEntries.map(entry => entry.type)));
        const semanticInput = {
          entries: uniqueEntries.map(entry => ({
            ...entry,
            title: entry.title.trim(),
            summary: entry.summary.trim(),
          })),
        };
        const prepare = async () => {
          const novel = await getNovel(novelId);
          const scopedEntries = (await Promise.all(touchedTypes.map(
            type => getKnowledgeEntries(novelId, { type }),
          ))).flat();
          const beforeEntries = uniqueEntries.map(entry =>
            scopedEntries.find(row => knowledgeEntryIdentityKey(row) === knowledgeEntryIdentityKey(entry))
          ).filter((entry): entry is KnowledgeEntryRow => Boolean(entry));
          const beforeByKey = new Map(beforeEntries.map(entry => [knowledgeEntryIdentityKey(entry), entry]));
          const plannedWrites = await planStoryDeckWrites(novelId, uniqueEntries, beforeByKey);
          if (!novel || !isInStages(novel.stage, EDITABLE_BRAINSTORM_STAGES)) {
            return {
              editable: false as const,
              beforeStage: novel?.stage ?? null,
              beforeEntries,
              plannedWrites,
              result: { ok: false as const, reason: 'not_editable' as const },
            };
          }
          return {
            editable: true as const,
            beforeStage: novel.stage,
            beforeEntries,
            plannedWrites,
            result: {
              ok: true as const,
              created: plannedWrites.filter(plan => plan.action === 'created').length,
              updated: plannedWrites.filter(plan => plan.action === 'updated').length,
              unchanged: plannedWrites.filter(plan => plan.action === 'unchanged').length,
            },
          };
        };
        const executeSync = (prepared: Awaited<ReturnType<typeof prepare>>) => {
          if (!prepared.editable) return prepared.result;
          const db = getDb();
          const novelRow = db.prepare('SELECT stage, updated_at FROM novels WHERE id = ?')
            .get(novelId) as
            | { stage: NovelStage; updated_at: string }
            | undefined;
          if (!novelRow || !isInStages(novelRow.stage, EDITABLE_BRAINSTORM_STAGES)) {
            return { ok: false as const, reason: 'not_editable' as const };
          }
          if (!storyDeckKeysMatchPreparedBefore(db, novelId, prepared)) {
            throw new Error('Durable brainstorm tool state conflict');
          }
          const planByKey = new Map(
            prepared.plannedWrites.map(plan => [plan.entryKey, plan]),
          );
          const mutations = uniqueEntries.map(entry => {
            const plan = planByKey.get(knowledgeEntryIdentityKey(entry));
            if (!plan) throw new Error('Durable brainstorm tool missing planned write');
            return upsertStoryDeckEntryInTx(db, novelId, entry, plan);
          });
          brainstormMutationCheckpoint('after_first_mutation');
          for (const mutation of mutations) {
            if (mutation.action === 'unchanged' || !mutation.after) continue;
            recordBrainstormEntryMutation(
              receiptId,
              mutation.before,
              mutation.after,
              mutation.action,
              { profileRevisionBeforeMutation: Date.parse(novelRow.updated_at) },
            );
          }
          return {
            ok: true as const,
            created: mutations.filter(result => result.action === 'created').length,
            updated: mutations.filter(result => result.action === 'updated').length,
            unchanged: mutations.filter(result => result.action === 'unchanged').length,
          };
        };
        const durableResult = await runDurableBrainstormTool({
          novelId,
          context,
          toolName: 'upsertStoryDeckEntries',
          input: semanticInput,
          prepare,
          externalizePrepared: externalizeKnowledgeBeforeEntries,
          hydratePrepared: hydrateKnowledgeBeforeEntries,
          execute: executeSync,
          validateRecovered: (prepared, result) => {
            const db = getDb();
            const exactBefore = storyDeckKeysMatchPreparedBefore(db, novelId, prepared);
            const validNoop = !prepared.editable
              || (
                result.ok
                && result.created === 0
                && result.updated === 0
              );
            if (!exactBefore || !validNoop) {
              throw new Error('Durable brainstorm tool state conflict');
            }
          },
          recover: async prepared => {
            const db = getDb();
            if (!prepared.editable) {
              return storyDeckKeysMatchPreparedBefore(db, novelId, prepared)
                ? { state: 'already_after', result: prepared.result }
                : { state: 'conflict' };
            }
            if (storyDeckKeysMatchPreparedBefore(db, novelId, prepared)) {
              if (
                prepared.result.created === 0
                && prepared.result.updated === 0
              ) {
                return { state: 'already_after', result: prepared.result };
              }
              return { state: 'safe_to_execute' };
            }
            return { state: 'conflict' };
          },
        });
        if (durableResult.ok) {
          const afterEntries = (await Promise.all(touchedTypes.map(
            type => getKnowledgeEntries(novelId, { type }),
          ))).flat().filter(entry =>
            uniqueEntries.some(input => knowledgeEntryIdentityKey(input) === knowledgeEntryIdentityKey(entry)),
          );
          await drainCommittedBrainstormEntryEffects(novelId, afterEntries);
        }
        return durableResult;
      },
    }),
    finalizeBrainstorm: tool({
      description: 'Atomically save the approved brainstorm profile and complete Story Deck, then mark the story ready for approval. This must be the final tool call of the turn.',
      inputSchema: finalizeBrainstormSchema,
      execute: async input => {
        const uniqueEntries = Array.from(new Map(input.entries.map(entry => [
          knowledgeEntryIdentityKey(entry),
          entry,
        ])).values());
        const semanticInput = {
          profile: Object.fromEntries(Object.entries({
            genre: trimOptional(input.profile.genre),
            targetWords: input.profile.targetWords,
            storySummary: trimOptional(input.profile.storySummary),
            characterSummary: trimOptional(input.profile.characterSummary),
            arcSummary: trimOptional(input.profile.arcSummary),
          }).filter(([, value]) => value !== undefined)),
          entries: uniqueEntries.map(entry => ({
            ...entry,
            title: entry.title.trim(),
            summary: entry.summary.trim(),
          })),
        };
        const prepare = async () => {
          const beforeNovel = await getNovel(novelId);
          const scopedEntries = (await Promise.all(STORY_DECK_TYPES.map(
            type => getKnowledgeEntries(novelId, { type }),
          ))).flat();
          const beforeEntries = uniqueEntries.map(entry =>
            scopedEntries.find(row => knowledgeEntryIdentityKey(row) === knowledgeEntryIdentityKey(entry))
          ).filter((entry): entry is KnowledgeEntryRow => Boolean(entry));
          const beforeByKey = new Map(beforeEntries.map(entry => [knowledgeEntryIdentityKey(entry), entry]));
          const plannedWrites = await planStoryDeckWrites(novelId, uniqueEntries, beforeByKey);
          const coverage = uniqueEntries.reduce<Record<StoryDeckType, number>>(
            (counts, entry) => {
              counts[entry.type] += 1;
              return counts;
            },
            { character: 0, world: 0, outline: 0 },
          );
          return {
            beforeProfile: beforeNovel ? brainstormProfileSnapshot(beforeNovel) : null,
            beforeEntries,
            beforeScopeFingerprint: knowledgeEntriesFingerprint(scopedEntries),
            plannedWrites,
            result: !beforeNovel || !isInStages(beforeNovel.stage, EDITABLE_BRAINSTORM_STAGES)
              ? { ok: false as const, reason: 'not_editable' as const }
              : { ok: true as const, coverage },
          };
        };
        const executeSync = (prepared: Awaited<ReturnType<typeof prepare>>) => {
          if (!prepared.result.ok || !prepared.beforeProfile) return prepared.result;
          const db = getDb();
          const current = readBrainstormState(db, novelId);
          if (
            !sameBrainstormProfile(current.novel, prepared.beforeProfile)
            || knowledgeEntriesFingerprint(current.entries)
              !== prepared.beforeScopeFingerprint
          ) {
            throw new Error('Durable brainstorm tool state conflict');
          }
          const committed = commitFinalizedBrainstormSync(
            novelId,
            input,
            prepared.plannedWrites,
            receiptId,
          );
          if (!committed.ok) return committed;
          return { ok: true as const, coverage: committed.coverage };
        };
        const durableResult = await runDurableBrainstormTool({
          novelId,
          context,
          toolName: 'finalizeBrainstorm',
          input: semanticInput,
          prepare,
          externalizePrepared: externalizeKnowledgeBeforeEntries,
          hydratePrepared: hydrateKnowledgeBeforeEntries,
          execute: executeSync,
          validateRecovered: (prepared, result) => {
            const current = readBrainstormState(getDb(), novelId);
            const exactBefore = (
              (!current.novel && !prepared.beforeProfile)
              || sameBrainstormProfile(current.novel, prepared.beforeProfile)
            ) && knowledgeEntriesFingerprint(current.entries)
              === prepared.beforeScopeFingerprint;
            if (result.ok || !exactBefore) {
              throw new Error('Durable brainstorm tool state conflict');
            }
          },
          recover: async prepared => {
            const currentNovel = await getNovel(novelId);
            const currentEntries = (await Promise.all(STORY_DECK_TYPES.map(
              type => getKnowledgeEntries(novelId, { type }),
            ))).flat();
            if (!prepared.result.ok || !prepared.beforeProfile) {
              const exactBefore = (
                (!currentNovel && !prepared.beforeProfile)
                || sameBrainstormProfile(currentNovel, prepared.beforeProfile)
              ) && knowledgeEntriesFingerprint(currentEntries)
                === prepared.beforeScopeFingerprint;
              return exactBefore
                ? { state: 'already_after', result: prepared.result }
                : { state: 'conflict' };
            }
            const exactBefore = sameBrainstormProfile(
              currentNovel,
              prepared.beforeProfile,
            ) && knowledgeEntriesFingerprint(currentEntries)
              === prepared.beforeScopeFingerprint;
            return exactBefore
              ? { state: 'safe_to_execute' }
              : { state: 'conflict' };
          },
        });
        if (durableResult.ok) {
          const afterEntries = (await Promise.all(STORY_DECK_TYPES.map(
            type => getKnowledgeEntries(novelId, { type }),
          ))).flat();
          await drainCommittedBrainstormEntryEffects(novelId, afterEntries);
        }
        return durableResult;
      },
    }),
  };
}
