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
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-ai-abort-'));
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
  aiMocks.streamText.mockReset();
  aiMocks.Output.object.mockClear();
});

describe('AI structured-output abort propagation', () => {
  it('passes AbortSignal through book blueprint generation', async () => {
    const { generateBookBlueprint } = await import('@/lib/ai/chapter-generator');
    const controller = new AbortController();
    aiMocks.generateText.mockResolvedValueOnce({
      output: {
        chapters: Array.from({ length: 8 }, (_, index) => ({
          chapterNumber: index + 1,
          title: `Chapter ${index + 1}`,
          summary: 'summary',
        })),
      },
      usage: {},
    });

    await generateBookBlueprint({
      model: {} as never,
      novelContext: { targetWords: 40_000 },
      signal: controller.signal,
    });

    expect(aiMocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });

  it('passes AbortSignal through chapter post-generation object calls', async () => {
    const { summarizeChapter, validateChapter, summarizeVolume } = await import('@/lib/ai/chapter-quality');
    const controller = new AbortController();
    aiMocks.generateText
      .mockResolvedValueOnce({
        output: {
          summary: 'A concise digest of the chapter that exceeds the minimum length and gives a useful recap.',
          keyFacts: { characters: [], locations: [], items: [], plotMoves: ['A plot move'] },
        },
        usage: {},
      })
      .mockResolvedValueOnce({
        output: { consistencyIssues: [], overallScore: 95 },
        usage: {},
      })
      .mockResolvedValueOnce({
        output: { summary: 'A'.repeat(120) },
        usage: {},
      });

    await summarizeChapter({
      model: {} as never,
      chapterContent: 'chapter prose',
      chapterTitle: 'One',
      blueprint: { chapterNumber: 1, title: 'One', summary: 'planned events' },
      signal: controller.signal,
    });
    await validateChapter({
      model: {} as never,
      chapterContent: 'chapter prose',
      chapterTitle: 'One',
      signal: controller.signal,
    });
    await summarizeVolume({
      model: {} as never,
      chapters: [{ chapterNumber: 1, title: 'One', summary: 'chapter summary' }],
      signal: controller.signal,
    });

    expect(aiMocks.generateText).toHaveBeenCalledTimes(3);
    for (const call of aiMocks.generateText.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ abortSignal: controller.signal }));
    }
  });

  it('passes AbortSignal through greenlight pack generation', async () => {
    const { generateGreenlightPack } = await import('@/lib/ai/greenlight');
    const controller = new AbortController();
    aiMocks.generateText.mockResolvedValueOnce({
      output: {
        title: 'Draft',
        genre: 'fantasy',
        storySummary: 'story',
        characterSummary: 'characters',
        arcSummary: 'arc',
      },
      usage: {},
    });

    await generateGreenlightPack({
      model: {} as never,
      novelContext: { title: 'Draft' },
      history: [],
      signal: controller.signal,
    });

    expect(aiMocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal }),
    );
  });
});
