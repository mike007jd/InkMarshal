import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireLocalUser: vi.fn(),
  createAIUsageSession: vi.fn(),
  aiUsageErrorResponse: vi.fn(),
  extractStyleNotesResult: vi.fn(),
  usageFail: vi.fn(),
  usageCancel: vi.fn(),
  usageRecord: vi.fn(),
}));

vi.mock('@/lib/local-auth', () => ({
  requireLocalUser: mocks.requireLocalUser,
}));

vi.mock('@/lib/ai-usage', () => ({
  createAIUsageSession: mocks.createAIUsageSession,
  aiUsageErrorResponse: mocks.aiUsageErrorResponse,
}));

vi.mock('@/lib/ai/style-extractor', () => ({
  EMPTY_STYLE_NOTES: {
    voice: '',
    sentenceLength: '',
    vocabularyHints: [],
    povTendency: '',
  },
  extractStyleNotesResult: mocks.extractStyleNotesResult,
}));

beforeEach(() => {
  mocks.requireLocalUser.mockReset();
  mocks.requireLocalUser.mockResolvedValue({ user: { id: 'local-user' } });
  mocks.createAIUsageSession.mockReset();
  mocks.createAIUsageSession.mockResolvedValue({
    model: {},
    addPromptText: vi.fn(),
    fail: mocks.usageFail,
    cancel: mocks.usageCancel,
    recordUsage: mocks.usageRecord,
  });
  mocks.aiUsageErrorResponse.mockReset();
  mocks.aiUsageErrorResponse.mockReturnValue(null);
  mocks.extractStyleNotesResult.mockReset();
  mocks.extractStyleNotesResult.mockResolvedValue({
    notes: {
      voice: 'dry',
      sentenceLength: '',
      vocabularyHints: [],
      povTendency: '',
    },
    ok: true,
  });
  mocks.usageFail.mockReset();
  mocks.usageCancel.mockReset();
  mocks.usageRecord.mockReset();
});

describe('style-extract route cancellation', () => {
  it('cancels usage instead of recording failure or success when the request aborts during extraction', async () => {
    const { POST } = await import('./route');
    const controller = new AbortController();
    mocks.extractStyleNotesResult.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve({
        notes: {
          voice: 'dry',
          sentenceLength: '',
          vocabularyHints: [],
          povTendency: '',
        },
        ok: true,
      });
    });

    const response = await POST(new Request('http://localhost/api/knowledge/style-extract', {
      method: 'POST',
      body: JSON.stringify({ sampleText: 'A'.repeat(100) }),
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    }));

    expect(response.status).toBe(499);
    expect(mocks.usageCancel).toHaveBeenCalledTimes(1);
    expect(mocks.usageFail).not.toHaveBeenCalled();
    expect(mocks.usageRecord).not.toHaveBeenCalled();
  });

  it('returns the manual fallback but marks usage failed when extraction degrades', async () => {
    const { POST } = await import('./route');
    mocks.extractStyleNotesResult.mockResolvedValueOnce({
      notes: {
        voice: '',
        sentenceLength: '',
        vocabularyHints: [],
        povTendency: '',
      },
      ok: false,
    });

    const response = await POST(new Request('http://localhost/api/knowledge/style-extract', {
      method: 'POST',
      body: JSON.stringify({ sampleText: 'A'.repeat(100) }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      voice: '',
      sentenceLength: '',
      vocabularyHints: [],
      povTendency: '',
    });
    expect(mocks.usageFail).toHaveBeenCalledTimes(1);
    expect(mocks.usageRecord).not.toHaveBeenCalled();
  });
});
