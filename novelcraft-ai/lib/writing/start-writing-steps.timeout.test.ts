import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  summarizeChapter: vi.fn(),
  validateChapter: vi.fn(),
  summarizeVolume: vi.fn(),
  reviseChapterForRalphLoop: vi.fn(),
  usage: {
    model: {},
    runtimeModel: { id: 'qa-model' },
    addPromptText: vi.fn(),
    addPartialOutput: vi.fn(),
    recordUsage: vi.fn(),
    fail: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock('@/lib/ai', () => ({
  summarizeChapter: mocks.summarizeChapter,
  validateChapter: mocks.validateChapter,
  summarizeVolume: mocks.summarizeVolume,
  reviseChapterForRalphLoop: mocks.reviseChapterForRalphLoop,
  generateBookBlueprint: vi.fn(),
  getTargetWordsPerChapter: vi.fn(),
}));
vi.mock('@/lib/ai-usage', () => ({
  createAIUsageSession: vi.fn(async () => mocks.usage),
}));
vi.mock('@/lib/db', () => ({
  appendVolumeSummary: vi.fn(),
  getNovelBlueprint: vi.fn(),
  getVolumeSummaries: vi.fn(async () => []),
  setNovelBlueprint: vi.fn(),
}));

function rejectWhenAborted(signal: AbortSignal | undefined) {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

const base = {
  request: new Request('http://localhost'),
  userId: 'local-user',
  chapterContent: 'A complete saved chapter.',
  chapterTitle: 'Chapter One',
  language: 'en' as const,
  systemPrompt: 'system',
  chapterNumber: 1,
  log: vi.fn(),
  postGenerationTimeoutMs: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usage.recordUsage.mockResolvedValue(undefined);
  mocks.usage.fail.mockResolvedValue(undefined);
  mocks.usage.cancel.mockResolvedValue(undefined);
});

describe('post-generation timeout fallback', () => {
  it('fails a hung summary usage instead of blocking chapter finalization forever', async () => {
    mocks.summarizeChapter.mockImplementation(({ signal }: { signal?: AbortSignal }) => rejectWhenAborted(signal));
    const { runSummarize } = await import('@/lib/writing/start-writing-steps');

    await expect(runSummarize({
      ...base,
      plan: { chapterNumber: 1, title: 'Chapter One', summary: 'plan' },
    })).rejects.toBeDefined();
    expect(mocks.usage.fail).toHaveBeenCalledOnce();
    expect(mocks.usage.cancel).not.toHaveBeenCalled();
  });

  it('fails a hung validation usage instead of blocking chapter finalization forever', async () => {
    mocks.validateChapter.mockImplementation(({ signal }: { signal?: AbortSignal }) => rejectWhenAborted(signal));
    const { runValidate } = await import('@/lib/writing/start-writing-steps');

    await expect(runValidate({
      ...base,
      knowledgeContext: '',
      previousFactsSummary: '',
      targetWords: 1000,
    })).rejects.toBeDefined();
    expect(mocks.usage.fail).toHaveBeenCalledOnce();
    expect(mocks.usage.cancel).not.toHaveBeenCalled();
  });
});
