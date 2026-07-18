import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPERATION_ROLE, type OperationKind } from './model-supply/types';
import { zhCN } from '@/lib/i18n/zh-CN';

// Spy seam: createAIUsageSession must resolve via resolveModelForRole
// (operation → OPERATION_ROLE[operation] → role). We assert it passes the
// CORRECT role for every operation — locking the operation→role contract
// end-to-end (non-tautological: it would catch createAIUsageSession
// hard-coding or mis-mapping a role).

const resolveModelForRole = vi.fn();

vi.mock('@/lib/model-supply/server-resolve', () => ({
  resolveModelForRole: (...args: unknown[]) => resolveModelForRole(...args),
}));

// Capture the persisted ai_runs rows so the session's terminal outcomes and
// cost can be asserted end-to-end (AI-01).
const capturedRuns = vi.hoisted(() => [] as { row: Record<string, unknown>; userId: string }[]);
vi.mock('@/lib/db/queries-ai-runs', () => ({
  insertAiRun: (row: Record<string, unknown>, userId: string) => {
    capturedRuns.push({ row, userId });
  },
}));
vi.mock('@/lib/pricing', () => ({
  resolvePricing: () => ({ inputPerMTokUsd: 1, outputPerMTokUsd: 2, currency: 'USD' }),
}));

afterEach(() => {
  vi.clearAllMocks();
  capturedRuns.length = 0;
});

async function loadCreateAIUsageSession() {
  const mod = await import('./ai-usage');
  return mod.createAIUsageSession;
}

async function loadAIUsageModule() {
  return import('./ai-usage');
}

const FAKE_RESOLVED = {
  model: { __fake: 'model' },
  runtimeModel: {
    id: 'openai-compatible/local-model',
    name: 'Local local-model',
    providerId: 'openai-compatible',
    model: 'local-model',
    tags: ['user-owned-runtime'],
  },
  preset: { id: 'openai-compatible', name: 'x', baseUrl: 'http://x/v1', models: ['local-model'] },
};

describe('createAIUsageSession operation → role wiring', () => {
  const operations = Object.keys(OPERATION_ROLE) as OperationKind[];

  for (const operation of operations) {
    it(`operation "${operation}" resolves via role "${OPERATION_ROLE[operation]}"`, async () => {
      resolveModelForRole.mockResolvedValueOnce(FAKE_RESOLVED);
      const createAIUsageSession = await loadCreateAIUsageSession();
      const req = new Request('http://localhost:3000/api/x', { method: 'POST' });

      const session = await createAIUsageSession(req, {
        userId: 'user-1',
        operation,
      });

      expect(resolveModelForRole).toHaveBeenCalledTimes(1);
      expect(resolveModelForRole).toHaveBeenCalledWith(
        req,
        OPERATION_ROLE[operation],
      );
      expect(session.runtimeModel.model).toBe('local-model');
    });
  }

  it('surfaces a role binding failure instead of swallowing it', async () => {
    resolveModelForRole.mockRejectedValueOnce(new Error('The "rewrite" Anthropic runtime is missing an API key.'));
    const createAIUsageSession = await loadCreateAIUsageSession();
    const req = new Request('http://localhost:3000/api/x', { method: 'POST' });

    await expect(
      createAIUsageSession(req, { userId: 'user-1', operation: 'polish' }),
    ).rejects.toThrow('missing an API key');
  });

  it('throws a localized, classified 503 when nothing resolves', async () => {
    resolveModelForRole.mockResolvedValue(null);
    const createAIUsageSession = await loadCreateAIUsageSession();
    const req = new Request('http://localhost:3000/api/x', {
      method: 'POST',
      headers: { 'x-locale': 'zh-CN' },
    });

    await expect(
      createAIUsageSession(req, { userId: 'user-1', operation: 'polish' }),
    ).rejects.toMatchObject({
      status: 503,
      name: 'AIUsageError',
      category: 'local_engine',
      message: zhCN.aiErrorLocalEngine,
    });
  });

  it('reports missing local user context without implying a login system', async () => {
    const createAIUsageSession = await loadCreateAIUsageSession();
    const req = new Request('http://localhost:3000/api/x', { method: 'POST' });

    await expect(
      createAIUsageSession(req, { userId: '', operation: 'chat' }),
    ).rejects.toMatchObject({
      status: 500,
      message: 'Local user context missing',
    });
  });
});

describe('usage connection classification', () => {
  it('classifies loopback custom endpoints as local compute', async () => {
    const { connectionKindFromRequest } = await loadAIUsageModule();
    const req = new Request('http://localhost:3000/api/x', {
      headers: {
        'x-im-role': 'draft',
        'x-im-kind': 'custom',
        'x-im-base-url': 'http://127.0.0.1:11434/v1',
      },
    });

    expect(connectionKindFromRequest(req, 'draft')).toBe('local');
  });

  it('preserves custom classification for a remote endpoint', async () => {
    const { connectionKindFromRequest } = await loadAIUsageModule();
    const req = new Request('http://localhost:3000/api/x', {
      headers: {
        'x-im-role': 'draft',
        'x-im-kind': 'custom',
        'x-im-base-url': 'https://models.example.test/v1',
      },
    });

    expect(connectionKindFromRequest(req, 'draft')).toBe('custom');
  });
});

describe('AI stream lifecycle cancellation', () => {
  it('mirrors request aborts into the lifecycle signal', async () => {
    const { createAIStreamLifecycle } = await loadAIUsageModule();
    const requestAbort = new AbortController();
    const lifecycle = createAIStreamLifecycle(requestAbort.signal);

    expect(lifecycle.isCancelled()).toBe(false);
    expect(lifecycle.signal.aborted).toBe(false);

    requestAbort.abort();

    expect(lifecycle.isCancelled()).toBe(true);
    expect(lifecycle.signal.aborted).toBe(true);
  });

  it('settles response-stream cancellation as cancelled (not failed) and aborts upstream', async () => {
    const { createAIStreamLifecycle, streamTextWithAIUsageCleanup } = await loadAIUsageModule();
    const lifecycle = createAIStreamLifecycle();
    const settle = vi.fn().mockResolvedValue(undefined);
    const releaseBlockedStream = vi.fn<() => void>();
    const blocked = new Promise<void>(resolve => {
      releaseBlockedStream.mockImplementation(resolve);
    });

    const stream = streamTextWithAIUsageCleanup(
      (async function* () {
        yield 'first';
        await blocked;
        yield 'second';
      })(),
      {
        model: {} as never,
        runtimeModel: FAKE_RESOLVED.runtimeModel,
        addPromptText: vi.fn(),
        addPartialOutput: vi.fn(),
        recordUsage: vi.fn(),
        settle,
        fail: vi.fn(),
        cancel: vi.fn(),
      },
      lifecycle.signal,
      { onCancel: lifecycle.cancel },
    );

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel();

    expect(lifecycle.isCancelled()).toBe(true);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({ outcome: 'cancelled' });

    releaseBlockedStream();
  });

  it('awaits cancel settlement before response-stream cancellation resolves', async () => {
    const { createAIStreamLifecycle, streamTextWithAIUsageCleanup } = await loadAIUsageModule();
    const lifecycle = createAIStreamLifecycle();
    let releaseCancel!: () => void;
    const cancelBlocked = new Promise<void>(resolve => {
      releaseCancel = resolve;
    });
    let cancelSettled = false;
    const settle = vi.fn(async () => {
      await cancelBlocked;
      cancelSettled = true;
    });

    const stream = streamTextWithAIUsageCleanup(
      (async function* () {
        yield 'first';
        await new Promise<void>(() => undefined);
      })(),
      {
        model: {} as never,
        runtimeModel: FAKE_RESOLVED.runtimeModel,
        addPromptText: vi.fn(),
        addPartialOutput: vi.fn(),
        recordUsage: vi.fn(),
        settle,
        fail: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn(),
      },
      lifecycle.signal,
      { onCancel: lifecycle.cancel },
    );

    const reader = stream.getReader();
    await reader.read();

    const cancelPromise = reader.cancel();
    await Promise.resolve();

    expect(lifecycle.isCancelled()).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(cancelSettled).toBe(false);

    releaseCancel();
    await cancelPromise;

    expect(cancelSettled).toBe(true);
  });

  it('awaits custom cancel cleanup before response-stream cancellation resolves', async () => {
    const { createAIStreamLifecycle, streamTextWithAIUsageCleanup } = await loadAIUsageModule();
    const lifecycle = createAIStreamLifecycle();
    let releaseCleanup!: () => void;
    const cleanupBlocked = new Promise<void>(resolve => {
      releaseCleanup = resolve;
    });
    let cleanupSettled = false;
    const onCancel = vi.fn(async () => {
      lifecycle.cancel();
      await cleanupBlocked;
      cleanupSettled = true;
    });

    const stream = streamTextWithAIUsageCleanup(
      (async function* () {
        yield 'first';
        await new Promise<void>(() => undefined);
      })(),
      {
        model: {} as never,
        runtimeModel: FAKE_RESOLVED.runtimeModel,
        addPromptText: vi.fn(),
        addPartialOutput: vi.fn(),
        recordUsage: vi.fn(),
        settle: vi.fn(),
        fail: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
      },
      lifecycle.signal,
      { onCancel },
    );

    const reader = stream.getReader();
    await reader.read();

    const cancelPromise = reader.cancel();
    await Promise.resolve();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(lifecycle.isCancelled()).toBe(true);
    expect(cleanupSettled).toBe(false);

    releaseCleanup();
    await cancelPromise;

    expect(cleanupSettled).toBe(true);
  });

  it('guards stream cleanup against duplicate settlement: an error fails once, a later cancel no-ops', async () => {
    const { createAIStreamLifecycle, streamTextWithAIUsageCleanup } = await loadAIUsageModule();
    const lifecycle = createAIStreamLifecycle();
    const settle = vi.fn().mockResolvedValue(undefined);

    const stream = streamTextWithAIUsageCleanup(
      (async function* () {
        yield 'first';
        throw new Error('stream failed after first chunk');
      })(),
      {
        model: {} as never,
        runtimeModel: FAKE_RESOLVED.runtimeModel,
        addPromptText: vi.fn(),
        addPartialOutput: vi.fn(),
        recordUsage: vi.fn(),
        settle,
        fail: vi.fn(),
        cancel: vi.fn(),
      },
      lifecycle.signal,
      { onCancel: lifecycle.cancel },
    );

    const reader = stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow('stream failed after first chunk');
    await reader.cancel().catch(() => undefined);

    // The stream error settled as `failed`; the subsequent cancel must not
    // double-settle (exactly-once at this layer).
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({ outcome: 'failed' });
  });

  it('classifies a stream throw after upstream abort as cancelled, not failed', async () => {
    const { createAIStreamLifecycle, streamTextWithAIUsageCleanup } = await loadAIUsageModule();
    const lifecycle = createAIStreamLifecycle();
    const settle = vi.fn().mockResolvedValue(undefined);
    const stream = streamTextWithAIUsageCleanup(
      (async function* () {
        yield 'first';
        lifecycle.cancel();
        throw new DOMException('aborted', 'AbortError');
      })(),
      {
        model: {} as never,
        runtimeModel: FAKE_RESOLVED.runtimeModel,
        addPromptText: vi.fn(),
        addPartialOutput: vi.fn(),
        recordUsage: vi.fn(),
        settle,
        fail: vi.fn(),
        cancel: vi.fn(),
      },
      lifecycle.signal,
    );

    const reader = stream.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({ outcome: 'cancelled' });
  });
});

describe('createStreamUsageCapture', () => {
  function makeUsage() {
    return {
      addPartialOutput: vi.fn(),
      settle: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('records usage once and surfaces text + finishReason via the framing promises', async () => {
    const { createStreamUsageCapture } = await loadAIUsageModule();
    const usage = makeUsage();
    const capture = createStreamUsageCapture(usage, { isCancelled: () => false });

    await capture.recordFinish({ text: 'hello world', usage: { outputTokens: 5 }, finishReason: 'length' });

    expect(usage.addPartialOutput).toHaveBeenCalledWith('hello world');
    expect(usage.settle).toHaveBeenCalledWith({
      outcome: 'truncated',
      usage: { outputTokens: 5 },
      finishReason: 'length',
    });
    expect(await capture.framing.finalText).toBe('hello world');
    expect(await capture.framing.finishReason).toBe('length');
  });

  it('rejects finalText and fails usage when the provider errors before finishing (zero-delta hang guard)', async () => {
    const { createStreamUsageCapture } = await loadAIUsageModule();
    const usage = makeUsage();
    const capture = createStreamUsageCapture(usage, { isCancelled: () => false });
    const boom = new Error('provider exploded');

    capture.recordError(boom);

    await expect(capture.framing.finalText).rejects.toBe(boom);
    expect(await capture.framing.finishReason).toBe('error');
    expect(usage.settle).toHaveBeenCalledWith({
      outcome: 'failed',
      finishReason: 'error',
      errorKind: 'Error',
    });
  });

  it('does not double-settle usage when finish and a late error both fire', async () => {
    const { createStreamUsageCapture } = await loadAIUsageModule();
    const usage = makeUsage();
    const capture = createStreamUsageCapture(usage, { isCancelled: () => false });

    await capture.recordFinish({ text: 'done', usage: { outputTokens: 3 }, finishReason: 'stop' });
    capture.recordError(new Error('late error'));

    expect(usage.settle).toHaveBeenCalledTimes(1);
  });

  it('records a cancelled run (with usage) when the lifecycle was cancelled, and still settles finalText', async () => {
    const { createStreamUsageCapture } = await loadAIUsageModule();
    const usage = makeUsage();
    const capture = createStreamUsageCapture(usage, { isCancelled: () => true });

    await capture.recordFinish({ text: 'partial', usage: { outputTokens: 4 }, finishReason: 'stop' });

    // AI-01: a cancelled finish is settled as `cancelled` (not dropped, not
    // `success`), carrying the reported usage so its tokens/cost are attributed.
    expect(usage.settle).toHaveBeenCalledWith({
      outcome: 'cancelled',
      usage: { outputTokens: 4 },
      finishReason: 'stop',
    });
    expect(await capture.framing.finalText).toBe('partial');
  });

  it('classifies an error callback after cancellation as cancelled', async () => {
    const { createStreamUsageCapture } = await loadAIUsageModule();
    const usage = makeUsage();
    const capture = createStreamUsageCapture(usage, { isCancelled: () => true });
    const abortError = new DOMException('aborted', 'AbortError');

    capture.recordError(abortError);

    await expect(capture.framing.finalText).rejects.toBe(abortError);
    expect(usage.settle).toHaveBeenCalledWith({
      outcome: 'cancelled',
      finishReason: 'error',
      errorKind: 'AbortError',
    });
  });

  it('abandon settles the finishReason promise so a sync streamText throw cannot hang a consumer', async () => {
    const { createStreamUsageCapture } = await loadAIUsageModule();
    const capture = createStreamUsageCapture(makeUsage(), { isCancelled: () => false });

    capture.abandon();

    expect(await capture.framing.finishReason).toBeUndefined();
  });
});

describe('UserOwnedAIUsageSession terminal outcomes (AI-01)', () => {
  // operation 'chapter' → role 'draft'; a matching x-im-role + x-im-kind header
  // makes the session a remote 'provider' call so cost is exercised.
  function remoteReq() {
    return new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'x-im-role': 'draft', 'x-im-kind': 'provider' },
    });
  }

  async function newSession(): Promise<import('./ai-usage').AIUsageSession> {
    resolveModelForRole.mockResolvedValueOnce({
      ...FAKE_RESOLVED,
      runtimeModel: { ...FAKE_RESOLVED.runtimeModel, providerId: 'openai', model: 'gpt-x' },
    });
    const createAIUsageSession = await loadCreateAIUsageSession();
    return createAIUsageSession(remoteReq(), { userId: 'user-1', operation: 'chapter' });
  }

  const lastRow = () => capturedRuns[capturedRuns.length - 1]?.row;

  it('records a user cancel as cancelled — not failed — and still costs reported tokens', async () => {
    const session = await newSession();
    await session.settle({ outcome: 'cancelled', usage: { inputTokens: 100, outputTokens: 1_000_000 } });
    expect(capturedRuns).toHaveLength(1);
    expect(lastRow().outcome).toBe('cancelled');
    // 1e6 output tokens * $2/Mtok + 100 input * $1/Mtok ≈ 2.0001.
    expect(lastRow().estCostUsd as number).toBeCloseTo(2.0001, 3);
  });

  it('records a length finishReason as truncated with cost', async () => {
    const session = await newSession();
    await session.settle({ outcome: 'truncated', usage: { inputTokens: 0, outputTokens: 500_000 }, finishReason: 'length' });
    expect(lastRow().outcome).toBe('truncated');
    expect(lastRow().estCostUsd as number).toBeCloseTo(1.0, 3);
  });

  it('records a normal stop as success', async () => {
    const session = await newSession();
    await session.settle({ outcome: 'success', usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' });
    expect(lastRow().outcome).toBe('success');
  });

  it('records a provider error as failed', async () => {
    const session = await newSession();
    await session.settle({ outcome: 'failed', errorKind: 'provider_error' });
    expect(lastRow().outcome).toBe('failed');
  });

  it('settles exactly once — a later fail after a cancel writes no second row', async () => {
    const session = await newSession();
    await session.settle({ outcome: 'cancelled', usage: { outputTokens: 10 } });
    await session.settle({ outcome: 'failed' });
    await session.settle({ outcome: 'success', usage: { outputTokens: 10 }, finishReason: 'stop' });
    expect(capturedRuns).toHaveLength(1);
    expect(lastRow().outcome).toBe('cancelled');
  });
});
