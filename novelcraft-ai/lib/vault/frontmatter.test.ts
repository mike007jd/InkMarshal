import { describe, expect, it } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from '@/lib/vault/frontmatter';
import type { VaultFrontmatter } from '@/lib/vault/types';

describe('vault/frontmatter', () => {
  it('parses a minimal Obsidian-style file with scalar fields', () => {
    const raw = `---\nid: abc\ntype: character\ntitle: 林深\n---\nBody text\n`;
    const { frontmatter, body, warnings } = parseFrontmatter(raw);
    expect(frontmatter.id).toBe('abc');
    expect(frontmatter.type).toBe('character');
    expect(frontmatter.title).toBe('林深');
    expect(body).toBe('Body text\n');
    expect(warnings).toEqual([]);
  });

  it('returns the original body and a warning when no frontmatter is present', () => {
    const raw = `Just body without delimiters\n`;
    const { frontmatter, body, warnings } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('parses inline lists and indented lists', () => {
    const raw = [
      '---',
      'tags: [hero, lead]',
      'aliases:',
      '  - 林深',
      '  - "Shen Lin"',
      '---',
      'body',
      '',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(['hero', 'lead']);
    expect(frontmatter.aliases).toEqual(['林深', 'Shen Lin']);
  });

  // YAML 1.2 §7.3.3: inside a single-quoted scalar, the only escape is `''`
  // for a literal `'`. Obsidian writes apostrophes in aliases this way, e.g.
  // `aliases: ['don''t worry']`. The previous parser dropped the second `'`
  // entirely, silently corrupting the alias to "dont worry".
  it("decodes doubled single quotes inside single-quoted scalars (YAML 1.2 §7.3.3)", () => {
    const raw = [
      '---',
      "aliases: ['don''t worry', 'it''s fine']",
      '---',
      'body',
      '',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.aliases).toEqual(["don't worry", "it's fine"]);
  });

  it('parses inline objects for relations', () => {
    const raw = [
      '---',
      'relations:',
      '  - {target: 林夕, type: family, label: 兄妹}',
      '---',
      'body',
      '',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.relations).toEqual([
      { target: '林夕', type: 'family', label: '兄妹' },
    ]);
  });

  it('treats a bare wikilink scalar as a string (not a list) and warns', () => {
    const raw = [
      '---',
      'id: x',
      'type: character',
      'title: Lin Shen',
      'target: [[Lin Shen]]',
      '---',
      'body',
      '',
    ].join('\n');
    const { frontmatter, warnings } = parseFrontmatter(raw);
    // Not mangled into an inline list like ['[Lin Shen]'].
    expect((frontmatter as unknown as Record<string, unknown>).target).toBe('[[Lin Shen]]');
    expect(warnings.some(w => w.includes('Bare wikilink'))).toBe(true);
  });

  it('still parses genuine inline lists that merely start with a bracket', () => {
    const raw = ['---', 'tags: [a, b, c]', '---', 'body', ''].join('\n');
    const { frontmatter, warnings } = parseFrontmatter(raw);
    expect(frontmatter.tags).toEqual(['a', 'b', 'c']);
    expect(warnings).toEqual([]);
  });

  it('round-trips through serialize + parse', () => {
    const original: VaultFrontmatter = {
      id: 'abc-123',
      type: 'character',
      title: 'Lin Shen',
      tags: ['hero', 'lead'],
      aliases: ['林深'],
      importance: 'high',
      role: 'protagonist',
      traits: ['stoic', 'loyal'],
    };
    const md = serializeFrontmatter(original, '# Header\n\nBody text\n');
    const parsed = parseFrontmatter(md);
    expect(parsed.frontmatter.id).toBe('abc-123');
    expect(parsed.frontmatter.type).toBe('character');
    expect(parsed.frontmatter.title).toBe('Lin Shen');
    expect(parsed.frontmatter.tags).toEqual(['hero', 'lead']);
    expect(parsed.frontmatter.aliases).toEqual(['林深']);
    expect(parsed.frontmatter.importance).toBe('high');
    expect(parsed.frontmatter.role).toBe('protagonist');
    expect(parsed.frontmatter.traits).toEqual(['stoic', 'loyal']);
    expect(parsed.body).toBe('# Header\n\nBody text\n');
  });

  it('quotes strings containing special characters', () => {
    const fm: VaultFrontmatter = {
      id: 'x',
      type: 'character',
      title: 'Has: colon and # hash',
    };
    const md = serializeFrontmatter(fm, '');
    const parsed = parseFrontmatter(md);
    expect(parsed.frontmatter.title).toBe('Has: colon and # hash');
  });

  it('handles empty list / empty body gracefully', () => {
    const fm: VaultFrontmatter = {
      id: 'x',
      type: 'character',
      title: 'X',
      tags: [],
    };
    const md = serializeFrontmatter(fm, '');
    const parsed = parseFrontmatter(md);
    expect(parsed.frontmatter.tags).toEqual([]);
  });
});
