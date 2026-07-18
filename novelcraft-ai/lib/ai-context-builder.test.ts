import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Reuses the same INKMARSHAL_DATA_DIR isolation pattern as db-local.test.ts so
// the on-disk SQLite singleton inside lib/db-local opens in a temp dir.
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-ctxbuilder-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USER_ID = 'ctx-test-user';

async function freshNovel() {
  const mod = await import('@/lib/db');
  const novel = await mod.createNovel({
    userId: USER_ID,
    title: 'Test Novel',
    genre: 'fantasy',
    targetWords: 80000,
  });
  return { novel, mod };
}

describe('buildAIContext — per-op shape', () => {
  it('returns null for an unknown novel id', async () => {
    const { buildAIContext } = await import('@/lib/ai-context-builder');
    const result = await buildAIContext({
      novelId: '00000000-0000-0000-0000-000000000000',
      locale: 'en',
      op: 'chapter',
    });
    expect(result).toBeNull();
  });

  it('counts Chinese prompt-reserve fields with the same token estimator as context blocks', async () => {
    const { novel, mod } = await freshNovel();
    try {
      const cjkSummary = '世界设定'.repeat(1500);
      const { buildAIContext } = await import('@/lib/ai-context-builder');
      const result = await buildAIContext({
        novelId: novel.id,
        novel: {
          ...novel,
          storySummary: cjkSummary,
          characterSummary: cjkSummary,
        },
        locale: 'zh',
        op: 'edit',
        modelCtxTokens: 8000,
      });

      expect(result).not.toBeNull();
      expect(result!.budget.estTokens).toBeGreaterThan(10_000);
      expect(result!.budget.pressure).toBe('over');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('chapter op: includes knowledge + memory placeholders with no chapters written yet', async () => {
    const { novel, mod } = await freshNovel();
    try {
      const now = new Date().toISOString();
      // Two characters with non-empty summaries so buildSummaryInjection picks them up.
      await mod.createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'character',
        title: 'Hero',
        summary: 'A brave protagonist with a tragic past.',
        data: '{"role":"protagonist"}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      await mod.createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'world',
        title: 'Northrealm',
        summary: 'A frozen kingdom in the far north.',
        data: '{"category":"location"}',
        sortOrder: 1,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });

      const { buildAIContext } = await import('@/lib/ai-context-builder');
      const result = await buildAIContext({
        novelId: novel.id,
        locale: 'en',
        op: 'chapter',
      });
      expect(result).not.toBeNull();
      // Knowledge block populated; memory block empty (no chapters yet).
      expect(result!.knowledgeBlock.length).toBeGreaterThan(0);
      expect(result!.knowledgeBlock).toContain('Hero');
      expect(result!.knowledgeBlock).toContain('Northrealm');
      expect(result!.memoryBlock).toBe('');
      // budget report shape
      expect(result!.budget.op).toBe('chapter');
      expect(result!.budget.knowledgeChars).toBe(result!.knowledgeBlock.length);
      expect(result!.budget.ctxTokens).toBeGreaterThan(0);
      expect(['ok', 'warn', 'over']).toContain(result!.budget.pressure);
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('edit op: smaller knowledge budget than chapter op for the same data', async () => {
    const { novel, mod } = await freshNovel();
    try {
      const now = new Date().toISOString();
      // Stuff 20 long-summary entries so both ops have material to inject.
      for (let i = 0; i < 20; i++) {
        await mod.createKnowledgeEntry({
          id: crypto.randomUUID(),
          novelId: novel.id,
          type: 'character',
          title: `Character ${i}`,
          // ~200 chars summary each.
          summary: 'A '.repeat(80) + `role number ${i} with detailed backstory and motivations spread across multiple plot lines.`,
          data: '{"role":"supporting"}',
          sortOrder: i,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
      }

      const { buildAIContext } = await import('@/lib/ai-context-builder');
      const chapter = await buildAIContext({
        novelId: novel.id,
        locale: 'en',
        op: 'chapter',
      });
      const edit = await buildAIContext({
        novelId: novel.id,
        locale: 'en',
        op: 'edit',
        focus: { chapterNumber: 1 },
      });
      expect(chapter).not.toBeNull();
      expect(edit).not.toBeNull();
      // chapter op = 12000-char knowledge budget; edit = 4000 — edit must be
      // strictly smaller given the same pool of material.
      expect(edit!.knowledgeBlock.length).toBeLessThan(chapter!.knowledgeBlock.length);
      expect(edit!.budget.op).toBe('edit');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('continue op: includes recent chapter tails when chapters exist', async () => {
    const { novel, mod } = await freshNovel();
    try {
      // Five short chapters so buildRollingDigest's recent window picks up the tail.
      for (let n = 1; n <= 5; n++) {
        await mod.upsertChapter(
          novel.id,
          n,
          `Chapter ${n}`,
          `This is the body of chapter ${n}. `.repeat(20) + `Ending phrase of chapter ${n}.`,
        );
      }

      const { buildAIContext } = await import('@/lib/ai-context-builder');
      const result = await buildAIContext({
        novelId: novel.id,
        locale: 'en',
        op: 'continue',
        focus: { chapterNumber: 6 },
      });
      expect(result).not.toBeNull();
      // recentWindow=2 by spec; should see ch4 + ch5 tails.
      expect(result!.memoryBlock).toContain('Ch.5');
      expect(result!.memoryBlock).toContain('Ending phrase of chapter 5');
      // continue knowledge budget is 8000 — smaller than chapter.
      const chapterCtx = await buildAIContext({ novelId: novel.id, locale: 'en', op: 'chapter' });
      expect(result!.budget.knowledgeChars).toBeLessThanOrEqual(chapterCtx!.budget.knowledgeChars);
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('rewrite op: includes 1-chapter tail (smaller window than continue)', async () => {
    const { novel, mod } = await freshNovel();
    try {
      for (let n = 1; n <= 4; n++) {
        await mod.upsertChapter(novel.id, n, `Ch ${n}`, `prose ${n} `.repeat(50));
      }

      const { buildAIContext } = await import('@/lib/ai-context-builder');
      const rewrite = await buildAIContext({
        novelId: novel.id,
        locale: 'en',
        op: 'rewrite',
        focus: { chapterNumber: 4, selectedText: 'prose 4 prose 4' },
      });
      expect(rewrite).not.toBeNull();
      // recentWindow=1 → ch.4 in memory; ch.3 NOT in recentTails (it falls into earlierDigest).
      expect(rewrite!.memoryBlock).toContain('Ch.4');
      expect(rewrite!.memoryBlock).toContain('[Selected text]');
      // earlier digest carries ch.1-3 facts (lightly)
      expect(rewrite!.budget.op).toBe('rewrite');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('chat op: no per-chapter tails, but knowledge present', async () => {
    const { novel, mod } = await freshNovel();
    try {
      const now = new Date().toISOString();
      await mod.createKnowledgeEntry({
        id: crypto.randomUUID(),
        novelId: novel.id,
        type: 'character',
        title: 'Mentor',
        summary: 'The wise old guide.',
        data: '{"role":"supporting"}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      // A chapter exists but chat op should NOT include its tail.
      await mod.upsertChapter(novel.id, 1, 'Ch 1', 'lengthy chapter prose here'.repeat(20));

      const { buildAIContext } = await import('@/lib/ai-context-builder');
      const result = await buildAIContext({
        novelId: novel.id,
        locale: 'en',
        op: 'chat',
        focus: { conversationId: 'noop' },
      });
      expect(result).not.toBeNull();
      expect(result!.knowledgeBlock).toContain('Mentor');
      // chat op has recentWindow=0 → no recent chapter tails.
      expect(result!.memoryBlock).not.toContain('lengthy chapter prose here');
      expect(result!.budget.op).toBe('chat');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('accepts only UUID style ids before injecting style-reference entries', async () => {
    const { novel, mod } = await freshNovel();
    try {
      const now = new Date().toISOString();
      const validStyleId = crypto.randomUUID();
      await mod.createKnowledgeEntry({
        id: validStyleId,
        novelId: novel.id,
        type: 'style_reference',
        title: 'Valid Voice',
        summary: '',
        data: JSON.stringify({
          sampleText: 'valid sample',
          styleNotes: 'valid clipped syntax',
          source: 'valid source',
        }),
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      await mod.createKnowledgeEntry({
        id: 'legacy-style-id',
        novelId: novel.id,
        type: 'style_reference',
        title: 'Legacy Voice',
        summary: '',
        data: JSON.stringify({
          sampleText: 'legacy sample',
          styleNotes: 'legacy style should not be selected from headers',
          source: 'legacy source',
        }),
        sortOrder: 1,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });

      const { buildAIContext } = await import('@/lib/ai-context-builder');
      const rejected = await buildAIContext({
        novelId: novel.id,
        locale: 'en',
        op: 'edit',
        styleId: 'legacy-style-id',
      });
      expect(rejected).not.toBeNull();
      expect(rejected!.systemPrompt).not.toContain('legacy style should not be selected');

      const accepted = await buildAIContext({
        novelId: novel.id,
        locale: 'en',
        op: 'edit',
        styleId: validStyleId,
      });
      expect(accepted).not.toBeNull();
      expect(accepted!.systemPrompt).toContain('valid clipped syntax');
      expect(accepted!.systemPrompt).toContain('valid sample');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });
});
