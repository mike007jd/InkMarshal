import { describe, expect, it } from 'vitest';
import {
  parseMarkdownToEntry,
  renderEntryToMarkdown,
  projectEntryForLegacy,
  outgoingLinksFor,
  vaultPathFor,
  vaultTypeForDir,
  vaultTypeForPath,
} from '@/lib/vault/entry';
import type { VaultEntry } from '@/lib/vault/entry';
import type { VaultFrontmatter } from '@/lib/vault/types';

describe('vault/entry', () => {
  it('round-trips a character entry through render + parse', () => {
    const fm: VaultFrontmatter = {
      id: 'char-1',
      type: 'character',
      title: 'Lin Shen',
      tags: ['protagonist'],
      role: 'protagonist',
      traits: ['stoic'],
      importance: 'high',
      createdAt: '2026-05-20T12:00:00.000Z',
      updatedAt: '2026-05-20T12:00:00.000Z',
    };
    const entry: VaultEntry = {
      id: 'char-1',
      novelId: 'novel-1',
      type: 'character',
      path: 'characters/lin-shen.md',
      frontmatter: fm,
      body: '# Lin Shen\n\nA quiet protagonist who meets [[Lin Xi]].\n',
    };
    const md = renderEntryToMarkdown(entry);
    const { entry: parsed, warnings } = parseMarkdownToEntry('novel-1', 'characters/lin-shen.md', md);
    expect(warnings).toEqual([]);
    expect(parsed.id).toBe('char-1');
    expect(parsed.type).toBe('character');
    expect(parsed.frontmatter.title).toBe('Lin Shen');
    expect(parsed.frontmatter.role).toBe('protagonist');
    expect(parsed.frontmatter.traits).toEqual(['stoic']);
    expect(parsed.body).toContain('Lin Xi');
  });

  it('projects a VaultEntry to the legacy KnowledgeEntry shape', () => {
    const entry: VaultEntry = {
      id: 'e1',
      novelId: 'n1',
      type: 'character',
      path: 'characters/a.md',
      frontmatter: {
        id: 'e1',
        type: 'character',
        title: 'A',
        tags: ['t'],
        role: 'protagonist',
        importance: 'high',
        createdAt: '2026-05-20T12:00:00.000Z',
        updatedAt: '2026-05-20T12:00:00.000Z',
      },
      body: 'Body summary text.\n',
    };
    const projection = projectEntryForLegacy(entry);
    expect(projection.id).toBe('e1');
    expect(projection.novelId).toBe('n1');
    expect(projection.type).toBe('character');
    expect(projection.title).toBe('A');
    expect(projection.tags).toEqual(['t']);
    expect(projection.summary).toContain('Body summary text');
    expect(projection.data.role).toBe('protagonist');
    expect(projection.data.tags).toBeUndefined();
    expect(projection.data.title).toBeUndefined();
  });

  it('preserves timeline event importance as timeline data, not vault priority', () => {
    const entry: VaultEntry = {
      id: 't1',
      novelId: 'n1',
      type: 'timeline',
      path: 'timeline/inciting-incident.md',
      frontmatter: {
        id: 't1',
        type: 'timeline',
        title: 'Inciting Incident',
        date: 'Day 1',
        dateSort: 1,
        eventType: 'plot',
        importance: 'major' as never,
        createdAt: '2026-05-20T12:00:00.000Z',
        updatedAt: '2026-05-20T12:00:00.000Z',
      },
      body: 'The event changes the plot.\n',
    };
    const projection = projectEntryForLegacy(entry);
    expect(projection.data.importance).toBe('major');
  });

  it('keeps vault priority importance out of timeline event data', () => {
    const entry: VaultEntry = {
      id: 't2',
      novelId: 'n1',
      type: 'timeline',
      path: 'timeline/side-event.md',
      frontmatter: {
        id: 't2',
        type: 'timeline',
        title: 'Side Event',
        dateSort: 2,
        eventType: 'plot',
        importance: 'high',
      },
      body: 'A useful note.\n',
    };
    const projection = projectEntryForLegacy(entry);
    expect(projection.data.importance).toBeUndefined();
  });

  it('W3-1: round-trips outline hierarchy fields (level/parentId/sceneMeta/tags) through the vault', () => {
    const fm: VaultFrontmatter = {
      id: 'sc-1',
      type: 'outline',
      title: 'The confrontation',
      tags: [],
      level: 'scene',
      parentId: 'ch-1',
      sceneMeta: {
        pov: 'Alice',
        time: 'Day 3',
        location: 'Throne Room',
        conflict: 'Alice confronts the king',
        outcome: 'Alliance broken',
      },
      plotlineTags: ['Rebellion'],
      characterArcTags: ['Alice: defiance'],
      customMeta: { mood: 'tense' },
      createdAt: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
    };
    const entry: VaultEntry = {
      id: 'sc-1',
      novelId: 'n1',
      type: 'outline',
      path: 'outline/the-confrontation.md',
      frontmatter: fm,
      body: 'Scene body.\n',
    };
    const md = renderEntryToMarkdown(entry);
    const { entry: parsed } = parseMarkdownToEntry('n1', 'outline/the-confrontation.md', md);
    const projection = projectEntryForLegacy(parsed);
    expect(projection.data.level).toBe('scene');
    expect(projection.data.parentId).toBe('ch-1');
    expect(projection.data.sceneMeta).toMatchObject({ pov: 'Alice', location: 'Throne Room' });
    expect(projection.data.plotlineTags).toEqual(['Rebellion']);
    expect(projection.data.characterArcTags).toEqual(['Alice: defiance']);
    expect(projection.data.customMeta).toMatchObject({ mood: 'tense' });
  });

  it('extracts outgoing wikilinks from the body', () => {
    const entry: VaultEntry = {
      id: 'e',
      novelId: 'n',
      type: 'character',
      path: 'characters/e.md',
      frontmatter: { id: 'e', type: 'character', title: 'E' },
      body: 'meets [[Bob]] and [[Old Castle]]',
    };
    const links = outgoingLinksFor(entry);
    expect(links.map(l => l.raw)).toEqual(['Bob', 'Old Castle']);
  });

  it('extracts structured relation targets as outgoing links', () => {
    const entry: VaultEntry = {
      id: 'e',
      novelId: 'n',
      type: 'character',
      path: 'characters/e.md',
      frontmatter: {
        id: 'e',
        type: 'character',
        title: 'E',
        relations: [
          { target: 'Bob', type: 'ally' },
          { target: 'Old Castle', type: 'home' },
        ],
      },
      body: 'meets [[Bob]]',
    };
    const links = outgoingLinksFor(entry);
    expect(links.map(l => l.raw)).toEqual(['Bob', 'Old Castle']);
  });

  it('extracts frontmatter wikilinks and outline character lists as outgoing links', () => {
    const entry: VaultEntry = {
      id: 'outline-1',
      novelId: 'n',
      type: 'outline',
      path: 'outline/ch-1.md',
      frontmatter: {
        id: 'outline-1',
        type: 'outline',
        title: 'Ch. 1',
        synopsis: 'They reach [[North Gate]].',
        characters: ['Mira Vale', 'Bob'],
      },
      body: 'Mira sees [[North Gate]] again.',
    };
    const links = outgoingLinksFor(entry);
    expect(links.map(l => l.raw)).toEqual(['North Gate', 'Mira Vale', 'Bob']);
  });

  it('places entries in the right vault subdirectory by type', () => {
    expect(vaultPathFor('character', 'a.md')).toBe('characters/a.md');
    expect(vaultPathFor('world', 'b.md')).toBe('worlds/b.md');
    expect(vaultPathFor('timeline', 'c.md')).toBe('timeline/c.md');
    expect(vaultPathFor('outline', 'ch-1.md')).toBe('outline/ch-1.md');
    expect(vaultPathFor('style_reference', 's.md')).toBe('styles/s.md');
  });

  it('resolves vault subdirectories back to knowledge types', () => {
    expect(vaultTypeForDir('characters')).toBe('character');
    expect(vaultTypeForDir('worlds')).toBe('world');
    expect(vaultTypeForDir('unknown')).toBeNull();
    expect(vaultTypeForPath('styles/prose.md')).toBe('style_reference');
    expect(vaultTypeForPath('nested/styles/prose.md')).toBeNull();
  });
});
