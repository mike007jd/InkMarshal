import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => ({
  createAIUsageSession: vi.fn(),
  aiUsageErrorResponse: vi.fn(),
  extractKnowledgeFromManuscript: vi.fn(),
  recordUsage: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@/lib/ai-usage', () => ({
  createAIUsageSession: mocks.createAIUsageSession,
  aiUsageErrorResponse: mocks.aiUsageErrorResponse,
}));

vi.mock('@/lib/import/extract-knowledge', () => ({
  extractKnowledgeFromManuscript: mocks.extractKnowledgeFromManuscript,
}));

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-kb-extract-route-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

beforeEach(() => {
  mocks.createAIUsageSession.mockReset();
  mocks.createAIUsageSession.mockResolvedValue({
    model: {},
    recordUsage: mocks.recordUsage,
    fail: mocks.fail,
    cancel: mocks.cancel,
  });
  mocks.recordUsage.mockReset();
  mocks.recordUsage.mockResolvedValue(undefined);
  mocks.fail.mockReset();
  mocks.fail.mockResolvedValue(undefined);
  mocks.cancel.mockReset();
  mocks.cancel.mockResolvedValue(undefined);
  mocks.aiUsageErrorResponse.mockReset();
  mocks.aiUsageErrorResponse.mockReturnValue(null);
  mocks.extractKnowledgeFromManuscript.mockReset();
  mocks.extractKnowledgeFromManuscript.mockResolvedValue({
    outcome: 'done',
    created: 0,
  });
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function createPendingExtraction() {
  const { createNovel, updateNovel, upsertChapter } = await import('@/lib/db');
  const novel = await createNovel({
    userId: 'local-user',
    title: 'Extraction claim route',
  });
  const kbExtractionId = crypto.randomUUID();
  await updateNovel(novel.id, {
    settings: {
      importMeta: {
        source: 'txt',
        importedAt: '2026-07-30T00:05:00.000Z',
        originalFilename: 'claim.txt',
        detectedChapters: 1,
        kbExtraction: 'pending',
        kbExtractionId,
      },
    },
  });
  await upsertChapter(novel.id, 1, 'One', 'Long enough imported chapter content.');
  return { novelId: novel.id, kbExtractionId };
}

function requestFor(
  novelId: string,
  kbExtractionId: string,
  signal?: AbortSignal,
): Request {
  return new Request(
    `http://localhost/api/novels/${novelId}/import/extract-knowledge`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kbExtractionId }),
      signal,
    },
  );
}

describe('post-import knowledge extraction claim', () => {
  it('does not rerun a completed generation', async () => {
    const { POST } = await import('./route');
    const { deleteNovelCascade } = await import('@/lib/db');
    const { novelId, kbExtractionId } = await createPendingExtraction();

    try {
      const first = await POST(
        requestFor(novelId, kbExtractionId),
        { params: Promise.resolve({ id: novelId }) },
      );
      expect(await first.json()).toMatchObject({ outcome: 'done' });

      const replay = await POST(
        requestFor(novelId, kbExtractionId),
        { params: Promise.resolve({ id: novelId }) },
      );
      expect(await replay.json()).toEqual({
        outcome: 'already_done',
        created: 0,
      });
      expect(mocks.createAIUsageSession).toHaveBeenCalledTimes(1);
      expect(mocks.extractKnowledgeFromManuscript).toHaveBeenCalledTimes(1);
    } finally {
      await deleteNovelCascade(novelId, 'local-user');
    }
  });

  it('returns in_progress instead of starting a second provider call', async () => {
    const { POST } = await import('./route');
    const { deleteNovelCascade } = await import('@/lib/db');
    const { novelId, kbExtractionId } = await createPendingExtraction();
    let resolveExtraction!: (result: { outcome: 'done'; created: number }) => void;
    mocks.extractKnowledgeFromManuscript.mockImplementationOnce(
      () => new Promise(resolve => {
        resolveExtraction = resolve;
      }),
    );

    try {
      const firstPromise = POST(
        requestFor(novelId, kbExtractionId),
        { params: Promise.resolve({ id: novelId }) },
      );
      await vi.waitFor(() => {
        expect(mocks.extractKnowledgeFromManuscript).toHaveBeenCalledTimes(1);
      });

      const duplicate = await POST(
        requestFor(novelId, kbExtractionId),
        { params: Promise.resolve({ id: novelId }) },
      );
      expect(await duplicate.json()).toEqual({
        outcome: 'in_progress',
        created: 0,
      });
      expect(mocks.createAIUsageSession).toHaveBeenCalledTimes(1);

      resolveExtraction({ outcome: 'done', created: 0 });
      expect(await (await firstPromise).json()).toMatchObject({ outcome: 'done' });
    } finally {
      await deleteNovelCascade(novelId, 'local-user');
    }
  });

  it('records an aborted extraction as cancelled exactly once', async () => {
    const { POST } = await import('./route');
    const { deleteNovelCascade } = await import('@/lib/db');
    const { novelId, kbExtractionId } = await createPendingExtraction();
    const controller = new AbortController();
    mocks.extractKnowledgeFromManuscript.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    try {
      const responsePromise = POST(
        requestFor(novelId, kbExtractionId, controller.signal),
        { params: Promise.resolve({ id: novelId }) },
      );
      await vi.waitFor(() => {
        expect(mocks.extractKnowledgeFromManuscript).toHaveBeenCalledTimes(1);
      });
      controller.abort();

      expect((await responsePromise).status).toBe(499);
      expect(mocks.cancel).toHaveBeenCalledTimes(1);
      expect(mocks.fail).not.toHaveBeenCalled();
      expect(mocks.recordUsage).not.toHaveBeenCalled();
    } finally {
      await deleteNovelCascade(novelId, 'local-user');
    }
  });

  it('revokes the attempt after an unexpected setup failure so retry is immediate', async () => {
    const { POST } = await import('./route');
    const { deleteNovelCascade } = await import('@/lib/db');
    const { novelId, kbExtractionId } = await createPendingExtraction();
    mocks.createAIUsageSession.mockRejectedValueOnce(
      new Error('unexpected setup failure'),
    );

    try {
      await expect(POST(
        requestFor(novelId, kbExtractionId),
        { params: Promise.resolve({ id: novelId }) },
      )).rejects.toThrow('unexpected setup failure');

      const retry = await POST(
        requestFor(novelId, kbExtractionId),
        { params: Promise.resolve({ id: novelId }) },
      );
      expect(await retry.json()).toMatchObject({ outcome: 'done' });
      expect(mocks.createAIUsageSession).toHaveBeenCalledTimes(2);
    } finally {
      await deleteNovelCascade(novelId, 'local-user');
    }
  });

  it('stops waiting at the hard deadline even when the provider ignores abort', async () => {
    vi.useFakeTimers();
    const { POST } = await import('./route');
    const { deleteNovelCascade } = await import('@/lib/db');
    const { novelId, kbExtractionId } = await createPendingExtraction();
    mocks.extractKnowledgeFromManuscript.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    try {
      const responsePromise = POST(
        requestFor(novelId, kbExtractionId),
        { params: Promise.resolve({ id: novelId }) },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.extractKnowledgeFromManuscript).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(280_000);

      expect((await responsePromise).status).toBe(499);
      expect(mocks.cancel).toHaveBeenCalledTimes(1);
      expect(mocks.fail).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await deleteNovelCascade(novelId, 'local-user');
    }
  });
});
