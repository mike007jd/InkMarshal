import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  Output: { object: vi.fn((config: unknown) => ({ type: 'object-output', config })) },
}));

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  Output: aiMocks.Output,
}));

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-ralph-budget-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  aiMocks.generateText.mockReset();
});

describe('Ralph revision output budget (CJK)', () => {
  it('sizes the revision cap by CJK character count, not a whitespace word split', async () => {
    const { reviseChapterForRalphLoop } = await import('@/lib/ai/chapter-quality');
    const { maxOutputTokensForWords } = await import('@/lib/ai/output-budget');

    // A 5000-character Chinese chapter has essentially no spaces. The old
    // whitespace split collapsed it to ~1 "word", clamping the cap to its 1024
    // floor and truncating the revision into a stub. countWords must drive it.
    const cjkChapter = '风'.repeat(5_000);
    aiMocks.generateText.mockResolvedValueOnce({ text: '修订后的章节', usage: {} });

    await reviseChapterForRalphLoop({
      model: {} as never,
      novelContext: { title: '测试', genre: '玄幻' },
      chapterContent: cjkChapter,
      chapterTitle: '第一章',
      blueprint: { chapterNumber: 1, title: '第一章', summary: '开篇' },
      revisionBrief: '修复连续性',
      language: 'zh-CN',
    });

    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
    const callArgs = aiMocks.generateText.mock.calls[0][0] as { maxOutputTokens: number };
    expect(callArgs.maxOutputTokens).toBe(maxOutputTokensForWords(5_000));
    // Hard guard against the regression: must be far above the 1024 floor.
    expect(callArgs.maxOutputTokens).toBeGreaterThan(4_000);
  });
});
