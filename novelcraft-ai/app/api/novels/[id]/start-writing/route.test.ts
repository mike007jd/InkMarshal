import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MAX_START_WRITING_CHAPTERS_PER_REQUEST,
  missingChapterNumbers,
  parseStartWritingBatchParams,
  shouldStopStartWritingBatch,
} from '@/lib/start-writing-batch';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  buildAIContext: vi.fn(),
  createAIUsageSession: vi.fn(),
  aiUsageErrorResponse: vi.fn(),
  getKnowledgeEntries: vi.fn(),
}));

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db');
  mocks.getKnowledgeEntries.mockImplementation(actual.getKnowledgeEntries);
  return {
    ...actual,
    getKnowledgeEntries: mocks.getKnowledgeEntries,
  };
});

vi.mock('@/lib/ai-context-builder', () => ({
  buildAIContext: mocks.buildAIContext,
}));

vi.mock('@/lib/ai-usage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai-usage')>('@/lib/ai-usage');
  return {
    ...actual,
    createAIUsageSession: mocks.createAIUsageSession,
    aiUsageErrorResponse: mocks.aiUsageErrorResponse,
  };
});

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

function mockUsageSession(contextWindow = 8192) {
  return {
    model: {},
    runtimeModel: { id: 'test-model', contextWindow },
    addPromptText: vi.fn(),
    addPartialOutput: vi.fn(),
    recordUsage: vi.fn(),
    fail: vi.fn(),
    settle: vi.fn().mockResolvedValue(undefined),
  };
}

async function createReadyNovel(title: string) {
  const { createKnowledgeEntry, createNovel, updateNovel } = await import('@/lib/db');
  const novel = await createNovel({
    userId: 'local-user',
    title,
    genre: 'fantasy',
  });
  await updateNovel(novel.id, {
    stage: 'ready_for_greenlight',
    storySummary: 'story seed',
    characterSummary: 'character seed',
    arcSummary: 'arc seed',
  });
  const now = new Date().toISOString();
  for (const type of ['character', 'world', 'outline']) {
    await createKnowledgeEntry({
      id: crypto.randomUUID(),
      novelId: novel.id,
      type,
      title: `${type} seed`,
      summary: `${type} summary`,
      data: '{}',
      sortOrder: 0,
      tags: '[]',
      createdAt: now,
      updatedAt: now,
    });
  }
  return novel;
}

async function expectWritingLockReleased(novelId: string) {
  const { acquireWritingLock, releaseWritingLock } = await import('@/lib/db');
  const lock = await acquireWritingLock(novelId, 10);
  expect(lock).not.toBeNull();
  await releaseWritingLock(novelId, lock!.token);
}

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-start-writing-route-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

beforeEach(() => {
  mocks.buildAIContext.mockReset();
  mocks.createAIUsageSession.mockReset();
  mocks.aiUsageErrorResponse.mockReset();
  mocks.aiUsageErrorResponse.mockReturnValue(null);
  mocks.getKnowledgeEntries.mockClear();
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('start-writing batch resume helpers', () => {
  it('finds the actual missing chapters instead of deriving next chapter from count', () => {
    const blueprint = [
      { chapterNumber: 1 },
      { chapterNumber: 2 },
      { chapterNumber: 3 },
      { chapterNumber: 4 },
    ];
    const existingByNumber = new Map<number, unknown>([
      [1, true],
      [3, true],
    ]);

    expect(missingChapterNumbers(blueprint, existingByNumber)).toEqual([2, 4]);
  });

  it('strictly parses pause-friendly batch query params', () => {
    expect(parseStartWritingBatchParams(new URLSearchParams(''))).toEqual({
      chaptersLimit: 1,
      untilChapter: null,
    });
    expect(parseStartWritingBatchParams(new URLSearchParams('chapters=3&untilChapter=12'))).toEqual({
      chaptersLimit: 3,
      untilChapter: 12,
    });
    expect(parseStartWritingBatchParams(new URLSearchParams('chapters=1abc'))).toEqual({
      error: 'chapters must be a positive integer',
    });
    expect(parseStartWritingBatchParams(new URLSearchParams('untilChapter=1.5'))).toEqual({
      error: 'untilChapter must be a positive integer',
    });
    expect(parseStartWritingBatchParams(new URLSearchParams(`chapters=${MAX_START_WRITING_CHAPTERS_PER_REQUEST + 1}`))).toEqual({
      error: `chapters must be <= ${MAX_START_WRITING_CHAPTERS_PER_REQUEST}`,
    });
    expect(parseStartWritingBatchParams(new URLSearchParams('untilChapter=501'))).toEqual({
      error: 'untilChapter must be <= 500',
    });
  });

  it('stops batches by hard cap, untilChapter, or explicit chapter count', () => {
    expect(shouldStopStartWritingBatch({
      writtenThisBatch: MAX_START_WRITING_CHAPTERS_PER_REQUEST,
      chapterNumber: 99,
      chaptersLimit: MAX_START_WRITING_CHAPTERS_PER_REQUEST,
      untilChapter: null,
    })).toBe(true);
    expect(shouldStopStartWritingBatch({
      writtenThisBatch: 1,
      chapterNumber: 4,
      chaptersLimit: 1,
      untilChapter: 3,
    })).toBe(true);
    expect(shouldStopStartWritingBatch({
      writtenThisBatch: 1,
      chapterNumber: 2,
      chaptersLimit: 1,
      untilChapter: 3,
    })).toBe(false);
    expect(shouldStopStartWritingBatch({
      writtenThisBatch: 1,
      chapterNumber: 2,
      chaptersLimit: 1,
      untilChapter: null,
    })).toBe(true);
  });
});

describe('start-writing route lock and context preflight behaviour', () => {
  it('releases the writing lock when loading the Story Deck throws', async () => {
    const { POST } = await import('@/app/api/novels/[id]/start-writing/route');
    const { deleteNovelCascade } = await import('@/lib/db');
    const novel = await createReadyNovel('Deck Query Failure');
    const queryError = new Error('deck query failed');
    mocks.getKnowledgeEntries.mockRejectedValueOnce(queryError);

    try {
      await expect(POST(new Request(`http://localhost/api/novels/${novel.id}/start-writing`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) })).rejects.toBe(queryError);
      expect(mocks.createAIUsageSession).not.toHaveBeenCalled();
      await expectWritingLockReleased(novel.id);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects a ready novel with an incomplete Story Deck before model preflight', async () => {
    const { POST } = await import('@/app/api/novels/[id]/start-writing/route');
    const { createNovel, deleteNovelCascade, updateNovel } = await import('@/lib/db');
    const novel = await createNovel({ userId: 'local-user', title: 'Missing Deck' });
    await updateNovel(novel.id, { stage: 'ready_for_greenlight' });

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/start-writing`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'STORY_DECK_INCOMPLETE',
        missingTypes: ['character', 'world', 'outline'],
      });
      expect(mocks.createAIUsageSession).not.toHaveBeenCalled();
      await expectWritingLockReleased(novel.id);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects a concurrent start-writing request before model preflight', async () => {
    const { POST } = await import('@/app/api/novels/[id]/start-writing/route');
    const { acquireWritingLock, deleteNovelCascade, releaseWritingLock } = await import('@/lib/db');
    const novel = await createReadyNovel('Locked Start');
    const heldLock = await acquireWritingLock(novel.id, 300);
    expect(heldLock).not.toBeNull();

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/start-writing`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(409);
      expect(mocks.createAIUsageSession).not.toHaveBeenCalled();
    } finally {
      await releaseWritingLock(novel.id, heldLock!.token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('releases the writing lock when the current stage cannot start writing', async () => {
    const { POST } = await import('@/app/api/novels/[id]/start-writing/route');
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Wrong Stage',
      genre: 'fantasy',
    });

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/start-writing`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'Writing can only be started after the outline is ready.' });
      await expectWritingLockReleased(novel.id);
      expect(mocks.createAIUsageSession).not.toHaveBeenCalled();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('passes the selected chapter model context window into pre-stream context loading', async () => {
    const { POST } = await import('@/app/api/novels/[id]/start-writing/route');
    const { deleteNovelCascade } = await import('@/lib/db');
    const novel = await createReadyNovel('Context Window');
    const preflightUsage = mockUsageSession(12_345);
    mocks.createAIUsageSession.mockResolvedValue(preflightUsage);
    mocks.buildAIContext.mockResolvedValue(null);

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/start-writing`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(404);
      expect(preflightUsage.settle).not.toHaveBeenCalled();
      expect(mocks.buildAIContext).toHaveBeenCalledWith(expect.objectContaining({
        novelId: novel.id,
        op: 'chapter',
        modelCtxTokens: 12_345,
        excludeRollingMemory: true,
      }));
      await expectWritingLockReleased(novel.id);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('releases the writing lock if pre-stream context loading fails', async () => {
    const { POST } = await import('@/app/api/novels/[id]/start-writing/route');
    const { deleteNovelCascade } = await import('@/lib/db');
    const novel = await createReadyNovel('Context Failure');
    mocks.createAIUsageSession.mockResolvedValue(mockUsageSession());
    mocks.buildAIContext.mockRejectedValue(new Error('context failed'));

    try {
      await expect(POST(new Request(`http://localhost/api/novels/${novel.id}/start-writing`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) })).rejects.toThrow('context failed');
      await expectWritingLockReleased(novel.id);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
