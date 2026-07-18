import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InterviewState } from '@/lib/interview-state';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  generateGreenlightPack: vi.fn(),
  createAIUsageSession: vi.fn(),
  aiUsageErrorResponse: vi.fn(),
}));

vi.mock('@/lib/ai', () => ({
  generateGreenlightPack: mocks.generateGreenlightPack,
}));

vi.mock('@/lib/ai-usage', () => ({
  createAIUsageSession: mocks.createAIUsageSession,
  aiUsageErrorResponse: mocks.aiUsageErrorResponse,
}));

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

function proposalReviewState(profile: Record<string, string> = {
  premise: 'guided interview premise',
}): InterviewState {
  return {
    mode: 'proposal_review',
    currentQuestionId: null,
    currentQuestion: null,
    currentHelperText: null,
    currentOptions: [],
    recommendedOptionId: null,
    slotTarget: null,
    missingFields: [],
    collectedProfile: profile,
    proposalSummary: 'approved guided proposal',
    proposalVersion: 1,
    interviewStage: 'proposal_review',
    stageProgress: { current: 6, total: 6 },
  };
}

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-greenlight-api-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

beforeEach(() => {
  mocks.generateGreenlightPack.mockReset();
  mocks.aiUsageErrorResponse.mockReset();
  mocks.aiUsageErrorResponse.mockReturnValue(null);
  mocks.createAIUsageSession.mockReset();
  mocks.createAIUsageSession.mockResolvedValue({
    model: {},
    addPromptText: vi.fn(),
    addPartialOutput: vi.fn(),
    recordUsage: vi.fn(),
    fail: vi.fn(),
  });
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('greenlight API generated pack bounds', () => {
  it('loads interview messages before creating the AI usage session', () => {
    const source = readFileSync('app/api/novels/[id]/greenlight/route.ts', 'utf8');

    expect(source).toContain('const messages = await getMessages(id);');
    expect(source).toContain("const aiUsage = await createAIUsageSession(request, { userId: user.id, operation: 'outline' });");
    expect(source).not.toContain('Promise.all([');
  });

  it('settles greenlight usage at most once around abort and generation failures', () => {
    const source = readFileSync('app/api/novels/[id]/greenlight/route.ts', 'utf8');

    expect(source).toContain('const failUsageOnce = async () => {');
    expect(source).toContain('await aiUsage.recordUsage(result.usage);\n      usageSettled = true;');
    expect(source.indexOf('await aiUsage.recordUsage(result.usage);')).toBeGreaterThan(
      source.indexOf('const promoted = await promoteGreenlightDraftWithMessage('),
    );
    expect(source).not.toContain('if (request.signal.aborted) {\n      await aiUsage.fail();');
  });

  it('returns an already-greenlit novel without requiring interview state', async () => {
    const { POST } = await import('@/app/api/novels/[id]/greenlight/route');
    const { createNovel, deleteNovelCascade, updateNovel } = await import('@/lib/db');
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Already Ready',
      genre: 'fantasy',
    });

    try {
      await updateNovel(novel.id, { stage: 'ready_for_greenlight' });
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/greenlight`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(200);
      expect((await response.json()).stage).toBe('ready_for_greenlight');
      expect(mocks.generateGreenlightPack).not.toHaveBeenCalled();
      expect(mocks.createAIUsageSession).not.toHaveBeenCalled();
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('builds the greenlight pack from the guided interview profile only', async () => {
    const { POST } = await import('@/app/api/novels/[id]/greenlight/route');
    const { addMessage, createConversation, createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { saveInterviewState } = await import('@/lib/interview-state-server');
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Scoped Discovery Draft',
      genre: 'fantasy',
    });
    await saveInterviewState(novel.id, proposalReviewState({
      premise: 'guided premise',
      protagonist: 'guided protagonist',
    }));
    mocks.generateGreenlightPack.mockResolvedValue({
      pack: {
        title: 'Scoped Discovery Draft',
        genre: 'fantasy',
        storySummary: 'story',
        characterSummary: 'characters',
        arcSummary: 'arc',
      },
      usage: {},
    });

    try {
      const now = new Date().toISOString();
      const conversation = await createConversation({
        id: 'greenlight-side-conversation',
        novelId: novel.id,
        userId: 'local-user',
        topic: 'plot',
        title: 'Side conversation',
        parentMessageId: null,
        createdAt: now,
        updatedAt: now,
      });
      await addMessage(novel.id, 'user', 'interview premise');
      await addMessage(novel.id, 'assistant', 'side thread should not shape plan', conversation.id);

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/greenlight`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(200);
      expect(mocks.generateGreenlightPack).toHaveBeenCalledWith(
        expect.objectContaining({
          history: [{
            role: 'user',
            content: expect.stringContaining('premise: guided premise'),
          }],
        }),
      );
      const call = mocks.generateGreenlightPack.mock.calls.at(-1)?.[0];
      expect(call.history[0].content).toContain('protagonist: guided protagonist');
      expect(call.history[0].content).toContain('Proposal summary:');
      expect(call.history[0].content).not.toContain('side thread should not shape plan');
      expect(call.history[0].content).not.toContain('interview premise');
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('rejects oversized generated packs before mutating novel context or stage', async () => {
    const { POST } = await import('@/app/api/novels/[id]/greenlight/route');
    const { createNovel, getNovel, getMessages, updateNovel } = await import('@/lib/db');
    const { saveInterviewState } = await import('@/lib/interview-state-server');
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Discovery Draft',
      genre: 'fantasy',
    });
    await updateNovel(novel.id, { storySummary: 'seed story' });
    await saveInterviewState(novel.id, proposalReviewState());
    mocks.generateGreenlightPack.mockResolvedValue({
      pack: {
        title: 'x'.repeat(201),
        genre: 'fantasy',
        storySummary: 'story',
        characterSummary: 'characters',
        arcSummary: 'arc',
      },
      usage: {},
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/greenlight`, {
      method: 'POST',
    }), { params: Promise.resolve({ id: novel.id }) });

    consoleSpy.mockRestore();
    expect(response.status).toBe(500);
    const after = await getNovel(novel.id);
    expect(after?.stage).toBe('discovery_interview');
    expect(after?.title).toBe('Discovery Draft');
    expect(after?.storySummary).toBe('seed story');
    expect(await getMessages(novel.id)).toEqual([]);
  });

  it('rejects stale generated packs when the interview changes during generation', async () => {
    const { POST } = await import('@/app/api/novels/[id]/greenlight/route');
    const { addMessage, createNovel, deleteNovelCascade, getMessages, getNovel, updateNovel } = await import('@/lib/db');
    const { saveInterviewState } = await import('@/lib/interview-state-server');
    const novel = await createNovel({
      userId: 'local-user',
      title: 'Original Discovery Draft',
      genre: 'fantasy',
    });
    await saveInterviewState(novel.id, proposalReviewState({ premise: 'original guided premise' }));
    await addMessage(novel.id, 'user', 'original premise');
    mocks.generateGreenlightPack.mockImplementation(async () => {
      await updateNovel(novel.id, {
        stage: 'ready_for_greenlight',
        storySummary: 'fresh interview result',
      });
      await addMessage(novel.id, 'user', 'new premise while model was running');
      return {
        pack: {
          title: 'Stale Generated Draft',
          genre: 'fantasy',
          storySummary: 'stale generated story',
          characterSummary: 'stale characters',
          arcSummary: 'stale arc',
        },
        usage: {},
      };
    });

    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/greenlight`, {
        method: 'POST',
      }), { params: Promise.resolve({ id: novel.id }) });

      expect(response.status).toBe(409);
      const after = await getNovel(novel.id);
      expect(after?.title).toBe('Original Discovery Draft');
      expect(after?.stage).toBe('ready_for_greenlight');
      expect(after?.storySummary).toBe('fresh interview result');
      expect((await getMessages(novel.id)).map(message => message.content)).toEqual([
        'original premise',
        'new premise while model was running',
      ]);
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
