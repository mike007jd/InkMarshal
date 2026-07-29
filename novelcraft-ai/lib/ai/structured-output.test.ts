import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// Mock the AI SDK so we can read back the exact `temperature` each structured
// call resolves to, without hitting a provider.
const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  jsonSchema: vi.fn((
    schema: unknown | (() => unknown),
    options?: { validate?: (value: unknown) => unknown },
  ) => ({
    jsonSchema: typeof schema === 'function' ? schema() : schema,
    validate: options?.validate,
  })),
  Output: { object: vi.fn((config: unknown) => ({ type: 'object-output', config })) },
}));

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  jsonSchema: aiMocks.jsonSchema,
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

describe('grammar-safe structured schema transport', () => {
  it('strips nested maxLength/maxItems from the wire but preserves Zod validation', async () => {
    const { grammarSafeStructuredSchema } = await import('@/lib/ai/structured-output');
    const schema = z.object({
      edits: z.array(z.object({
        original: z.string().max(20_000),
        replacement: z.string().max(20_000),
      })).max(1_000),
      summary: z.string().max(4_000),
    });

    const safe = grammarSafeStructuredSchema(schema);
    const wire = await safe.jsonSchema;
    expect(JSON.stringify(wire)).not.toContain('maxLength');
    expect(JSON.stringify(wire)).not.toContain('maxItems');
    expect(wire).toMatchObject({
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
          },
        },
      },
    });

    expect(await safe.validate?.({
      edits: [{ original: 'x'.repeat(20_001), replacement: 'ok' }],
      summary: 'ok',
    })).toMatchObject({ success: false });
    expect(await safe.validate?.({
      edits: [{ original: 'old', replacement: 'new' }],
      summary: 'ok',
    })).toEqual({
      success: true,
      value: {
        edits: [{ original: 'old', replacement: 'new' }],
        summary: 'ok',
      },
    });
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
