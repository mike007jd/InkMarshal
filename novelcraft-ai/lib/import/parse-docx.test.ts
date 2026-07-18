// S10a regression: parseDocx's raw-text fallback must trigger not only when the
// HTML walk yields ZERO blocks, but also when it captures materially less prose
// than the raw text. Before the fix the regex tokenizer silently dropped
// paragraphs on malformed mammoth output (unclosed <p>, stray <), and the
// fallback only fired when blocks.length === 0 — so a partially-broken docx
// that yielded SOME blocks but lost others imported incomplete with no warning.

import { describe, expect, it, vi } from 'vitest';

describe('parseDocx — S10a raw-text fallback on under-capture', () => {
  it('falls back to raw text when the HTML walk captures materially less prose', async () => {
    // mammoth.convertToHtml returns HTML where one paragraph is wrapped in a
    // <div> — the regex tokenizer only matches h1-6/p/li, so the <div>-wrapped
    // paragraph is silently dropped. The old guard (blocks.length === 0) did not
    // fire because the <p> block was still captured, so ~half the prose was
    // lost with no warning. extractRawText returns the full text.
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn(async () => ({
          value: '<p>First captured paragraph here.</p><div>This div-wrapped paragraph is dropped by the regex tokenizer.</div>',
          messages: [],
        })),
        extractRawText: vi.fn(async () => ({
          value: 'First captured paragraph here.\n\nThis div-wrapped paragraph is dropped by the regex tokenizer.',
          messages: [],
        })),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    const doc = await parseDocx(Buffer.from('stub'), 'manuscript.docx');
    const allText = doc.blocks.map(b => b.text).join('\n');
    // The raw fallback captured BOTH paragraphs (the dropped div-wrapped one too).
    expect(allText).toContain('First captured paragraph here.');
    expect(allText).toContain('This div-wrapped paragraph is dropped by the regex tokenizer.');
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);

    vi.doUnmock('mammoth');
    vi.resetModules();
  });

  it('keeps the HTML walk when it captures essentially all the prose', async () => {
    // Well-formed HTML capturing everything — no fallback, heading inference
    // and bold-title detection survive.
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn(async () => ({
          value: '<h1>Title</h1><p>First paragraph here.</p><p>Second paragraph here.</p>',
          messages: [],
        })),
        extractRawText: vi.fn(async () => ({
          value: 'Title\n\nFirst paragraph here.\n\nSecond paragraph here.',
          messages: [],
        })),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    const doc = await parseDocx(Buffer.from('stub'), 'manuscript.docx');
    // The HTML walk kept the heading structure (not flattened to paragraphs).
    expect(doc.blocks.some(b => b.kind === 'heading' && b.text === 'Title')).toBe(true);
    expect(doc.blocks.some(b => b.kind === 'paragraph' && b.text === 'First paragraph here.')).toBe(true);

    vi.doUnmock('mammoth');
    vi.resetModules();
  });
});
