import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// Mock the AI SDK so we can read back the exact `temperature` each structured
// call resolves to, without hitting a provider.
const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  Output: { object: vi.fn((config: unknown) => ({ type: 'object-output', config })) },
}));

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  Output: aiMocks.Output,
}));

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  // The chapter-quality primitives resolve prompt templates via SQLite; point
  // it at a throwaway dir so getPromptTemplate falls back cleanly.
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-structured-temp-'));
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
  aiMocks.generateText.mockResolvedValue({ output: { ok: true }, usage: {} });
});

const lastTemperature = () =>
  (aiMocks.generateText.mock.calls.at(-1)?.[0] as { temperature?: number }).temperature;

describe('generateStructuredObject temperature resolution', () => {
  const schema = z.object({ ok: z.boolean() });

  it.each(['outline', 'summarize', 'validate', 'unify'] as const)(
    'defaults operation %s to its conservative creativity preset (0.5)',
    async (operation) => {
      const { generateStructuredObject } = await import('@/lib/ai/structured-output');
      const { OPERATION_DEFAULT_CREATIVITY, CREATIVITY_PRESETS } = await import(
        '@/lib/ai/generation-presets'
      );
      await generateStructuredObject({ model: {} as never, schema, prompt: 'x', operation });
      const expected = CREATIVITY_PRESETS[OPERATION_DEFAULT_CREATIVITY[operation]].temperature;
      expect(lastTemperature()).toBe(expected);
      expect(lastTemperature()).toBe(0.5);
    },
  );

  it('honours a creativity override when one is supplied', async () => {
    const { generateStructuredObject } = await import('@/lib/ai/structured-output');
    const { CREATIVITY_PRESETS } = await import('@/lib/ai/generation-presets');
    await generateStructuredObject({
      model: {} as never,
      schema,
      prompt: 'x',
      operation: 'summarize',
      creativity: 'wild',
    });
    expect(lastTemperature()).toBe(CREATIVITY_PRESETS.wild.temperature);
  });

  it('lets an explicit temperature win over the operation preset', async () => {
    const { generateStructuredObject } = await import('@/lib/ai/structured-output');
    await generateStructuredObject({
      model: {} as never,
      schema,
      prompt: 'x',
      operation: 'summarize',
      temperature: 0.3,
    });
    expect(lastTemperature()).toBe(0.3);
  });

  it('leaves temperature undefined when neither operation nor temperature is given', async () => {
    const { generateStructuredObject } = await import('@/lib/ai/structured-output');
    await generateStructuredObject({ model: {} as never, schema, prompt: 'x' });
    expect(lastTemperature()).toBeUndefined();
  });
});

describe('structured AI primitives bind their creativity preset', () => {
  it('summarizeChapter runs at the conservative preset (was provider default ~1.0)', async () => {
    const { summarizeChapter } = await import('@/lib/ai/chapter-quality');
    aiMocks.generateText.mockResolvedValueOnce({
      output: { summary: 's', keyFacts: [] },
      usage: {},
    });
    await summarizeChapter({
      model: {} as never,
      chapterContent: 'prose',
      chapterTitle: 'C1',
      blueprint: { chapterNumber: 1, title: 'C1', summary: 'beat' },
    });
    expect(lastTemperature()).toBe(0.5);
  });

  it('validateChapter runs at the conservative preset', async () => {
    const { validateChapter } = await import('@/lib/ai/chapter-quality');
    aiMocks.generateText.mockResolvedValueOnce({
      output: { issues: [], overallScore: 100 },
      usage: {},
    });
    await validateChapter({
      model: {} as never,
      chapterContent: 'prose',
      chapterTitle: 'C1',
    });
    expect(lastTemperature()).toBe(0.5);
  });

  it('generateBookBlueprint runs at the conservative preset', async () => {
    const { generateBookBlueprint } = await import('@/lib/ai/chapter-generator');
    aiMocks.generateText.mockResolvedValueOnce({
      output: { chapters: [{ chapterNumber: 1, title: 'C1', summary: 'beat' }] },
      usage: {},
    });
    await generateBookBlueprint({
      model: {} as never,
      novelContext: { title: 'T', genre: 'G', targetWords: 80_000 },
    });
    expect(lastTemperature()).toBe(0.5);
  });
});
