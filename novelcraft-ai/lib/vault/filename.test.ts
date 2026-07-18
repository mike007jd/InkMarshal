import { describe, expect, it } from 'vitest';
import { slugifyForFs, uniqueFilename } from '@/lib/vault/filename';

describe('vault/filename: slugifyForFs', () => {
  it('replaces unsafe characters with dashes', () => {
    expect(slugifyForFs('hello: world?')).toBe('hello-world');
    expect(slugifyForFs('a / b \\ c')).toBe('a-b-c');
  });

  it('preserves CJK characters', () => {
    expect(slugifyForFs('林深 是 主角')).toBe('林深-是-主角');
  });

  it('falls back to untitled for empty / whitespace input', () => {
    expect(slugifyForFs('')).toBe('untitled');
    expect(slugifyForFs('   ')).toBe('untitled');
    expect(slugifyForFs('***')).toBe('untitled');
  });

  it('handles Windows reserved device names', () => {
    expect(slugifyForFs('CON')).toBe('CON-entry');
    expect(slugifyForFs('com1')).toBe('com1-entry');
  });

  it('truncates oversized titles', () => {
    const long = 'a'.repeat(500);
    const slug = slugifyForFs(long);
    expect(slug.length).toBeLessThanOrEqual(120);
  });

  it('trims leading and trailing dashes / dots', () => {
    expect(slugifyForFs('  .hidden.  ')).toBe('hidden');
  });
});

describe('vault/filename: uniqueFilename', () => {
  it('returns the bare slug when no collision exists', () => {
    expect(uniqueFilename('lin-shen', 'md', new Set())).toBe('lin-shen.md');
  });

  it('appends -2, -3 on collisions', () => {
    const taken = new Set(['lin-shen.md', 'lin-shen-2.md']);
    expect(uniqueFilename('lin-shen', 'md', taken)).toBe('lin-shen-3.md');
  });

  it('respects the ext parameter with or without leading dot', () => {
    expect(uniqueFilename('a', '.md', new Set())).toBe('a.md');
    expect(uniqueFilename('a', 'md', new Set())).toBe('a.md');
  });
});
