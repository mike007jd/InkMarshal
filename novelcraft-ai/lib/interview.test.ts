import { describe, expect, it } from 'vitest';

import {
  bucketFromOptionId,
  buildNextInterviewState,
  buildNovelDraftFromInterviewProfile,
  classifyLength,
  getTargetWordsFromInterviewLength,
} from '@/lib/interview';
import { INTERVIEW_FREEFORM_MAX_LENGTH, normalizeInterviewFreeformInput } from '@/lib/interview-limits';

describe('interview profile novel draft', () => {
  it('turns a completed long-form interview into usable novel fields', () => {
    const draft = buildNovelDraftFromInterviewProfile({
      length: '长篇（20万字+，约30-50章）',
      genre: '奇幻',
      pov: '第三人称',
      setting: '一座被潮汐魔法隔绝的海上王国',
      protagonist: '林岚，年轻制图师，害怕深海却必须出航',
      relationship: '她与失踪兄长留下的航海日志互相拉扯',
      worldbuilding: '每次施法都会交换一段记忆',
      conflict: '秘密与真相',
      ending: '开放式结局',
      readerFeeling: '读完后像听见远处的潮声',
    }, 'zh-CN');

    expect(draft.targetWords).toBe(200000);
    expect(draft.genre).toBe('奇幻');
    expect(draft.storySummary).toContain('海上王国');
    expect(draft.characterSummary).toContain('林岚');
    expect(draft.arcSummary).toContain('开放式结局');
  });
});

describe('interview length bucket (wave 4 commit G)', () => {
  it('classifyLength maps Simplified, Traditional, and English forms', () => {
    expect(classifyLength('短篇（3-5万字，约6-10章）')).toBe('short');
    expect(classifyLength('Short (30-50k words)')).toBe('short');
    expect(classifyLength('中篇（8-15万字）')).toBe('medium');
    expect(classifyLength('Medium')).toBe('medium');
    expect(classifyLength('长篇（20万字+）')).toBe('long');
    // Critical: 繁体 `長篇` previously fell through to 'unspecified'.
    expect(classifyLength('長篇（20萬字+）')).toBe('long');
    expect(classifyLength('Long (200k+)')).toBe('long');
    expect(classifyLength('')).toBe('unspecified');
    expect(classifyLength(undefined)).toBe('unspecified');
  });

  it('bucketFromOptionId resolves the canonical option ids', () => {
    expect(bucketFromOptionId('length-short')).toBe('short');
    expect(bucketFromOptionId('length-medium')).toBe('medium');
    expect(bucketFromOptionId('length-long')).toBe('long');
    expect(bucketFromOptionId('genre-fantasy')).toBeNull();
    expect(bucketFromOptionId(null)).toBeNull();
    expect(bucketFromOptionId(undefined)).toBeNull();
  });

  it('getTargetWordsFromInterviewLength reads the bucket table', () => {
    // Each bucket → its locked target. If these change, the proposal step's
    // word goals shift — re-review the UX, don't silently update.
    expect(getTargetWordsFromInterviewLength('短篇')).toBe(40_000);
    expect(getTargetWordsFromInterviewLength('Medium (80-150k)')).toBe(100_000);
    expect(getTargetWordsFromInterviewLength('長篇（20萬字+）')).toBe(200_000);
    expect(getTargetWordsFromInterviewLength(undefined)).toBe(80_000);
  });

  it('selecting length-short option leads to 40k target words after build', () => {
    // Drive the slot answer through buildNextInterviewState the way ChatArea
    // does, then read the target via the bucket table — covers the full path
    // option-id → stored label → bucket → target.
    // Initial state targeting the `length` slot.
    const initial = buildNextInterviewState({
      currentState: {
        mode: 'interview',
        currentQuestionId: 'length',
        currentQuestion: 'How long?',
        currentHelperText: null,
        currentOptions: [
          { id: 'length-short', label: 'Short (30-50k words, ~6-10 chapters)', description: '' },
          { id: 'length-medium', label: 'Medium (80-150k words, ~16-30 chapters)', description: '' },
          { id: 'length-long', label: 'Long (200k+ words, ~30-50 chapters)', description: '' },
        ],
        recommendedOptionId: 'length-short',
        slotTarget: 'length',
        missingFields: ['length'],
        collectedProfile: {},
        proposalSummary: null,
        proposalVersion: 0,
        interviewStage: 'framework',
        stageProgress: { current: 1, total: 1 },
      },
      selectedOptionId: 'length-short',
      language: 'en',
    });
    expect(initial.collectedProfile.length).toContain('Short');
    expect(getTargetWordsFromInterviewLength(initial.collectedProfile.length)).toBe(40_000);
  });
});

describe('interview freeform normalization', () => {
  it('trims, drops non-string values, and hard-caps persisted freeform answers', () => {
    expect(normalizeInterviewFreeformInput('  keep this  ')).toBe('keep this');
    expect(normalizeInterviewFreeformInput('   ')).toBeNull();
    expect(normalizeInterviewFreeformInput({ text: 'not allowed' })).toBeNull();
    expect(normalizeInterviewFreeformInput('x'.repeat(INTERVIEW_FREEFORM_MAX_LENGTH + 20))).toHaveLength(INTERVIEW_FREEFORM_MAX_LENGTH);
  });

  it('applies the same cap when advancing the interview profile', () => {
    const state = buildNextInterviewState({
      currentState: {
        mode: 'interview',
        currentQuestionId: 'setting',
        currentQuestion: 'Where?',
        currentHelperText: null,
        currentOptions: [],
        recommendedOptionId: null,
        slotTarget: 'setting',
        missingFields: ['setting'],
        collectedProfile: {},
        proposalSummary: null,
        proposalVersion: 0,
        interviewStage: 'world_and_characters',
        stageProgress: { current: 1, total: 1 },
      },
      freeform: 'x'.repeat(INTERVIEW_FREEFORM_MAX_LENGTH + 1),
      language: 'en',
    });

    expect(state.collectedProfile.setting).toHaveLength(INTERVIEW_FREEFORM_MAX_LENGTH);
  });
});
