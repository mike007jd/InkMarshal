import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { parsePositiveIntegerParam } from '@/lib/route-params';
import { normalizeRewriteContext } from '@/lib/rewrite-context';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-rewrite-route-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('chapter rewrite route input guards', () => {
  it('accepts only positive integer chapter path params', () => {
    expect(parsePositiveIntegerParam('1')).toBe(1);
    expect(parsePositiveIntegerParam('0012')).toBe(12);
    expect(parsePositiveIntegerParam('0')).toBeNull();
    expect(parsePositiveIntegerParam('-1')).toBeNull();
    expect(parsePositiveIntegerParam('1abc')).toBeNull();
    expect(parsePositiveIntegerParam('1.5')).toBeNull();
    expect(parsePositiveIntegerParam('abc')).toBeNull();
  });

  it('bounds caller-supplied rewrite context sides before prompt construction', () => {
    expect(normalizeRewriteContext(undefined)).toEqual({ before: '', after: '' });
    expect(normalizeRewriteContext({ before: 'pre', after: 'post' })).toEqual({
      before: 'pre',
      after: 'post',
    });

    expect(() => normalizeRewriteContext('bad')).toThrow('context must be an object');
    expect(() => normalizeRewriteContext({ before: 123 })).toThrow('context.before must be a string');
    expect(() => normalizeRewriteContext({ after: 'x'.repeat(100_001) })).toThrow('context.after too large');
  });

  it('rejects missing chapters before model resolution', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { POST } = await import('@/app/api/novels/[id]/chapters/[chapterNumber]/rewrite/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Rewrite Missing Chapter' });
    try {
      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/chapters/42/rewrite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedText: 'old text', instruction: 'tighten it' }),
      }), { params: Promise.resolve({ id: novel.id, chapterNumber: '42' }) });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Chapter not found' });
    } finally {
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });

  it('fails AI usage when context construction cannot resolve the novel', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/chapters/[chapterNumber]/rewrite/route.ts'), 'utf8');

    expect(source).toMatch(/await aiUsage\.fail\(\);\s+return NextResponse\.json\(\{ error: 'Novel not found' \}, \{ status: 404 \}\);/);
    expect(source).toMatch(/\} catch \(error\) \{\s+await aiUsage\.fail\(\);\s+throw error;\s+\}/);
  });

  it('delegates streaming finish/error capture to the shared createStreamUsageCapture helper', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/chapters/[chapterNumber]/rewrite/route.ts'), 'utf8');

    // The finalText + finishReason capture and the onFinish/onError settlement
    // glue (subtle: zero-delta hang, double-record race, lock-TTL) is shared with
    // the continue route via createStreamUsageCapture — behaviour is unit-tested
    // in lib/ai-usage.test.ts. Here we only assert the route wires it correctly.
    expect(source).toContain('let result: ReturnType<typeof streamText>;');
    expect(source).toContain('const capture = createStreamUsageCapture(aiUsage, lifecycle);');
    expect(source).toContain('onFinish: event => capture.recordFinish(event)');
    expect(source).toContain('onError: ({ error }) => capture.recordError(error)');
    expect(source).toContain('capture.framing');
    // A synchronous streamText throw must still settle the capture and fail usage
    // rather than leave a consumer hanging on finishReason.
    expect(source).toContain('const wasCancelled = lifecycle.isCancelled();');
    expect(source).toMatch(/capture\.abandon\(\);\s+if \(wasCancelled\) await aiUsage\.cancel\(\);\s+else await aiUsage\.fail\(\);/);
    expect(source).toContain('streamTextWithAIUsageCleanup(textStreamWithLockRelease, aiUsage, lifecycle.signal');
    expect(source).toContain('onCancel: async () => {');
    expect(source).toContain('await releaseLockOnce();');
    expect(source).not.toContain('void releaseLockOnce();');
    expect(source).toContain('await renewLockOnce();');
    expect(source).toContain('renewTimer = setInterval(() => {');
    expect(source).toContain('await aiUsage.fail();\n      lifecycle.cancel();');
    expect(source).toContain('clearInterval(renewTimer);');
  });

  it('does not start a rewrite stream while another writing lock owns the novel', async () => {
    const {
      acquireWritingLock,
      createNovel,
      deleteNovelCascade,
      releaseWritingLock,
      upsertChapter,
    } = await import('@/lib/db');
    const { POST } = await import('@/app/api/novels/[id]/chapters/[chapterNumber]/rewrite/route');
    const novel = await createNovel({ userId: 'local-user', title: 'Rewrite Active Lock' });
    let token: string | null = null;

    try {
      await upsertChapter(novel.id, 1, 'One', 'old text');
      const lock = await acquireWritingLock(novel.id, 300);
      expect(lock).not.toBeNull();
      token = lock!.token;

      const response = await POST(new Request(`http://localhost/api/novels/${novel.id}/chapters/1/rewrite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selectedText: 'old text', instruction: 'tighten it' }),
      }), { params: Promise.resolve({ id: novel.id, chapterNumber: '1' }) });

      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toContain('application/json');
    } finally {
      if (token) await releaseWritingLock(novel.id, token);
      await deleteNovelCascade(novel.id, 'local-user');
    }
  });
});
