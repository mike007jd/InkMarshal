import { describe, expect, it } from 'vitest';
import {
  buildExtractStub,
  ExtractedEntrySchema,
  extractEntryFromMessage,
} from '@/lib/ai/conversation-extract';

describe('conversation-extract / buildExtractStub', () => {
  it('truncates long content to 400 chars and defaults to character type', () => {
    const long = 'a'.repeat(800);
    const stub = buildExtractStub(long);
    expect(stub.type).toBe('character');
    expect(stub.summary.length).toBe(400);
    expect(stub.title).toBe('');
    expect(stub.suggestedRelations).toEqual([]);
  });

  it('honours an explicit targetType', () => {
    const stub = buildExtractStub('A world with floating islands.', 'world');
    expect(stub.type).toBe('world');
  });

  it('survives empty content', () => {
    const stub = buildExtractStub('');
    expect(stub.summary).toBe('');
    expect(stub.type).toBe('character');
  });
});

describe('conversation-extract / extractEntryFromMessage degradation', () => {
  it('short content (<8 chars) skips the model call and returns a stub', async () => {
    // Pass a placeholder model — should never be called for short inputs.
    const fakeModel = {} as unknown as Parameters<typeof extractEntryFromMessage>[0]['model'];
    const out = await extractEntryFromMessage({
      messageContent: 'short',
      model: fakeModel,
    });
    expect(out.title).toBe('');
    expect(out.summary).toBe('short');
    expect(out.type).toBe('character');
  });

  it('model throws → returns stub (no rejection)', async () => {
    // Real structured-output path: provide a model that always throws so the
    // try/catch in extractEntryFromMessage routes through buildExtractStub.
    const throwingModel = new Proxy({}, {
      get() {
        throw new Error('model unreachable');
      },
    }) as unknown as Parameters<typeof extractEntryFromMessage>[0]['model'];
    const longMsg = 'Long enough message to bypass the short-circuit branch.';
    const out = await extractEntryFromMessage({
      messageContent: longMsg,
      model: throwingModel,
      targetType: 'world',
    });
    expect(out.type).toBe('world');
    expect(out.summary).toContain('Long enough');
  });
});

describe('conversation-extract / ExtractedEntrySchema', () => {
  it('fills defaults for missing fields', () => {
    const parsed = ExtractedEntrySchema.parse({});
    expect(parsed.type).toBe('character');
    expect(parsed.title).toBe('');
    expect(parsed.summary).toBe('');
    expect(parsed.suggestedRelations).toEqual([]);
  });

  it('rejects unknown type values', () => {
    expect(() => ExtractedEntrySchema.parse({ type: 'mystery' })).toThrow();
  });

  it('accepts a structured relation', () => {
    const parsed = ExtractedEntrySchema.parse({
      suggestedRelations: [{ target: 'B', type: 'family', label: '兄弟' }],
    });
    expect(parsed.suggestedRelations[0].target).toBe('B');
    expect(parsed.suggestedRelations[0].type).toBe('family');
  });
});
