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
  readyForGreenlight: z.boolean().optional(),
});

const storyDeckEntrySchema = z.object({
  type: z.enum(STORY_DECK_TYPES),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(1_000),
  details: z.record(z.string().max(64), z.string().max(500)).default({}),
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

export function brainstormAgentSystemAddon(locale: Locale): string {
  const zh = locale !== 'en';
  return zh
    ? `你正在主持一本小说的 Brainstorm。不要用固定问卷，不要在开场罗列问题清单，也不要要求用户按顺序填写。自然地覆盖篇幅、题材、参考作品、叙事视角、世界观、角色、核心冲突、结局倾向和读后感；每次最多追问一个最关键的问题。\n\n只有用户明确说出的事实才可以调用工具写入 Brainstorm profile 和 Story Deck；合理推断、补全和创意建议只能在回复中标为建议，等待用户明确同意后再写入，绝不能静默覆盖已有设定。Story Deck 只沉淀 characters、world、outline。每次工具写入后，用一句自然语言说明刚保存了什么。信息足够形成创作方案时可调用 ready 标记，但最终回复只展示用户可读的确认稿和下一步，不展示原始思维链。`
    : `You are running a novel Brainstorm. Do not use a fixed questionnaire, open with a checklist, or force the user through slots in order. Cover length, genre, references, point of view, world, characters, central conflict, ending direction, and target reader feeling naturally, asking at most one high-value follow-up at a time.\n\nOnly facts explicitly stated by the user may be written to the Brainstorm profile or Story Deck with tools. Inferences, gap-filling, and creative ideas must be labeled as suggestions in the reply and require explicit user agreement before writing; never silently overwrite an existing fact. Story Deck only contains characters, world, and outline. After a tool write, state in one natural sentence what was saved. When enough information exists for a writing brief, mark it ready, but only show a user-readable brief and next step, never raw chain-of-thought.`;
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
        if (input.readyForGreenlight && novel.stage === 'discovery_interview') {
          const updatedNovel = await updateNovel(novelId, {
            ...novelUpdate,
            interviewState: toJsonb(greenlightProposalState(novel, input)),
            stage: 'ready_for_greenlight',
            progress: 0,
          });
          if (receiptId && updatedNovel) {
            recordBrainstormProfileMutation(receiptId, novel, updatedNovel);
          }
        } else {
          const updatedNovel = await updateNovel(novelId, novelUpdate);
          if (receiptId && updatedNovel) {
            recordBrainstormProfileMutation(receiptId, novel, updatedNovel);
          }
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
  };
}
