import { describe, expect, it } from 'vitest';

import { sanitizeMarkdownHref } from '@/lib/markdown-url';

describe('sanitizeMarkdownHref', () => {
  it('accepts safe absolute and relative markdown links', () => {
    expect(sanitizeMarkdownHref(' https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1');
    expect(sanitizeMarkdownHref('mailto:support@example.com')).toBeNull();
    expect(sanitizeMarkdownHref('/novels/123')).toBe('/novels/123');
    expect(sanitizeMarkdownHref('#chapter-2')).toBe('#chapter-2');
    expect(sanitizeMarkdownHref('?tab=notes')).toBe('?tab=notes');
    expect(sanitizeMarkdownHref('chapter-notes')).toBe('chapter-notes');
  });

  it('rejects executable, opaque, protocol-relative, and malformed links', () => {
    expect(sanitizeMarkdownHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeMarkdownHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(sanitizeMarkdownHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeMarkdownHref('vbscript:msgbox(1)')).toBeNull();
    expect(sanitizeMarkdownHref('//evil.example/path')).toBeNull();
    expect(sanitizeMarkdownHref('\\\\evil.example\\share')).toBeNull();
    expect(sanitizeMarkdownHref('https://example.com/\u0000bad')).toBeNull();
    expect(sanitizeMarkdownHref('https://example.com/' + 'x'.repeat(2048))).toBeNull();
  });
});
