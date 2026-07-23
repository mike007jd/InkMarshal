// Genre prompt packs (W3-2, server-only).
//
// A genre pack is a curated `prompt_templates` variant that biases the AI's
// prose toward a genre's conventions (悬疑 / 言情 / 奇幻 / 网文). Applying a pack
// (1) INSERTs the pack's rows under its variant if they are not already present
// (INSERT-only, versioned — never clobbers the seeded default) and (2) points
// the novel's `settings.promptVariant` at that variant so the next generation
// run resolves against it.
//
// Mirrors lib/prompt-seed.ts's data-table shape. The pack only overrides the
// stage where genre voice matters most — chapter_write (system + user) —
// across all three locales; every other stage falls back to
// the default template via the resolver's variant fallback, so a pack is a thin
// stylistic overlay rather than a full fork.

import { getNovel, updateNovel } from '@/lib/db/queries-novel';
import {
  importVariantPack,
  type VariantPack,
  type VariantPackRow,
} from '@/lib/prompt-pack-io';

export interface GenrePack {
  id: string;
  /** The prompt_templates variant the pack lands under. */
  variant: string;
  label: { en: string; 'zh-CN': string; 'zh-TW': string };
  description: { en: string; 'zh-CN': string; 'zh-TW': string };
  rows: VariantPackRow[];
}

type Locale = 'en' | 'zh-CN' | 'zh-TW';

// Helper: build the chapter_write user row for a locale with a genre voice
// preamble spliced before the standard instructions. Keeps the {{var}} contract
// identical to the seeded template so VariableSchemaForm and renderTemplate work
// unchanged.
function chapterWriteUser(locale: Locale, voice: { en: string; 'zh-CN': string; 'zh-TW': string }): VariantPackRow {
  const body: Record<Locale, string> = {
    en: `You are writing Chapter {{chapterNumber}}: "{{title}}".

Novel: {{novelTitle}} ({{genre}})
Story context: {{storySummary}}
Characters: {{characterSummary}}

Chapter summary (what must happen): {{blueprintSummary}}

{{memorySections}}

{{langNote}}

GENRE DIRECTION: ${voice.en}

Write the full chapter now. Use vivid prose, natural dialogue, and strong scene-setting. Do NOT include the chapter title in the text — start directly with the narrative. Stay strictly consistent with character names, world facts, and recent events shown above.`,
    'zh-CN': `你正在写第 {{chapterNumber}} 章：「{{title}}」。

小说：{{novelTitle}}（{{genre}}）
故事上下文：{{storySummary}}
人物：{{characterSummary}}

本章梗概（必须发生的事）：{{blueprintSummary}}

{{memorySections}}

{{langNote}}

类型笔法：${voice['zh-CN']}

请立刻完整写出本章。文笔生动、对话自然、场景刻画到位。不要在正文中包含章节标题，直接从叙事开始。严格遵守上方的人物、世界与近期情节设定。`,
    'zh-TW': `你正在撰寫第 {{chapterNumber}} 章：「{{title}}」。

小說：{{novelTitle}}（{{genre}}）
故事上下文：{{storySummary}}
角色：{{characterSummary}}

本章大綱（必須發生的事）：{{blueprintSummary}}

{{memorySections}}

{{langNote}}

類型筆法：${voice['zh-TW']}

請立刻完整寫出本章。筆觸生動、對話自然、場景描寫到位。請勿在內文中放入章節標題，直接從敘事開始。嚴格遵守上方的角色、世界與近期情節設定。`,
  };
  return { stage: 'chapter_write', role: 'user', locale, templateText: body[locale], variablesSchema: '{}' };
}

function chapterWriteSystem(locale: Locale, persona: { en: string; 'zh-CN': string; 'zh-TW': string }): VariantPackRow {
  const text: Record<Locale, string> = {
    en: persona.en,
    'zh-CN': persona['zh-CN'],
    'zh-TW': persona['zh-TW'],
  };
  return { stage: 'chapter_write', role: 'system', locale, templateText: text[locale], variablesSchema: '{}' };
}

// Stage display labels moved to the client-safe lib/prompt-stage-labels.ts so
// the 'use client' workflows surface can import stageLabel without dragging this
// server-only module (and its DB imports) into the browser bundle.

const LOCALES: Locale[] = ['en', 'zh-CN', 'zh-TW'];

function buildPack(
  id: string,
  variant: string,
  label: GenrePack['label'],
  description: GenrePack['description'],
  persona: { en: string; 'zh-CN': string; 'zh-TW': string },
  voice: { en: string; 'zh-CN': string; 'zh-TW': string },
): GenrePack {
  const rows: VariantPackRow[] = [];
  for (const locale of LOCALES) {
    rows.push(chapterWriteSystem(locale, persona));
    rows.push(chapterWriteUser(locale, voice));
  }
  return { id, variant, label, description, rows };
}

export const GENRE_PACKS: GenrePack[] = [
  buildPack(
    'mystery',
    'genre_mystery',
    { en: 'Mystery / Suspense', 'zh-CN': '悬疑', 'zh-TW': '懸疑' },
    {
      en: 'Tight, clue-seeded suspense with controlled reveals and a paranoid undertow.',
      'zh-CN': '紧绷的悬念节奏，埋线索、控制揭示节点，弥漫不安与猜疑。',
      'zh-TW': '緊繃的懸念節奏，埋線索、控制揭示節點，瀰漫不安與猜疑。',
    },
    {
      en: 'You are a professional suspense novelist. You write taut, atmospheric prose that withholds and reveals information deliberately.',
      'zh-CN': '你是一位专业的悬疑小说家。你的文字紧张、富有氛围，会刻意地隐藏与揭示信息。',
      'zh-TW': '你是一位專業的懸疑小說家。你的文字緊張、富有氛圍，會刻意地隱藏與揭示資訊。',
    },
    {
      en: 'Seed at least one concrete clue or unanswered question. Maintain dramatic tension; end the chapter on an unresolved beat or a small reveal that reframes earlier events. Keep red herrings fair.',
      'zh-CN': '至少埋下一条具体线索或悬而未决的疑问。保持张力；章末停在未解的节点或一个能重新解读前文的小揭示上。误导要公平。',
      'zh-TW': '至少埋下一條具體線索或懸而未決的疑問。保持張力；章末停在未解的節點或一個能重新解讀前文的小揭示上。誤導要公平。',
    },
  ),
  buildPack(
    'romance',
    'genre_romance',
    { en: 'Romance', 'zh-CN': '言情', 'zh-TW': '言情' },
    {
      en: 'Emotion-forward romance centred on chemistry, longing, and interior feeling.',
      'zh-CN': '以情感为核心的言情，注重心动、张力与内心戏。',
      'zh-TW': '以情感為核心的言情，注重心動、張力與內心戲。',
    },
    {
      en: 'You are a professional romance novelist. You write emotionally rich prose that foregrounds feeling, chemistry, and interiority.',
      'zh-CN': '你是一位专业的言情小说家。你的文字情感饱满，突出感受、心动与内心活动。',
      'zh-TW': '你是一位專業的言情小說家。你的文字情感飽滿，突出感受、心動與內心活動。',
    },
    {
      en: 'Foreground the emotional beat of the relationship — attraction, tension, vulnerability, or a turning point in intimacy. Use subtext in dialogue and close interiority. Let the romantic throughline drive the scene, not just plot logistics.',
      'zh-CN': '突出关系中的情感节拍——吸引、张力、脆弱或亲密关系的转折。对白多用潜台词，贴近内心。让情感主线驱动场景，而非只是推进情节。',
      'zh-TW': '突出關係中的情感節拍——吸引、張力、脆弱或親密關係的轉折。對白多用潛台詞，貼近內心。讓情感主線驅動場景，而非只是推進情節。',
    },
  ),
  buildPack(
    'fantasy',
    'genre_fantasy',
    { en: 'Fantasy', 'zh-CN': '奇幻', 'zh-TW': '奇幻' },
    {
      en: 'Immersive secondary-world fantasy with consistent magic and lived-in worldbuilding.',
      'zh-CN': '沉浸式架空奇幻，魔法体系自洽、世界观有质感。',
      'zh-TW': '沉浸式架空奇幻，魔法體系自洽、世界觀有質感。',
    },
    {
      en: 'You are a professional fantasy novelist. You write immersive prose grounded in consistent worldbuilding and internal magical logic.',
      'zh-CN': '你是一位专业的奇幻小说家。你的文字沉浸感强，扎根于自洽的世界观与内在魔法逻辑。',
      'zh-TW': '你是一位專業的奇幻小說家。你的文字沉浸感強，扎根於自洽的世界觀與內在魔法邏輯。',
    },
    {
      en: 'Render the world with sensory specificity (sights, customs, magic in use) without info-dumping. Keep magical rules consistent with established facts. Let wonder and stakes coexist; never break the internal logic for convenience.',
      'zh-CN': '用感官细节（景物、习俗、施法过程）呈现世界，但不要堆设定。魔法规则须与既有设定一致。让奇观与risk并存；绝不为方便而打破内在逻辑。',
      'zh-TW': '用感官細節（景物、習俗、施法過程）呈現世界，但不要堆設定。魔法規則須與既有設定一致。讓奇觀與張力並存；絕不為方便而打破內在邏輯。',
    },
  ),
  buildPack(
    'webnovel',
    'genre_webnovel',
    { en: 'Web Novel', 'zh-CN': '网文', 'zh-TW': '網文' },
    {
      en: 'Fast-paced web-serial voice with frequent hooks, payoffs, and chapter-end cliffhangers.',
      'zh-CN': '快节奏网文笔法，钩子密集、爽点频繁、章末留扣。',
      'zh-TW': '快節奏網文筆法，鉤子密集、爽點頻繁、章末留扣。',
    },
    {
      en: 'You are a professional web-serial novelist. You write fast, hooky, reader-retention-driven prose tuned for episodic online release.',
      'zh-CN': '你是一位专业的网络连载作家。你的文字节奏快、钩子强，为线上连载的读者留存而优化。',
      'zh-TW': '你是一位專業的網路連載作家。你的文字節奏快、鉤子強，為線上連載的讀者留存而最佳化。',
    },
    {
      en: 'Keep the pace brisk and the hook density high. Deliver a clear payoff or escalation within the chapter and end on a cliffhanger or a strong forward pull. Favour momentum over lingering description.',
      'zh-CN': '保持快节奏与高钩子密度。本章内给出明确爽点或升级，章末以悬念或强烈的向前牵引收束。重动力，轻冗长描写。',
      'zh-TW': '保持快節奏與高鉤子密度。本章內給出明確爽點或升級，章末以懸念或強烈的向前牽引收束。重動力，輕冗長描寫。',
    },
  ),
];

export function listGenrePacks(): GenrePack[] {
  return GENRE_PACKS;
}

export function getGenrePack(packId: string): GenrePack | undefined {
  return GENRE_PACKS.find((p) => p.id === packId);
}

export interface ApplyGenrePackResult {
  variant: string;
  inserted: number;
  versionedOver: boolean;
}

/**
 * Apply a genre pack to a novel: land the pack rows under its variant (if not
 * already present) and point `novels.settings.promptVariant` at it. INSERT-only
 * — re-applying versions the rows up rather than clobbering, and the seeded
 * default is never touched.
 */
export async function applyGenrePack(novelId: string, packId: string): Promise<ApplyGenrePackResult> {
  const pack = getGenrePack(packId);
  if (!pack) throw new Error(`Unknown genre pack: ${packId}`);

  const novel = await getNovel(novelId);
  if (!novel) throw new Error('Novel not found');

  const doc: VariantPack = {
    formatVersion: 1,
    variant: pack.variant,
    label: pack.label.en,
    rows: pack.rows,
  };
  const result = importVariantPack(doc);

  const settings = { ...(novel.settings ?? {}), promptVariant: pack.variant };
  await updateNovel(novelId, { settings });

  return { variant: result.variant, inserted: result.inserted, versionedOver: result.versionedOver };
}
