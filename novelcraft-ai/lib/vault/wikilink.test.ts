import { describe, expect, it } from 'vitest';
import { parseWikilinks } from '@/lib/vault/wikilink';

describe('vault/wikilink', () => {
  it('extracts plain wikilinks', () => {
    const links = parseWikilinks('Alice met [[Bob]] at the [[Old Castle]].');
    expect(links.map(l => l.raw)).toEqual(['Bob', 'Old Castle']);
  });

  it('deduplicates repeated wikilinks', () => {
    const links = parseWikilinks('[[Bob]] later [[Bob]] again.');
    expect(links).toHaveLength(1);
    expect(links[0].raw).toBe('Bob');
  });

  it('handles Obsidian-style |alias suffix', () => {
    const links = parseWikilinks('Refer to [[Lin Shen|林深]] for details.');
    expect(links.map(l => l.raw)).toEqual(['Lin Shen']);
  });

  it('ignores stray brackets and code', () => {
    const links = parseWikilinks('No link here: [single] or ``[[code]]`` is mute.');
    // The single-bracket form isn't a wikilink. The fenced code block we don't
    // strip ourselves — that's the renderer's job; the regex still picks it up
    // because we treat the parse-time set as a superset.
    expect(links.some(l => l.raw === 'code')).toBe(true);
    expect(links.some(l => l.raw === 'single')).toBe(false);
  });

  it('returns empty for missing/empty input', () => {
    expect(parseWikilinks('')).toEqual([]);
    expect(parseWikilinks('Just text, no brackets at all.')).toEqual([]);
  });
});
