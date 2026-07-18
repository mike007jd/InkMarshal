import { afterEach, describe, expect, it, vi } from 'vitest';

const buildAIContextMock = vi.fn(async () => null);

vi.mock('@/lib/ai-context-builder', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ai-context-builder')>();
  return {
    ...actual,
    buildAIContext: buildAIContextMock,
  };
});

afterEach(() => {
  buildAIContextMock.mockClear();
});

describe('buildNovelSystemPromptFromDB', () => {
  it('forwards embeddingHint and op through to the builder', async () => {
    const { buildNovelSystemPromptFromDB } = await import('@/lib/ai-context');
    const embeddingHint = {
      baseUrl: 'http://127.0.0.1:8081/v1',
      modelId: 'nomic-embed-text',
      apiKey: 'embed-secret',
    };

    await buildNovelSystemPromptFromDB(
      'novel-1',
      'en',
      undefined,
      { op: 'unify', modelCtxTokens: 8192, embeddingHint },
    );

    expect(buildAIContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        novelId: 'novel-1',
        op: 'unify',
        modelCtxTokens: 8192,
        embeddingHint,
      }),
    );
  });
});
