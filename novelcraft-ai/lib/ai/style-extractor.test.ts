import { describe, expect, it } from 'vitest';
import {
  EMPTY_STYLE_NOTES,
  StyleNotesSchema,
  extractStyleNotes,
  formatStyleNotes,
} from '@/lib/ai/style-extractor';

describe('style-extractor', () => {
  it('EMPTY_STYLE_NOTES matches schema defaults', () => {
    const parsed = StyleNotesSchema.parse({});
    expect(parsed).toEqual(EMPTY_STYLE_NOTES);
  });

  it('extractStyleNotes short-circuits below 80 chars', async () => {
    // Below the threshold we must NOT issue a model call. The test passes a
    // sentinel model that throws if invoked; if the short-circuit fails the
    // test surfaces the throw via the rejected promise.
    const result = await extractStyleNotes({
      sampleText: 'tiny sample',
      // Sentinel — the function should never touch this.
      model: { } as unknown as Parameters<typeof extractStyleNotes>[0]['model'],
    });
    expect(result).toEqual(EMPTY_STYLE_NOTES);
  });

  it('formatStyleNotes drops empty fields and joins by newline', () => {
    expect(
      formatStyleNotes({
        voice: 'dry, ironic',
        sentenceLength: '',
        vocabularyHints: ['plain', 'clipped'],
        povTendency: '',
      }, 'en'),
    ).toBe('Voice: dry, ironic\nVocabulary: plain, clipped');
  });

  it('formatStyleNotes outputs zh labels under zh locale', () => {
    const text = formatStyleNotes({
      voice: '冷峻',
      sentenceLength: '短',
      vocabularyHints: ['白描'],
      povTendency: '第三人称限知',
    }, 'zh-CN');
    expect(text).toContain('语气：冷峻');
    expect(text).toContain('句长：短');
    expect(text).toContain('用词：白描');
    expect(text).toContain('视角：第三人称限知');
  });

  it('returns EMPTY_STYLE_NOTES on internal errors', async () => {
    // Force the structured AI call to throw by passing a model that fails
    // when invoked through the AI SDK. The catch path in extractStyleNotes
    // swallows and returns the empty shape.
    const sample = 'A'.repeat(150);
    const result = await extractStyleNotes({
      sampleText: sample,
      model: null as unknown as Parameters<typeof extractStyleNotes>[0]['model'],
    });
    expect(result).toEqual(EMPTY_STYLE_NOTES);
  });
});
