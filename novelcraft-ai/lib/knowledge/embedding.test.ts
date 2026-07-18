import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-embed-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const USER_ID = 'embed-test-user';

async function setup() {
  const mod = await import('@/lib/db');
  const novel = await mod.createNovel({
    userId: USER_ID,
    title: 'Embed Test Novel',
    genre: 'sci-fi',
    targetWords: 60000,
  });
  return { novel, mod };
}

describe('embedding helpers', () => {
  it('cosine returns 1 for identical vectors, 0 for orthogonal', async () => {
    const { cosine } = await import('@/lib/knowledge/embedding');
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosine(new Float32Array([1, 2, 3]), new Float32Array([2, 4, 6]))).toBeCloseTo(1);
  });

  it('embedTexts calls /v1/embeddings and returns Float32Array per input', async () => {
    const { embedTexts } = await import('@/lib/knowledge/embedding');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const result = await embedTexts(['alpha', 'beta'], {
      baseUrl: 'http://127.0.0.1:8081/v1',
      modelId: 'nomic-embed-text',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(String(calledUrl)).toBe('http://127.0.0.1:8081/v1/embeddings');
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(result[0])).toEqual([
      Number(new Float32Array([0.1])[0]),
      Number(new Float32Array([0.2])[0]),
      Number(new Float32Array([0.3])[0]),
    ]);
  });

  it('embedTexts rejects credential-bearing embedding endpoint URLs before fetch', async () => {
    const { embedTexts } = await import('@/lib/knowledge/embedding');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await expect(
      embedTexts(['alpha'], {
        baseUrl: 'http://user:pass@127.0.0.1:8081/v1',
      }),
    ).rejects.toThrow('invalid embedding endpoint URL');
    await expect(
      embedTexts(['alpha'], {
        baseUrl: 'http://127.0.0.1:8081/v1?token=secret',
      }),
    ).rejects.toThrow('invalid embedding endpoint URL');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('embedTexts rejects API keys on non-loopback HTTP embedding endpoints before fetch', async () => {
    const { embedTexts } = await import('@/lib/knowledge/embedding');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    await expect(
      embedTexts(['alpha'], {
        baseUrl: 'http://192.168.1.50:8081/v1',
        modelId: 'nomic-embed-text',
        apiKey: 'embed-secret',
      }),
    ).rejects.toThrow('insecure embedding API key transport');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolveEmbeddingEndpointFromRequest applies the same runtime gate and URL validation as model resolution', async () => {
    const prevBase = process.env.INKMARSHAL_EMBED_BASE_URL;
    delete process.env.INKMARSHAL_EMBED_BASE_URL;
    try {
      const { resolveEmbeddingEndpointFromRequest } = await import('@/lib/knowledge/embedding');
      const local = new Request('http://localhost:3000/api/novels/n/knowledge', {
        headers: {
          'x-im-role': 'recall',
          'x-im-base-url': 'http://127.0.0.1:8081/v1',
          'x-im-model': 'nomic-embed-text',
          'x-im-secret': 'embed-secret',
        },
      });
      expect(resolveEmbeddingEndpointFromRequest(local)).toEqual({
        baseUrl: 'http://127.0.0.1:8081/v1',
        modelId: 'nomic-embed-text',
        apiKey: 'embed-secret',
      });

      const withCredentials = new Request('http://localhost:3000/api/novels/n/knowledge', {
        headers: {
          'x-im-recall-base-url': 'http://user:pass@127.0.0.1:8081/v1',
          'x-im-recall-model': 'nomic-embed-text',
        },
      });
      expect(resolveEmbeddingEndpointFromRequest(withCredentials)).toBeNull();

      const remoteHttpWithSecret = new Request('http://localhost:3000/api/novels/n/knowledge', {
        headers: {
          'x-im-recall-base-url': 'http://192.168.1.50:8081/v1',
          'x-im-recall-model': 'nomic-embed-text',
          'x-im-recall-secret': 'embed-secret',
        },
      });
      expect(resolveEmbeddingEndpointFromRequest(remoteHttpWithSecret)).toBeNull();

      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('INKMARSHAL_RUNTIME', '');
      expect(resolveEmbeddingEndpointFromRequest(local)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      if (prevBase === undefined) delete process.env.INKMARSHAL_EMBED_BASE_URL;
      else process.env.INKMARSHAL_EMBED_BASE_URL = prevBase;
    }
  });

  it('resolveAmbientEmbeddingEndpoint rejects credential-bearing env URLs', async () => {
    const prevBase = process.env.INKMARSHAL_EMBED_BASE_URL;
    const prevRuntime = process.env.INKMARSHAL_RUNTIME;
    process.env.INKMARSHAL_EMBED_BASE_URL = 'http://user:pass@127.0.0.1:8081/v1';
    process.env.INKMARSHAL_RUNTIME = 'desktop';
    try {
      const { resolveAmbientEmbeddingEndpoint } = await import('@/lib/knowledge/embedding');
      expect(resolveAmbientEmbeddingEndpoint()).toBeNull();
    } finally {
      if (prevBase === undefined) delete process.env.INKMARSHAL_EMBED_BASE_URL;
      else process.env.INKMARSHAL_EMBED_BASE_URL = prevBase;
      if (prevRuntime === undefined) delete process.env.INKMARSHAL_RUNTIME;
      else process.env.INKMARSHAL_RUNTIME = prevRuntime;
    }
  });

  it('resolveAmbientEmbeddingEndpoint is desktop-loopback only and never a server-owned cloud fallback', async () => {
    const prevBase = process.env.INKMARSHAL_EMBED_BASE_URL;
    const prevKey = process.env.INKMARSHAL_EMBED_API_KEY;
    const prevRuntime = process.env.INKMARSHAL_RUNTIME;
    process.env.INKMARSHAL_EMBED_API_KEY = 'embed-secret';
    try {
      const { resolveAmbientEmbeddingEndpoint } = await import('@/lib/knowledge/embedding');

      process.env.INKMARSHAL_RUNTIME = 'desktop';
      process.env.INKMARSHAL_EMBED_BASE_URL = 'https://api.example.com/v1';
      expect(resolveAmbientEmbeddingEndpoint()).toBeNull();

      process.env.INKMARSHAL_EMBED_BASE_URL = 'http://192.168.1.50:8081/v1';
      expect(resolveAmbientEmbeddingEndpoint()).toBeNull();

      process.env.INKMARSHAL_RUNTIME = '';
      process.env.INKMARSHAL_EMBED_BASE_URL = 'http://127.0.0.1:8081/v1';
      expect(resolveAmbientEmbeddingEndpoint()).toBeNull();

      process.env.INKMARSHAL_RUNTIME = 'desktop';
      expect(resolveAmbientEmbeddingEndpoint()).toEqual({
        baseUrl: 'http://127.0.0.1:8081/v1',
        modelId: 'nomic-embed-text',
        apiKey: 'embed-secret',
      });
    } finally {
      if (prevBase === undefined) delete process.env.INKMARSHAL_EMBED_BASE_URL;
      else process.env.INKMARSHAL_EMBED_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.INKMARSHAL_EMBED_API_KEY;
      else process.env.INKMARSHAL_EMBED_API_KEY = prevKey;
      if (prevRuntime === undefined) delete process.env.INKMARSHAL_RUNTIME;
      else process.env.INKMARSHAL_RUNTIME = prevRuntime;
    }
  });

  it('upsertEntryEmbedding returns no_model when no hint and no env var', async () => {
    const prev = process.env.INKMARSHAL_EMBED_BASE_URL;
    delete process.env.INKMARSHAL_EMBED_BASE_URL;
    try {
      const { novel, mod } = await setup();
      try {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await mod.createKnowledgeEntry({
          id,
          novelId: novel.id,
          type: 'character',
          title: 'Solo',
          summary: 'A lone wanderer.',
          data: '{"role":"protagonist"}',
          sortOrder: 0,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
        // Sync the index so the entry has a row to read.
        const { syncIndexFromEntry } = await import('@/lib/knowledge/index-sync');
        await syncIndexFromEntry({
          id,
          novelId: novel.id,
          type: 'character',
          title: 'Solo',
          summary: 'A lone wanderer.',
          data: { role: 'protagonist' },
          tags: [],
          updatedAt: now,
        });

        const { upsertEntryEmbedding } = await import('@/lib/knowledge/embedding');
        const res = await upsertEntryEmbedding(id);
        expect(res).toBe('no_model');
      } finally {
        await mod.deleteNovelCascade(novel.id, USER_ID);
      }
    } finally {
      if (prev === undefined) delete process.env.INKMARSHAL_EMBED_BASE_URL;
      else process.env.INKMARSHAL_EMBED_BASE_URL = prev;
    }
  });

  it('upsertEntryEmbedding writes Float32Array to knowledge_embeddings when endpoint succeeds', async () => {
    const { novel, mod } = await setup();
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await mod.createKnowledgeEntry({
        id,
        novelId: novel.id,
        type: 'character',
        title: 'Vector Subject',
        summary: 'embedding fodder',
        data: '{"role":"supporting","description":"A test subject."}',
        sortOrder: 0,
        tags: '[]',
        createdAt: now,
        updatedAt: now,
      });
      const { syncIndexFromEntry } = await import('@/lib/knowledge/index-sync');
      await syncIndexFromEntry({
        id,
        novelId: novel.id,
        type: 'character',
        title: 'Vector Subject',
        summary: 'embedding fodder',
        data: { role: 'supporting', description: 'A test subject.' },
        tags: [],
        updatedAt: now,
      });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ embedding: new Array(8).fill(0).map((_, i) => i / 10) }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      const { upsertEntryEmbedding } = await import('@/lib/knowledge/embedding');
      const res = await upsertEntryEmbedding(id, {
        baseUrl: 'http://127.0.0.1:8081/v1',
        modelId: 'nomic-embed-text',
      });
      expect(res).toBe('ok');

      const { getKnowledgeEmbedding } = await import('@/lib/db/queries-knowledge-vault');
      const stored = await getKnowledgeEmbedding(id);
      expect(stored).not.toBeNull();
      expect(stored!.dim).toBe(8);
      expect(stored!.vector.length).toBe(8);
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  // The knowledge_embeddings.id FKs knowledge_index.id, so an embedding row
  // needs a matching index row first.
  async function seedIndexedEntry(mod: typeof import('@/lib/db'), novelId: string, title: string): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await mod.createKnowledgeEntry({
      id, novelId, type: 'character', title, summary: '', data: '{}',
      sortOrder: 0, tags: '[]', createdAt: now, updatedAt: now,
    });
    const { syncIndexFromEntry } = await import('@/lib/knowledge/index-sync');
    await syncIndexFromEntry({ id, novelId, type: 'character', title, summary: '', data: {}, tags: [], updatedAt: now });
    return id;
  }

  it('getKnowledgeEmbeddingStats returns count + maxUpdatedAt without decoding BLOBs', async () => {
    const { novel, mod } = await setup();
    try {
      const q = await import('@/lib/db/queries-knowledge-vault');
      // Empty store.
      const empty = await q.getKnowledgeEmbeddingStats(novel.id);
      expect(empty.count).toBe(0);
      expect(empty.maxUpdatedAt).toBe('');

      const id1 = await seedIndexedEntry(mod, novel.id, 'Stats A');
      const id2 = await seedIndexedEntry(mod, novel.id, 'Stats B');
      await q.upsertKnowledgeEmbedding({
        id: id1,
        novelId: novel.id,
        modelId: 'nomic-embed-text',
        dim: 3,
        vector: Float32Array.from([1, 0, 0]),
        contentHash: 'h1',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await q.upsertKnowledgeEmbedding({
        id: id2,
        novelId: novel.id,
        modelId: 'nomic-embed-text',
        dim: 3,
        vector: Float32Array.from([0, 1, 0]),
        contentHash: 'h2',
        updatedAt: '2026-02-02T00:00:00.000Z',
      });

      const stats = await q.getKnowledgeEmbeddingStats(novel.id);
      expect(stats.count).toBe(2);
      expect(stats.maxUpdatedAt).toBe('2026-02-02T00:00:00.000Z');
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('searchSimilarEntries warns once and signals a stale store on full dim mismatch', async () => {
    const { novel, mod } = await setup();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { upsertKnowledgeEmbedding } = await import('@/lib/db/queries-knowledge-vault');
      const staleId = await seedIndexedEntry(mod, novel.id, 'Stale Subject');
      // Store a 4-dim vector while the query model emits 3 dims → full mismatch.
      await upsertKnowledgeEmbedding({
        id: staleId,
        novelId: novel.id,
        modelId: 'old-model',
        dim: 4,
        vector: Float32Array.from([1, 0, 0, 0]),
        contentHash: 'stale',
        updatedAt: new Date().toISOString(),
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const { searchSimilarEntries, invalidateEmbeddingCache } = await import('@/lib/knowledge/embedding');
      invalidateEmbeddingCache(novel.id);
      const hits = await searchSimilarEntries(novel.id, 'query', 5, {
        baseUrl: 'http://127.0.0.1:8081/v1',
      });
      expect(hits).toEqual([]);
      const messages = warnSpy.mock.calls.map(c => String(c[0]));
      expect(messages.some(m => m.includes('mismatched dim'))).toBe(true);
      expect(messages.some(m => m.includes('stale for the current model'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });

  it('searchSimilarEntries returns ordered hits using cosine over stored vectors', async () => {
    const { novel, mod } = await setup();
    try {
      const ids: string[] = [];
      const fixedVectors = [
        [1, 0, 0],
        [0, 1, 0],
        [0.9, 0.1, 0],
      ];
      for (let i = 0; i < 3; i++) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await mod.createKnowledgeEntry({
          id,
          novelId: novel.id,
          type: 'character',
          title: `Test ${i}`,
          summary: '',
          data: '{}',
          sortOrder: i,
          tags: '[]',
          createdAt: now,
          updatedAt: now,
        });
        const { syncIndexFromEntry } = await import('@/lib/knowledge/index-sync');
        await syncIndexFromEntry({
          id,
          novelId: novel.id,
          type: 'character',
          title: `Test ${i}`,
          summary: '',
          data: {},
          tags: [],
          updatedAt: now,
        });
        const { upsertKnowledgeEmbedding } = await import('@/lib/db/queries-knowledge-vault');
        await upsertKnowledgeEmbedding({
          id,
          novelId: novel.id,
          modelId: 'nomic-embed-text',
          dim: 3,
          vector: Float32Array.from(fixedVectors[i]),
          contentHash: `hash-${i}`,
          updatedAt: now,
        });
        ids.push(id);
      }

      // Query "[1,0,0]" should rank entry 0 first, then entry 2 (0.9,0.1,0), then 1.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const { searchSimilarEntries } = await import('@/lib/knowledge/embedding');
      const hits = await searchSimilarEntries(novel.id, 'query', 3, {
        baseUrl: 'http://127.0.0.1:8081/v1',
      });
      expect(hits.length).toBe(3);
      // Highest score first
      expect(hits[0].entryId).toBe(ids[0]);
      // (0.9,0.1,0) dot (1,0,0) = 0.9 > (0,1,0) dot (1,0,0) = 0
      expect(hits[1].entryId).toBe(ids[2]);
      expect(hits[2].entryId).toBe(ids[1]);
    } finally {
      await mod.deleteNovelCascade(novel.id, USER_ID);
    }
  });
});
