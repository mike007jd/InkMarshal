import { type Locale, isZhLocale } from '@/lib/i18n';
import { normalizeInterviewFreeformInput } from '@/lib/interview-limits';
import type { InterviewStageName, InterviewState } from '@/lib/interview-state';

export interface InterviewContext {
  title: string;
  genre: string;
  targetWords: number;
  storySummary: string;
  characterSummary: string;
  arcSummary: string;
  stage: string;
}

interface BuildNextInterviewStateInput {
  currentState: InterviewState | null;
  selectedOptionId?: string | null;
  freeform?: string | null;
  language?: Locale;
}

export interface InterviewNovelDraft {
  genre: string;
  targetWords: number;
  storySummary: string;
  characterSummary: string;
  arcSummary: string;
}

type LocalizedText = Record<Locale, string>;

interface LocalizedOption {
  id: string;
  label: LocalizedText;
  description: LocalizedText;
}

interface SlotDefinitionLocalized {
  stage: InterviewStageName;
  question: LocalizedText;
  helperText: LocalizedText;
  options: LocalizedOption[];
  allowSkip?: boolean;
  condition?: (profile: Record<string, string>) => boolean;
}

interface SlotDefinition {
  stage: InterviewStageName;
  question: string;
  helperText: string;
  options: Array<{ id: string; label: string; description: string }>;
  allowSkip?: boolean;
  condition?: (profile: Record<string, string>) => boolean;
}

export const INTERVIEW_SLOT_ORDER = [
  'readiness',
  'length',
  'genre',
  'reference',
  'pov',
  'setting',
  'protagonist',
  'relationship',
  'worldbuilding',
  'conflict',
  'ending',
  'readerFeeling',
] as const;

export type InterviewSlotName = (typeof INTERVIEW_SLOT_ORDER)[number];

const INTERVIEW_SLOT_DEFINITIONS_BILINGUAL: Record<InterviewSlotName, SlotDefinitionLocalized> = {
  readiness: {
    stage: 'icebreaker',
    question: { 'en': 'How much have you thought about this story?', 'zh-CN': '你对这个故事已经想了多少？', 'zh-TW': '你對這個故事已經想了多少？' },
    helperText: { 'en': 'This helps me decide how to guide you next.', 'zh-CN': '这会帮我决定接下来怎么引导你。', 'zh-TW': '這會幫我決定接下來怎麼引導你。' },
    options: [
      { id: 'readiness-complete', label: { 'en': 'I have a complete concept', 'zh-CN': '我已经有完整构思', 'zh-TW': '我已經有完整構思' }, description: { 'en': 'I have a complete concept', 'zh-CN': '我已经有完整构思', 'zh-TW': '我已經有完整構思' } },
      { id: 'readiness-vague', label: { 'en': 'I have a vague idea', 'zh-CN': '有模糊的灵感', 'zh-TW': '有模糊的靈感' }, description: { 'en': 'I have a vague idea', 'zh-CN': '有模糊的灵感', 'zh-TW': '有模糊的靈感' } },
      { id: 'readiness-blank', label: { 'en': 'No ideas yet, help me', 'zh-CN': '完全没想法，请帮我', 'zh-TW': '完全沒想法，請幫我' }, description: { 'en': 'No ideas yet, help me', 'zh-CN': '完全没想法，请帮我', 'zh-TW': '完全沒想法，請幫我' } },
    ],
  },
  length: {
    stage: 'framework',
    question: { 'en': 'How long do you plan to write?', 'zh-CN': '你打算写多长？', 'zh-TW': '你打算寫多長？' },
    helperText: { 'en': 'Length determines the complexity and number of characters.', 'zh-CN': '篇幅决定了故事的复杂度和角色数量。', 'zh-TW': '篇幅決定了故事的複雜度和角色數量。' },
    options: [
      { id: 'length-short', label: { 'en': 'Short (30-50k words, ~6-10 chapters)', 'zh-CN': '短篇（3-5万字，约6-10章）', 'zh-TW': '短篇（3-5萬字，約6-10章）' }, description: { 'en': 'Short (30-50k words, ~6-10 chapters)', 'zh-CN': '短篇（3-5万字，约6-10章）', 'zh-TW': '短篇（3-5萬字，約6-10章）' } },
      { id: 'length-medium', label: { 'en': 'Medium (80-150k words, ~16-30 chapters)', 'zh-CN': '中篇（8-15万字，约16-30章）', 'zh-TW': '中篇（8-15萬字，約16-30章）' }, description: { 'en': 'Medium (80-150k words, ~16-30 chapters)', 'zh-CN': '中篇（8-15万字，约16-30章）', 'zh-TW': '中篇（8-15萬字，約16-30章）' } },
      { id: 'length-long', label: { 'en': 'Long (200k+ words, ~30-50 chapters)', 'zh-CN': '长篇（20万字+，约30-50章）', 'zh-TW': '長篇（20萬字+，約30-50章）' }, description: { 'en': 'Long (200k+ words, ~30-50 chapters)', 'zh-CN': '长篇（20万字+，约30-50章）', 'zh-TW': '長篇（20萬字+，約30-50章）' } },
    ],
  },
  genre: {
    stage: 'framework',
    question: { 'en': 'What genre would you like to write?', 'zh-CN': '你想写什么题材？', 'zh-TW': '你想寫什麼題材？' },
    helperText: { 'en': 'Pick a genre first, then we\'ll shape characters and conflict.', 'zh-CN': '先定题材，后面再收人物和冲突。', 'zh-TW': '先定題材，後面再收人物和衝突。' },
    options: [
      { id: 'genre-suspense', label: { 'en': 'Mystery / Thriller', 'zh-CN': '悬疑', 'zh-TW': '懸疑' }, description: { 'en': 'Mystery / Thriller', 'zh-CN': '悬疑', 'zh-TW': '懸疑' } },
      { id: 'genre-fantasy', label: { 'en': 'Fantasy', 'zh-CN': '奇幻', 'zh-TW': '奇幻' }, description: { 'en': 'Fantasy', 'zh-CN': '奇幻', 'zh-TW': '奇幻' } },
      { id: 'genre-romance', label: { 'en': 'Romance', 'zh-CN': '言情', 'zh-TW': '言情' }, description: { 'en': 'Romance', 'zh-CN': '言情', 'zh-TW': '言情' } },
      { id: 'genre-scifi', label: { 'en': 'Sci-Fi', 'zh-CN': '科幻', 'zh-TW': '科幻' }, description: { 'en': 'Sci-Fi', 'zh-CN': '科幻', 'zh-TW': '科幻' } },
      { id: 'genre-historical', label: { 'en': 'Historical', 'zh-CN': '历史', 'zh-TW': '歷史' }, description: { 'en': 'Historical', 'zh-CN': '历史', 'zh-TW': '歷史' } },
      { id: 'genre-realism', label: { 'en': 'Realism', 'zh-CN': '现实主义', 'zh-TW': '現實主義' }, description: { 'en': 'Realism', 'zh-CN': '现实主义', 'zh-TW': '現實主義' } },
    ],
  },
  reference: {
    stage: 'framework',
    question: { 'en': 'Any similar works you enjoy? (Books, movies, shows)', 'zh-CN': '有没有你喜欢的类似作品？（小说、影视都行）', 'zh-TW': '有沒有你喜歡的類似作品？（小說、影視都行）' },
    helperText: { 'en': 'e.g. "the atmosphere of Gone Girl" — helps me understand your style faster. Feel free to skip.', 'zh-CN': '比如「像白夜行那样的氛围」，能帮我更快理解你想要的风格。可以跳过。', 'zh-TW': '比如「像白夜行那樣的氛圍」，能幫我更快理解你想要的風格。可以跳過。' },
    options: [],
    allowSkip: true,
  },
  pov: {
    stage: 'framework',
    question: { 'en': 'What narrative perspective would you like?', 'zh-CN': '你想用什么叙事视角？', 'zh-TW': '你想用什麼敘事視角？' },
    helperText: { 'en': 'Perspective shapes how readers experience the story.', 'zh-CN': '视角决定读者的代入方式。', 'zh-TW': '視角決定讀者的代入方式。' },
    options: [
      { id: 'pov-first', label: { 'en': 'First person', 'zh-CN': '第一人称', 'zh-TW': '第一人稱' }, description: { 'en': 'First person', 'zh-CN': '第一人称', 'zh-TW': '第一人稱' } },
      { id: 'pov-third', label: { 'en': 'Third person', 'zh-CN': '第三人称', 'zh-TW': '第三人稱' }, description: { 'en': 'Third person', 'zh-CN': '第三人称', 'zh-TW': '第三人稱' } },
      { id: 'pov-multi', label: { 'en': 'Multiple POV', 'zh-CN': '多视角', 'zh-TW': '多視角' }, description: { 'en': 'Multiple POV', 'zh-CN': '多视角', 'zh-TW': '多視角' } },
    ],
  },
  setting: {
    stage: 'world_and_characters',
    question: { 'en': 'When and where does the story take place?', 'zh-CN': '故事发生在什么时代和地点？', 'zh-TW': '故事發生在什麼時代和地點？' },
    helperText: { 'en': 'e.g. "a small southern town in the 1990s" or "a fictional medieval kingdom".', 'zh-CN': '比如「1990年代的南方小城」或「架空的中世纪王国」。', 'zh-TW': '比如「1990年代的南方小城」或「架空的中世紀王國」。' },
    options: [],
  },
  protagonist: {
    stage: 'world_and_characters',
    question: { 'en': 'Who is your protagonist? Name, role, personality?', 'zh-CN': '主角是谁？叫什么名字、什么身份、什么性格？', 'zh-TW': '主角是誰？叫什麼名字、什麼身份、什麼性格？' },
    helperText: { 'en': 'The more specific the better. e.g. "Jack, 45, retired detective, quiet but incredibly observant".', 'zh-CN': '越具体越好。比如「林深，45岁退休刑警，沉默寡言但观察力极强」。', 'zh-TW': '越具體越好。比如「林深，45歲退休刑警，沉默寡言但觀察力極強」。' },
    options: [],
  },
  relationship: {
    stage: 'world_and_characters',
    question: { 'en': 'Who is the most important person in the protagonist\'s life?', 'zh-CN': '跟主角关系最重要的人是谁？', 'zh-TW': '跟主角關係最重要的人是誰？' },
    helperText: { 'en': 'Could be a rival, lover, partner, mentor — the more tension, the better the story.', 'zh-CN': '可以是对手、爱人、伙伴、导师——关系越有张力，故事越有戏。', 'zh-TW': '可以是對手、愛人、夥伴、導師——關係越有張力，故事越有戲。' },
    options: [],
  },
  worldbuilding: {
    stage: 'world_and_characters',
    question: { 'en': 'Any special world-building? (Magic systems, tech level, etc.)', 'zh-CN': '这个世界有什么特殊设定？（魔法体系、科技水平等）', 'zh-TW': '這個世界有什麼特殊設定？（魔法體系、科技水平等）' },
    helperText: { 'en': 'e.g. "magic costs lifespan" or "AI has replaced most jobs".', 'zh-CN': '比如「魔法需要消耗寿命」或「AI已经取代了大部分职业」。', 'zh-TW': '比如「魔法需要消耗壽命」或「AI已經取代了大部分職業」。' },
    options: [],
    // Always offered (and skippable). The previous `condition` gated this slot
    // on the genre *label* containing 奇幻/科幻/Fantasy/Sci-Fi, so a freeform
    // genre answer ("赛博朋克", "魔幻现实") — exactly the genres that most need
    // world-building — silently never got the question. Showing it for every
    // genre with allowSkip is the honest fix; non-speculative novels just skip.
    allowSkip: true,
  },
  conflict: {
    stage: 'plot_and_tone',
    question: { 'en': 'What conflict should drive the story?', 'zh-CN': '你最想让故事围绕什么冲突展开？', 'zh-TW': '你最想讓故事圍繞什麼衝突展開？' },
    helperText: { 'en': 'Conflict is the engine of your book.', 'zh-CN': '冲突决定这本书的驱动力。', 'zh-TW': '衝突決定這本書的驅動力。' },
    options: [
      { id: 'conflict-secret', label: { 'en': 'Secrets & Truth', 'zh-CN': '秘密与真相', 'zh-TW': '秘密與真相' }, description: { 'en': 'Secrets & Truth', 'zh-CN': '秘密与真相', 'zh-TW': '秘密與真相' } },
      { id: 'conflict-survival', label: { 'en': 'Survival & Resistance', 'zh-CN': '生存与对抗', 'zh-TW': '生存與對抗' }, description: { 'en': 'Survival & Resistance', 'zh-CN': '生存与对抗', 'zh-TW': '生存與對抗' } },
      { id: 'conflict-relationship', label: { 'en': 'Relationship Tension', 'zh-CN': '关系撕扯', 'zh-TW': '關係撕扯' }, description: { 'en': 'Relationship Tension', 'zh-CN': '关系撕扯', 'zh-TW': '關係撕扯' } },
    ],
  },
  ending: {
    stage: 'plot_and_tone',
    question: { 'en': 'What kind of ending do you envision?', 'zh-CN': '你希望什么样的结局？', 'zh-TW': '你希望什麼樣的結局？' },
    helperText: { 'en': 'The ending shapes the overall direction of the story.', 'zh-CN': '结局倾向会影响整体的故事走向。', 'zh-TW': '結局傾向會影響整體的故事走向。' },
    options: [
      { id: 'ending-he', label: { 'en': 'Happy Ending (HE)', 'zh-CN': '圆满结局 (HE)', 'zh-TW': '圓滿結局 (HE)' }, description: { 'en': 'Happy Ending (HE)', 'zh-CN': '圆满结局 (HE)', 'zh-TW': '圓滿結局 (HE)' } },
      { id: 'ending-be', label: { 'en': 'Tragic Ending (BE)', 'zh-CN': '悲剧结局 (BE)', 'zh-TW': '悲劇結局 (BE)' }, description: { 'en': 'Tragic Ending (BE)', 'zh-CN': '悲剧结局 (BE)', 'zh-TW': '悲劇結局 (BE)' } },
      { id: 'ending-open', label: { 'en': 'Open Ending', 'zh-CN': '开放式结局', 'zh-TW': '開放式結局' }, description: { 'en': 'Open Ending', 'zh-CN': '开放式结局', 'zh-TW': '開放式結局' } },
    ],
  },
  readerFeeling: {
    stage: 'plot_and_tone',
    question: { 'en': 'How do you want the reader to feel after finishing?', 'zh-CN': '你最希望读者读完是什么感受？', 'zh-TW': '你最希望讀者讀完是什麼感受？' },
    helperText: { 'en': 'e.g. "haunted for days" or "eager to re-read from page one".', 'zh-CN': '比如「让人久久不能平静」或「看完想马上翻回第一页」。', 'zh-TW': '比如「讓人久久不能平靜」或「看完想馬上翻回第一頁」。' },
    options: [],
  },
};

function resolveSlotDefinition(slot: InterviewSlotName, lang: Locale): SlotDefinition {
  const def = INTERVIEW_SLOT_DEFINITIONS_BILINGUAL[slot];
  return {
    stage: def.stage,
    question: def.question[lang],
    helperText: def.helperText[lang],
    options: def.options.map(o => ({ id: o.id, label: o.label[lang], description: o.description[lang] })),
    allowSkip: def.allowSkip,
    condition: def.condition,
  };
}

/**
 * Get the list of effective slots after applying conditions.
 */
function getEffectiveSlots(profile: Record<string, string>): InterviewSlotName[] {
  return INTERVIEW_SLOT_ORDER.filter((slot) => {
    const def = INTERVIEW_SLOT_DEFINITIONS_BILINGUAL[slot];
    if (def.condition) {
      return def.condition(profile);
    }
    return true;
  });
}

/**
 * Get remaining (unanswered) slots from the effective slot list.
 * A slot is considered answered if the profile has a key for it (even empty string for skipped slots).
 */
function getRemainingSlots(profile: Record<string, string>): InterviewSlotName[] {
  return getEffectiveSlots(profile).filter((slot) => !(slot in profile));
}

function buildInterviewStateForSlot(
  slot: InterviewSlotName,
  collectedProfile: Record<string, string>,
  proposalVersion: number,
  lang: Locale = 'zh-CN',
): InterviewState {
  const definition = resolveSlotDefinition(slot, lang);
  const effectiveSlots = getEffectiveSlots(collectedProfile);
  const slotIndex = effectiveSlots.indexOf(slot);
  const missingFields = getRemainingSlots(collectedProfile);

  return {
    mode: 'interview',
    currentQuestionId: slot,
    currentQuestion: definition.question,
    currentHelperText: definition.helperText,
    currentOptions: definition.options.map((option) => ({ ...option })),
    recommendedOptionId: definition.options[0]?.id ?? null,
    slotTarget: slot,
    missingFields,
    collectedProfile,
    proposalSummary: null,
    proposalVersion,
    interviewStage: definition.stage,
    stageProgress: { current: slotIndex + 1, total: effectiveSlots.length },
  };
}

export function buildInitialInterviewState(lang: Locale = 'zh-CN'): InterviewState {
  return buildInterviewStateForSlot('readiness', {}, 0, lang);
}

export function buildNextInterviewState(
  input: BuildNextInterviewStateInput,
): InterviewState {
  const lang = input.language ?? 'zh-CN';
  const currentState = input.currentState;
  const nextProfile: Record<string, string> = {
    ...(currentState?.collectedProfile ?? {}),
  };
  const currentSlot = currentState?.slotTarget as InterviewSlotName | null | undefined;

  if (currentState && currentSlot) {
    const definition = resolveSlotDefinition(currentSlot, lang);
    const selectedLabel = input.selectedOptionId
      ? currentState.currentOptions.find(
          (option) => option.id === input.selectedOptionId,
        )?.label
      : undefined;
    const freeformText = normalizeInterviewFreeformInput(input.freeform) ?? undefined;

    // Combine option label and freeform if both present
    const separator = isZhLocale(lang) ? '，' : ', ';
    const answerText = [selectedLabel, freeformText].filter(Boolean).join(separator);

    if (answerText) {
      nextProfile[currentSlot] = answerText;
    } else if (definition.allowSkip) {
      // Skip: no option, empty freeform on allowSkip slot
      nextProfile[currentSlot] = '';
    }
  }

  const remainingSlots = getRemainingSlots(nextProfile);
  if (remainingSlots.length === 0) {
    const effectiveSlots = getEffectiveSlots(nextProfile);
    return {
      mode: 'proposal_review',
      currentQuestionId: null,
      currentQuestion: null,
      currentHelperText: null,
      currentOptions: [],
      recommendedOptionId: null,
      slotTarget: null,
      missingFields: [],
      collectedProfile: nextProfile,
      proposalSummary: buildProposalSummary(nextProfile, lang),
      proposalVersion: (currentState?.proposalVersion ?? 0) + 1,
      interviewStage: 'proposal_review' as const,
      stageProgress: { current: effectiveSlots.length, total: effectiveSlots.length },
    };
  }

  return buildInterviewStateForSlot(
    remainingSlots[0],
    nextProfile,
    currentState?.proposalVersion ?? 0,
    lang,
  );
}

/**
 * Coarse length classification. Drives chapter-recommendation copy, the novel's
 * target word count, and downstream prompt-budget decisions.
 *
 * Source of truth (in order): explicit option id (`length-short`/`length-medium`/
 * `length-long`) → keyword fallback on the resolved label (繁体 `長篇` and zh-CN
 * `长篇` both map to `long`). i18n-safe: when a translator renames the label,
 * the bucket still resolves because we keep all known synonyms here.
 */
export type LengthBucket = 'short' | 'medium' | 'long' | 'unspecified';

const LENGTH_BUCKET_KEYWORDS: Record<LengthBucket, readonly string[]> = {
  short: ['短篇', 'Short'],
  medium: ['中篇', 'Medium'],
  // Both Simplified `长篇` AND Traditional `長篇` must hit `long`. The previous
  // string-includes path only checked the Simplified form, which silently fell
  // through to `unspecified` (→ 80k words) for zh-TW users.
  long: ['长篇', '長篇', 'Long'],
  unspecified: [],
};

/**
 * Map an interview option id (preferred — set by InterviewComposer when the
 * user picks a length option) to its bucket. Returns `null` when the id isn't
 * a length slot so callers can fall through to label-based classification.
 */
export function bucketFromOptionId(optionId: string | null | undefined): LengthBucket | null {
  if (!optionId) return null;
  switch (optionId) {
    case 'length-short':
      return 'short';
    case 'length-medium':
      return 'medium';
    case 'length-long':
      return 'long';
    default:
      return null;
  }
}

/**
 * Classify a human-readable length label (or whatever the slot answer stored)
 * into a {@link LengthBucket}. Keyword-based, locale-insensitive, falls back
 * to `unspecified` for blanks or unknown values.
 */
export function classifyLength(label?: string | null): LengthBucket {
  if (!label) return 'unspecified';
  for (const bucket of ['short', 'medium', 'long'] as const) {
    if (LENGTH_BUCKET_KEYWORDS[bucket].some(kw => label.includes(kw))) {
      return bucket;
    }
  }
  return 'unspecified';
}

const CHAPTER_REC: Record<LengthBucket, { zh: string; en: string }> = {
  short: { zh: '建议6-10章', en: 'recommended 6-10 chapters' },
  medium: { zh: '建议16-30章', en: 'recommended 16-30 chapters' },
  long: { zh: '建议30-50章', en: 'recommended 30-50 chapters' },
  unspecified: { zh: '', en: '' },
};

const TARGET_WORDS: Record<LengthBucket, number> = {
  short: 40_000,
  medium: 100_000,
  long: 200_000,
  unspecified: 80_000,
};

function getChapterRecommendation(lengthLabel: string, lang: Locale): string {
  const bucket = classifyLength(lengthLabel);
  return CHAPTER_REC[bucket][isZhLocale(lang) ? 'zh' : 'en'];
}

const proposalLabels: Record<Locale, Record<string, string>> = {
  'zh-CN': {
    length: '篇幅规划', genre: '题材方向', reference: '参考风格', pov: '叙事视角',
    setting: '故事背景', protagonist: '主角', relationship: '核心关系',
    worldbuilding: '世界设定', conflict: '核心冲突', ending: '结局倾向', readerFeeling: '期望读感',
  },
  'zh-TW': {
    length: '篇幅規劃', genre: '題材方向', reference: '參考風格', pov: '敘事視角',
    setting: '故事背景', protagonist: '主角', relationship: '核心關係',
    worldbuilding: '世界設定', conflict: '核心衝突', ending: '結局傾向', readerFeeling: '期望讀感',
  },
  'en': {
    length: 'Length', genre: 'Genre', reference: 'Reference Style', pov: 'Narrative POV',
    setting: 'Setting', protagonist: 'Protagonist', relationship: 'Key Relationship',
    worldbuilding: 'World-building', conflict: 'Core Conflict', ending: 'Ending', readerFeeling: 'Desired Reader Feeling',
  },
};

function buildProposalSummary(collectedProfile: Record<string, string>, lang: Locale = 'zh-CN'): string {
  const lines: string[] = [];
  const l = proposalLabels[lang];
  const sep = isZhLocale(lang) ? '：' : ': ';

  const length = collectedProfile.length;
  if (length) {
    const chapterRec = getChapterRecommendation(length, lang);
    const comma = isZhLocale(lang) ? '，' : ', ';
    lines.push(`${l.length}${sep}${length}${chapterRec ? `${comma}${chapterRec}` : ''}`);
  }

  const fields: Array<[keyof typeof l, string]> = [
    ['genre', collectedProfile.genre],
    ['reference', collectedProfile.reference],
    ['pov', collectedProfile.pov],
    ['setting', collectedProfile.setting],
    ['protagonist', collectedProfile.protagonist],
    ['relationship', collectedProfile.relationship],
    ['worldbuilding', collectedProfile.worldbuilding],
    ['conflict', collectedProfile.conflict],
    ['ending', collectedProfile.ending],
    ['readerFeeling', collectedProfile.readerFeeling],
  ];

  for (const [key, value] of fields) {
    if (value) lines.push(`${l[key]}${sep}${value}`);
  }

  return lines.join('\n');
}

export function getTargetWordsFromInterviewLength(lengthLabel?: string): number {
  return TARGET_WORDS[classifyLength(lengthLabel)];
}

function joinNonEmpty(parts: Array<string | undefined>, separator: string): string {
  return parts.map(part => part?.trim()).filter(Boolean).join(separator);
}

function labeledProfileField(
  profile: Record<string, string>,
  key: string,
  labels: { zh: string; en: string },
  isZh: boolean,
): string | undefined {
  const value = profile[key];
  if (!value) return undefined;
  return isZh ? `${labels.zh}：${value}` : `${labels.en}: ${value}`;
}

export function buildNovelDraftFromInterviewProfile(
  collectedProfile: Record<string, string>,
  lang: Locale = 'zh-CN',
): InterviewNovelDraft {
  const isZh = isZhLocale(lang);
  const separator = isZh ? '；' : '; ';
  const targetWords = getTargetWordsFromInterviewLength(collectedProfile.length);
  const genre = collectedProfile.genre || '';

  const storySummary = joinNonEmpty([
    labeledProfileField(collectedProfile, 'setting', { zh: '故事背景', en: 'Setting' }, isZh),
    labeledProfileField(collectedProfile, 'worldbuilding', { zh: '世界设定', en: 'World-building' }, isZh),
    labeledProfileField(collectedProfile, 'conflict', { zh: '核心冲突', en: 'Core conflict' }, isZh),
    labeledProfileField(collectedProfile, 'reference', { zh: '参考风格', en: 'Reference style' }, isZh),
  ], separator);

  const characterSummary = joinNonEmpty([
    labeledProfileField(collectedProfile, 'protagonist', { zh: '主角', en: 'Protagonist' }, isZh),
    labeledProfileField(collectedProfile, 'relationship', { zh: '核心关系', en: 'Key relationship' }, isZh),
    labeledProfileField(collectedProfile, 'pov', { zh: '叙事视角', en: 'Point of view' }, isZh),
  ], separator);

  const conflictArc = collectedProfile.conflict
    ? isZh
      ? `故事围绕「${collectedProfile.conflict}」逐步升级`
      : `The story escalates around ${collectedProfile.conflict}`
    : undefined;
  const arcSummary = joinNonEmpty([
    conflictArc,
    labeledProfileField(collectedProfile, 'ending', { zh: '结局倾向', en: 'Ending direction' }, isZh),
    labeledProfileField(collectedProfile, 'readerFeeling', { zh: '期望读感', en: 'Desired reader feeling' }, isZh),
  ], separator);

  return {
    genre,
    targetWords,
    storySummary: storySummary || buildProposalSummary(collectedProfile, lang),
    characterSummary,
    arcSummary,
  };
}
