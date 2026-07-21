import { tool } from 'ai';
import { z } from 'zod';

import {
  getKnowledgeEntries,
  getNovel,
  updateNovel,
  type KnowledgeEntryRow,
} from '@/lib/db';
import type { Novel } from '@/lib/db-types';
import type { Locale } from '@/lib/i18n';
import { toJsonb, type InterviewState } from '@/lib/interview-state';
import { upsertKnowledgeEntryByTitle } from '@/lib/knowledge/upsert-entry';
import { buildKnowledgeEntrySummary } from '@/lib/knowledge';
import { syncIndexFromEntry } from '@/lib/knowledge/index-sync';
import {
  clearStaleEmbedding,
  scheduleEmbeddingRefresh,
  trySyncKnowledgeEntryToVault,
} from '@/lib/knowledge/apply-write';
import { finalizeBrainstormAtomic } from '@/lib/db/brainstorm-finalization';
import { isInStages, type NovelStage } from '@/lib/novel-stages';
import type { KnowledgeType } from '@/lib/types/knowledge';
import {
  recordBrainstormEntryMutation,
  recordBrainstormProfileMutation,
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
  novel: Novel,
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

async function upsertStoryDeckEntry(
  novelId: string,
  entry: z.infer<typeof storyDeckEntrySchema>,
  existingByType: ReadonlyMap<StoryDeckType, readonly KnowledgeEntryRow[]>,
): Promise<'created' | 'updated' | 'unchanged'> {
  const title = entry.title.trim();
  const summaryInput = entry.summary.trim();
  const data: Record<string, unknown> = storyDeckData(entry.type, summaryInput, entry.details);
  const result = await upsertKnowledgeEntryByTitle({
    novelId,
    type: entry.type as KnowledgeType,
    title,
    data,
    tags: ['brainstorm'],
    existingEntries: existingByType.get(entry.type) ?? [],
    context: 'brainstormAgent.upsertStoryDeckEntries',
  });
  return result;
}

type FinalizeBrainstormInput = z.infer<typeof finalizeBrainstormSchema>;

async function commitFinalizedBrainstorm(
  novelId: string,
  input: FinalizeBrainstormInput,
  receiptId?: string,
  options: { preserveExistingStoryDeck?: boolean } = {},
) {
  const novel = await getNovel(novelId);
  if (!novel || !isInStages(novel.stage, EDITABLE_BRAINSTORM_STAGES)) {
    return { ok: false as const, reason: 'not_editable' as const };
  }
  const uniqueEntries = Array.from(new Map(input.entries.map(entry => [
    `${entry.type}:${entry.title.trim().toLowerCase()}`,
    {
      type: entry.type,
      title: entry.title.trim(),
      summary: entry.summary.trim(),
      data: storyDeckData(entry.type, entry.summary.trim(), entry.details),
      tags: ['brainstorm'],
    },
  ])).values());
  const profileUpdate = Object.fromEntries(Object.entries({
    genre: trimOptional(input.profile.genre),
    targetWords: input.profile.targetWords,
    storySummary: trimOptional(input.profile.storySummary),
    characterSummary: trimOptional(input.profile.characterSummary),
    arcSummary: trimOptional(input.profile.arcSummary),
  }).filter(([, value]) => value !== undefined));
  const result = await finalizeBrainstormAtomic({
    novelId,
    profile: {
      ...profileUpdate,
      interviewState: toJsonb(greenlightProposalState(novel, input.profile)),
    },
    entries: uniqueEntries.map(entry => ({
      ...entry,
      summary: buildKnowledgeEntrySummary(entry.type, entry.data),
    })),
    preserveExistingStoryDeck: options.preserveExistingStoryDeck,
  });
  if (!result.ok) return result;

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

  await Promise.allSettled(result.mutations.map(async mutation => {
    const entry = mutation.after;
    await syncIndexFromEntry({
      id: entry.id,
      novelId,
      type: entry.type as KnowledgeType,
      title: entry.title,
      summary: entry.summary,
      data: JSON.parse(entry.data) as Record<string, unknown>,
      tags: JSON.parse(entry.tags) as string[],
      updatedAt: entry.updated_at,
    });
    await trySyncKnowledgeEntryToVault(novelId, entry.id, 'brainstormAgent.finalizeBrainstorm');
    await clearStaleEmbedding(entry.id, novelId);
    scheduleEmbeddingRefresh(entry.id);
  }));

  return { ok: true as const, coverage: result.coverage };
}

export async function finalizeApprovedStoryDeck(
  novelId: string,
  locale: Locale,
  receiptId?: string,
) {
  const novel = await getNovel(novelId);
  if (!novel || !isInStages(novel.stage, EDITABLE_BRAINSTORM_STAGES)) {
    return { ok: false as const, reason: 'not_editable' as const };
  }
  const storySummary = novel.storySummary.trim() || novel.arcSummary.trim() || novel.title;
  const characterSummary = novel.characterSummary.trim() || storySummary;
  const arcSummary = novel.arcSummary.trim() || storySummary;
  const zh = locale !== 'en';
  return commitFinalizedBrainstorm(novelId, {
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
  }, receiptId, { preserveExistingStoryDeck: true });
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

export function createBrainstormTools(novelId: string, receiptId?: string) {
  return {
    updateBrainstormProfile: tool({
      description: 'Merge the current conversation into the novel brainstorm profile.',
      inputSchema: updateBrainstormProfileSchema,
      execute: async input => {
        const novel = await getNovel(novelId);
        if (!novel || !isInStages(novel.stage, EDITABLE_BRAINSTORM_STAGES)) {
          return { ok: false, reason: 'not_editable' };
        }
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
        const updatedNovel = await updateNovel(novelId, novelUpdate);
        if (receiptId && updatedNovel) {
          recordBrainstormProfileMutation(receiptId, novel, updatedNovel);
        }
        return { ok: true };
      },
    }),
    upsertStoryDeckEntries: tool({
      description: 'Create or update Story Deck entries from brainstormed characters, world rules, and outline beats.',
      inputSchema: z.object({
        entries: z.array(storyDeckEntrySchema).min(1).max(6),
      }),
      execute: async input => {
        const novel = await getNovel(novelId);
        if (!novel || !isInStages(novel.stage, EDITABLE_BRAINSTORM_STAGES)) {
          return { ok: false, reason: 'not_editable' };
        }
        const uniqueEntries = Array.from(
          new Map(input.entries.map(entry => [
            `${entry.type}:${entry.title.trim().toLowerCase()}`,
            entry,
          ])).values(),
        );
        const touchedTypes = Array.from(new Set(uniqueEntries.map(entry => entry.type)));
        const existingPairs = await Promise.all(touchedTypes.map(async type => [
          type,
          await getKnowledgeEntries(novelId, { type }),
        ] as const));
        const existingByType = new Map(existingPairs);
        const results = await Promise.all(uniqueEntries.map(entry =>
          upsertStoryDeckEntry(novelId, entry, existingByType),
        ));
        if (receiptId) {
          const afterPairs = await Promise.all(touchedTypes.map(async type => [
            type,
            await getKnowledgeEntries(novelId, { type }),
          ] as const));
          const afterByType = new Map(afterPairs);
          uniqueEntries.forEach((entry, index) => {
            const result = results[index];
            if (result === 'unchanged') return;
            const normalizedTitle = entry.title.trim().toLowerCase();
            const before = (existingByType.get(entry.type) ?? []).find(
              candidate => candidate.title.trim().toLowerCase() === normalizedTitle,
            ) ?? null;
            const after = (afterByType.get(entry.type) ?? []).find(
              candidate => candidate.title.trim().toLowerCase() === normalizedTitle,
            );
            if (after) recordBrainstormEntryMutation(receiptId, before, after, result);
          });
        }
        return {
          ok: true,
          created: results.filter(result => result === 'created').length,
          updated: results.filter(result => result === 'updated').length,
          unchanged: results.filter(result => result === 'unchanged').length,
        };
      },
    }),
    finalizeBrainstorm: tool({
      description: 'Atomically save the approved brainstorm profile and complete Story Deck, then mark the story ready for approval. This must be the final tool call of the turn.',
      inputSchema: finalizeBrainstormSchema,
      execute: async input => commitFinalizedBrainstorm(novelId, input, receiptId),
    }),
  };
}
