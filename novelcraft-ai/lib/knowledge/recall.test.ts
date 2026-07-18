import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Reuses the same INKMARSHAL_DATA_DIR isolation pattern as the other db-backed
// tests so the on-disk SQLite singleton opens in a temp dir.
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-recall-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USER_ID = 'recall-test-user';

async function freshNovel() {
  const mod = await import('@/lib/db');
  const novel = await mod.createNovel({
    userId: USER_ID,
    title: 'Recall Test Novel',
    genre: 'fantasy',
    targetWords: 80000,
  });
  return { novel, mod };
}

type DbModule = typeof import('@/lib/db');

async function makeKnowledgeEntry(
  mod: DbModule,
  novelId: string,
  type: 'character' | 'world' | 'timeline' | 'outline',
  title: string,
  data: Record<string, unknown>,
  summary = '',
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await mod.createKnowledgeEntry({
    id,
    novelId,
    type,
    title,
    summary: summary || `Auto summary for ${title}`,
    data: JSON.stringify(data),
    sortOrder: 0,
    tags: '[]',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('recallKnowledgeForChapter', () => {
  it('does not infer CJK single-character names from unrelated substrings', async () => {
    const { collectCandidateNames } = await import('@/lib/knowledge/recall');
    expect(collectCandidateNames({
      outlineEntry: null,
      extraQueryText: '安静的房间里，The wind shifted.',
      indexedNameSet: new Set(['安', '安娜', 'The']),
    })).toEqual([]);
    expect(collectCandidateNames({
      outlineEntry: null,
      extraQueryText: '安娜推开门。',
      indexedNameSet: new Set(['安', '安娜']),
    })).toEqual(['安娜']);
  });

  it('returns empty when no knowledge entries exist', async () => {
    const { novel, mod } = await freshNovel();
    try {
      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        budgetChars: 8000,
      });
      expect(result.block).toBe('');
      expect(result.usedEmbedding).toBe(false);
      expect(result.blocks).toEqual([]);
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('hits only entities named in the outline (chapter 5 mentions Hero + Mentor, ignores other 18)', async () => {
    const { novel, mod } = await freshNovel();
    try {
      // 20 characters, but the outline only mentions two of them.
      const heroId = await makeKnowledgeEntry(mod, novel.id, 'character', 'Hero', {
        role: 'protagonist',
        traits: ['brave', 'curious'],
        motivation: 'Find the lost sword',
        arc: 'Becomes a leader',
      });
      const mentorId = await makeKnowledgeEntry(mod, novel.id, 'character', 'Mentor', {
        role: 'supporting',
        motivation: 'Guide the Hero',
      });
      // 18 distractors
      for (let i = 0; i < 18; i++) {
        await makeKnowledgeEntry(mod, novel.id, 'character', `Distractor ${i}`, {
          role: 'minor',
        });
      }
      // An outline frontmatter targeting Hero + Mentor.
      await makeKnowledgeEntry(mod, novel.id, 'outline', 'Ch. 5 — Confrontation', {
        chapterNumber: 5,
        synopsis: 'Hero confronts Mentor in the old library.',
        keyEvents: ['Hero asks Mentor about the sword'],
        characters: ['Hero', 'Mentor'],
      });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        chapterNumber: 5,
        budgetChars: 8000,
      });

      expect(result.block).toContain('Hero');
      expect(result.block).toContain('Mentor');
      // Plain "Distractor" should NOT appear anywhere.
      expect(result.block).not.toContain('Distractor');
      // The character group should have exactly Hero + Mentor.
      const charBlock = result.blocks.find(b => b.type === 'character');
      expect(charBlock).toBeTruthy();
      const titles = charBlock!.entries.map(e => e.title).sort();
      expect(titles).toEqual(['Hero', 'Mentor']);
      // We didn't reach embedding fallback (no hint passed + structured matches hit).
      expect(result.usedEmbedding).toBe(false);
      // Outline neighbour included.
      expect(result.block).toContain('Ch. 5');
      void heroId; void mentorId;
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('expands wikilinks 1-hop: Hero body references [[Sidekick]] → Sidekick joins recall', async () => {
    const { novel, mod } = await freshNovel();
    try {
      // Hero summary contains a wikilink to Sidekick.
      await makeKnowledgeEntry(
        mod,
        novel.id,
        'character',
        'Hero',
        { role: 'protagonist', description: 'Travels with [[Sidekick]] from chapter one.' },
        'Travels with [[Sidekick]] from chapter one.',
      );
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Sidekick', {
        role: 'supporting',
        motivation: 'Loyalty to Hero',
      });
      await makeKnowledgeEntry(mod, novel.id, 'outline', 'Ch. 2', {
        chapterNumber: 2,
        synopsis: 'Hero arrives in town.',
        characters: ['Hero'],
      });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        chapterNumber: 2,
        budgetChars: 8000,
      });

      expect(result.block).toContain('Hero');
      expect(result.block).toContain('Sidekick');
      const charBlock = result.blocks.find(b => b.type === 'character');
      const titles = charBlock!.entries.map(e => e.title).sort();
      expect(titles).toContain('Sidekick');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('does not follow a resolvedId that points to another novel index row', async () => {
    const { novel, mod } = await freshNovel();
    const other = await mod.createNovel({
      userId: USER_ID,
      title: 'Other Recall Novel',
      genre: 'fantasy',
      targetWords: 80000,
    });
    try {
      const { upsertKnowledgeIndexRow } = await import('@/lib/db/queries-vault');
      const sourceId = crypto.randomUUID();
      const otherSecretId = crypto.randomUUID();
      const outlineId = crypto.randomUUID();
      const now = new Date().toISOString();

      await upsertKnowledgeIndexRow({
        id: otherSecretId,
        novelId: other.id,
        type: 'world',
        path: 'worlds/other-secret.md',
        title: 'Other Secret',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: JSON.stringify({ description: 'cross novel leak marker' }),
        outgoingLinks: '[]',
        contentHash: 'other-secret',
        updatedAt: now,
      });
      await upsertKnowledgeIndexRow({
        id: sourceId,
        novelId: novel.id,
        type: 'character',
        path: 'characters/hero.md',
        title: 'Hero',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: JSON.stringify({ role: 'protagonist', description: 'clean source' }),
        outgoingLinks: JSON.stringify([{ raw: 'Other Secret', resolvedId: otherSecretId }]),
        contentHash: 'hero',
        updatedAt: now,
      });
      await upsertKnowledgeIndexRow({
        id: outlineId,
        novelId: novel.id,
        type: 'outline',
        path: 'outline/ch-4.md',
        title: 'Ch. 4',
        tags: '[]',
        aliases: '[]',
        importance: null,
        data: JSON.stringify({ chapterNumber: 4, synopsis: 'Hero enters the archive.', characters: ['Hero'] }),
        outgoingLinks: '[]',
        contentHash: 'outline',
        updatedAt: now,
      });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        chapterNumber: 4,
        budgetChars: 8000,
      });

      expect(result.block).toContain('Hero');
      expect(result.block).not.toContain('Other Secret');
      expect(result.block).not.toContain('cross novel leak marker');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
      await mod.deleteNovelCascade(other.id, USER_ID);
    }
  });

  it('lazy rebuild preserves current relation edges for 1-hop recall', async () => {
    const { novel, mod } = await freshNovel();
    try {
      const sourceId = await makeKnowledgeEntry(mod, novel.id, 'character', 'Current Source', {
        role: 'supporting',
        description: 'Knows the target through a current relation row.',
      });
      const targetId = await makeKnowledgeEntry(mod, novel.id, 'character', 'Current Target', {
        role: 'supporting',
        description: 'Only reachable through the current relation table.',
      });
      await mod.createKnowledgeRelation({
        id: crypto.randomUUID(),
        sourceId,
        targetId,
        relationType: 'ally',
        label: '',
        createdAt: new Date().toISOString(),
      });
      await makeKnowledgeEntry(mod, novel.id, 'outline', 'Ch. 3', {
        chapterNumber: 3,
        synopsis: 'Current Source enters the archive alone.',
        characters: ['Current Source'],
      });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        chapterNumber: 3,
        budgetChars: 8000,
      });

      expect(result.block).toContain('Current Source');
      expect(result.block).toContain('Current Target');
      const charBlock = result.blocks.find(b => b.type === 'character');
      const titles = charBlock!.entries.map(e => e.title).sort();
      expect(titles).toEqual(['Current Source', 'Current Target']);
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('extraQueryText surfaces a character mentioned only in the cursor-prefix tail', async () => {
    const { novel, mod } = await freshNovel();
    try {
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Captain', { role: 'supporting' });
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Ghost', { role: 'antagonist' });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        budgetChars: 8000,
        extraQueryText: 'The Captain looked back at his crew.',
      });

      expect(result.block).toContain('Captain');
      // Ghost was not mentioned anywhere → must not surface from structured pass.
      expect(result.block).not.toContain('Ghost');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('extraQueryText surfaces a world entry mentioned directly in prose', async () => {
    const { novel, mod } = await freshNovel();
    try {
      await makeKnowledgeEntry(mod, novel.id, 'world', 'Glass Archive', {
        category: 'location',
        description: 'A memory vault below the capital.',
      });
      await makeKnowledgeEntry(mod, novel.id, 'world', 'Distant Harbor', {
        category: 'location',
        description: 'A port far away from this scene.',
      });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        budgetChars: 8000,
        extraQueryText: 'They reached the Glass Archive before dawn.',
      });

      expect(result.block).toContain('Glass Archive');
      expect(result.block).not.toContain('Distant Harbor');
      const worldBlock = result.blocks.find(b => b.type === 'world');
      expect(worldBlock?.entries.map(e => e.title)).toEqual(['Glass Archive']);
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('always folds in importance:high entries even when not named in the outline', async () => {
    const { novel, mod } = await freshNovel();
    try {
      // Named in the outline → matched the normal keyword way.
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Hero', { role: 'protagonist' });
      // NOT named anywhere in this chapter, but flagged important. The safety
      // net (KV-04) should surface it so long-range continuity isn't dropped.
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Hidden Patron', {
        role: 'supporting',
        importance: 'high',
        description: 'A benefactor pulling strings from off-page.',
      });
      // A non-important, un-named character must still be skipped.
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Random Extra', { role: 'minor' });
      await makeKnowledgeEntry(mod, novel.id, 'outline', 'Ch. 7', {
        chapterNumber: 7,
        synopsis: 'Hero walks the empty road.',
        characters: ['Hero'],
      });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        chapterNumber: 7,
        budgetChars: 8000,
      });

      expect(result.block).toContain('Hero');
      expect(result.block).toContain('Hidden Patron');
      expect(result.block).not.toContain('Random Extra');
      const charBlock = result.blocks.find(b => b.type === 'character');
      const titles = charBlock!.entries.map(e => e.title).sort();
      expect(titles).toEqual(['Hero', 'Hidden Patron']);
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('matches known character names case-insensitively in freeform recall text', async () => {
    const { novel, mod } = await freshNovel();
    try {
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Captain', { role: 'supporting' });
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Ghost', { role: 'antagonist' });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const result = await recallKnowledgeForChapter({
        novelId: novel.id,
        budgetChars: 8000,
        extraQueryText: 'the captain lowered her voice near the dock.',
      });

      expect(result.block).toContain('Captain');
      expect(result.block).not.toContain('Ghost');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('rebuilds when the index is emptied after a successful rebuild (entries still present)', async () => {
    // Regression guard for the process-level rebuild leak: the old module Set
    // marked a novel "rebuild attempted" on first success and never cleared
    // it, so if the index was later wiped (corruption / vault hand-edit) while
    // the canonical table still held rows, recall returned an empty knowledge
    // block forever until process restart.
    const { novel, mod } = await freshNovel();
    try {
      await makeKnowledgeEntry(mod, novel.id, 'character', 'Persistent Hero', {
        role: 'protagonist',
      });
      await makeKnowledgeEntry(mod, novel.id, 'outline', 'Ch. 1', {
        chapterNumber: 1,
        synopsis: 'Persistent Hero opens the gate.',
        characters: ['Persistent Hero'],
      });

      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const first = await recallKnowledgeForChapter({
        novelId: novel.id,
        chapterNumber: 1,
        budgetChars: 8000,
      });
      expect(first.block).toContain('Persistent Hero');

      // Simulate the index being wiped while current rows survive.
      const { getDb } = await import('@/lib/db/connection');
      getDb().prepare('DELETE FROM knowledge_index WHERE novel_id = ?').run(novel.id);
      const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
      expect(await listKnowledgeIndexForNovel(novel.id)).toHaveLength(0);

      const second = await recallKnowledgeForChapter({
        novelId: novel.id,
        chapterNumber: 1,
        budgetChars: 8000,
      });
      // Must recover by rebuilding, not stay permanently empty.
      expect(second.block).toContain('Persistent Hero');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('caches genuinely-empty novels without re-scanning legacy every call', async () => {
    const { novel, mod } = await freshNovel();
    try {
      const { recallKnowledgeForChapter } = await import('@/lib/knowledge/recall');
      const first = await recallKnowledgeForChapter({ novelId: novel.id, budgetChars: 8000 });
      expect(first.block).toBe('');
      const second = await recallKnowledgeForChapter({ novelId: novel.id, budgetChars: 8000 });
      expect(second.block).toBe('');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });
});
