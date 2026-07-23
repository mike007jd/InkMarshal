// Phase 3 — StartWriting use case. Focused on the NEW behaviour the extraction
// introduced: writing_jobs terminal-status mapping + per-chapter progress.
// The orchestration itself is copied verbatim from the old route and its hard
// invariants are covered by writing-orchestrator.test.ts; here we mock the heavy
// collaborators and assert the job/sink wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartWritingContext } from '@/lib/writing/start-writing-usecase';
import type { WritingEventSink } from '@/lib/writing/ndjson-sink';

const steps = vi.hoisted(() => ({
  loadOrGenerateBlueprint: vi.fn(),
  maybeRunVolumeSummary: vi.fn(async () => {}),
  runSummarize: vi.fn(),
  runValidate: vi.fn(),
  runRalphRevision: vi.fn(),
}));
const orch = vi.hoisted(() => ({ writeChapter: vi.fn() }));
const usage = vi.hoisted(() => ({
  createAIUsageSession: vi.fn(),
  aiUsageErrorResponse: vi.fn(() => null as Response | null),
}));
const db = vi.hoisted(() => ({
  completeWritingDraft: vi.fn(async () => ({ id: 'n1' })),
  getVolumeSummaries: vi.fn(async () => []),
  updateChapterMeta: vi.fn(async () => {}),
  updateNovel: vi.fn(async () => ({})),
  upsertChapter: vi.fn(async () => ({})),
}));
const ai = vi.hoisted(() => ({
  adaptiveDigestParams: vi.fn(() => ({ recentWindow: 2, tailCharsPerChapter: 1500, maxBatchChars: 80_000 })),
  buildRollingDigest: vi.fn(() => ({ earlierDigest: '', recentTails: '' })),
  getTargetWordsPerChapter: vi.fn(() => 800),
  selectChapterPlansToWrite: vi.fn((chapters: unknown[]) => chapters),
  streamChapter: vi.fn(),
  streamChapterContinuation: vi.fn(),
}));

vi.mock('@/lib/writing/start-writing-steps', () => steps);
vi.mock('@/lib/writing-orchestrator', () => orch);
vi.mock('@/lib/db', () => db);
vi.mock('@/lib/ai', () => ai);
vi.mock('@/lib/ai-usage', () => ({
  createAIUsageSession: usage.createAIUsageSession,
  aiUsageErrorResponse: usage.aiUsageErrorResponse,
}));

function blueprint(chapterCount: number) {
  return {
    chapters: Array.from({ length: chapterCount }, (_, i) => ({ chapterNumber: i + 1, title: `C${i + 1}` })),
    targetWordsPerChapter: 800,
    generatedAt: '',
    modelId: 'm',
  };
}

function writtenOutcome(chapterNumber: number) {
  return {
    status: 'written',
    content: 'body',
    actualWords: 800,
    attempts: 1,
    qualityIssues: null,
    ralphRevisions: 0,
    summary: 's',
    keyFacts: null,
    generationMeta: {},
    savedChapter: { chapterNumber, title: `C${chapterNumber}`, content: 'body' },
  };
}

function makeCtx(overrides: Partial<StartWritingContext> = {}): {
  ctx: StartWritingContext;
  jobs: { bumpProgress: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn> };
  sink: WritingEventSink & { emit: ReturnType<typeof vi.fn> };
} {
  const jobs = { bumpProgress: vi.fn(), finalize: vi.fn(() => ({ id: 'n1' })) };
  const sink = { emit: vi.fn(), isClosed: () => false };
  const ctx = {
    novelId: 'n1',
    userId: 'u1',
    novel: { stage: 'ready_for_greenlight', targetWords: 80_000, title: 'T', genre: 'F' },
    request: new Request('http://x'),
    systemPrompt: 'sys',
    knowledgeSummaries: 'kn',
    language: 'en',
    chapterPreset: {},
    existingChapters: [],
    messageCount: 0,
    chaptersLimit: 1,
    untilChapter: null,
    requestStartedAt: 0,
    lifecycle: { signal: { aborted: false }, isCancelled: () => false, cancel: vi.fn() },
    lease: {
      renew: vi.fn(async () => true),
      renewQuietly: vi.fn(),
      hasLost: vi.fn(() => false),
      release: vi.fn(async () => {}),
    },
    jobs,
    log: vi.fn(),
    ...overrides,
  } as unknown as StartWritingContext;
  return { ctx, jobs, sink };
}

function expectFinalized(
  jobs: { finalize: ReturnType<typeof vi.fn> },
  status: string,
  reason: string,
  error: string | null,
  novelUpdate?: Record<string, unknown>,
) {
  const call = jobs.finalize.mock.calls.at(-1);
  expect(call?.slice(0, 3)).toEqual([status, reason, error]);
  if (novelUpdate) expect(call?.[3]).toMatchObject(novelUpdate);
}

beforeEach(() => {
  vi.clearAllMocks();
  db.updateNovel.mockReset().mockResolvedValue({});
  steps.maybeRunVolumeSummary.mockResolvedValue(undefined);
  db.completeWritingDraft.mockResolvedValue({ id: 'n1' });
  db.getVolumeSummaries.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executeStartWriting — writing_jobs wiring', () => {
  it('finalizes the job as completed when the whole book is written', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockResolvedValue(writtenOutcome(1));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();

    await executeStartWriting(ctx, sink);

    expect(jobs.bumpProgress).toHaveBeenCalledWith(1, 1);
    expectFinalized(jobs, 'completed', 'complete', null, {
      stage: 'whole_book_unification', progress: 100,
    });
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
    const doneCall = sink.emit.mock.calls.findIndex(([frame]) => frame.type === 'done');
    expect(jobs.finalize.mock.invocationCallOrder[0])
      .toBeLessThan(sink.emit.mock.invocationCallOrder[doneCall]);
  });

  it('never demotes a completed draft when job finalization throws', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockResolvedValue(writtenOutcome(1));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();
    jobs.finalize.mockImplementation(() => { throw new Error('job db unavailable'); });

    await executeStartWriting(ctx, sink);

    expect(db.completeWritingDraft).not.toHaveBeenCalled();
    expect(jobs.finalize).toHaveBeenCalledTimes(1);
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
    expect(sink.emit).toHaveBeenCalledWith({
      type: 'error',
      error: 'The full draft was saved, but its writing run could not be finalized. Please retry.',
    });
  });

  it('finalizes the job as paused at a batch boundary', async () => {
    // 2-chapter blueprint, chaptersLimit=1 → write ch1, stop before ch2.
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(2));
    orch.writeChapter.mockResolvedValue(writtenOutcome(1));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx({ chaptersLimit: 1 });

    await executeStartWriting(ctx, sink);

    expect(orch.writeChapter).toHaveBeenCalledTimes(1);
    expect(jobs.bumpProgress).toHaveBeenCalledWith(1, 1);
    expectFinalized(jobs, 'paused', 'batch_complete', null, {
      stage: 'autonomous_writing', progress: 52,
    });
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'batch_done' }));
    const batchDoneCall = sink.emit.mock.calls.findIndex(([frame]) => frame.type === 'batch_done');
    expect(jobs.finalize.mock.invocationCallOrder[0])
      .toBeLessThan(sink.emit.mock.invocationCallOrder[batchDoneCall]);
  });

  it('keeps a batch boundary truthful when job finalization throws', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(2));
    orch.writeChapter.mockResolvedValue(writtenOutcome(1));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx({ chaptersLimit: 1 });
    jobs.finalize.mockImplementation(() => { throw new Error('job db unavailable'); });

    await executeStartWriting(ctx, sink);

    expect(jobs.finalize).toHaveBeenCalledTimes(1);
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'batch_done' }));
    expect(sink.emit).toHaveBeenCalledWith({
      type: 'error',
      error: 'The chapter was saved, but this writing run could not be finalized. Please retry.',
    });
  });

  it('finalizes the job as failed and stops on a writeChapter error', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockRejectedValue(new Error('boom'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).toHaveBeenNthCalledWith(1, 'n1', { stage: 'autonomous_writing', progress: 5 });
    expect(db.updateNovel).not.toHaveBeenCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expectFinalized(jobs, 'failed', 'error', 'boom', {
      stage: 'autonomous_writing', progress: 15,
    });
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'phase', phase: 'failed', progress: 15 }));
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(sink.emit.mock.calls.filter(([frame]) => frame.type === 'error')).toHaveLength(1);
    expect(sink.emit.mock.calls.filter(([frame]) => frame.type === 'phase' && frame.phase === 'failed')).toHaveLength(1);
    expect(jobs.finalize).toHaveBeenCalledTimes(1);
    const terminalEmit = sink.emit.mock.calls.findIndex(([frame]) => frame.type === 'error');
    expect(jobs.finalize.mock.invocationCallOrder[0])
      .toBeLessThan(sink.emit.mock.invocationCallOrder[terminalEmit]);
  });

  it('persists and finalizes before exposing an AI usage setup failure exactly once', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    usage.createAIUsageSession.mockRejectedValueOnce(new Error('raw quota failure'));
    usage.aiUsageErrorResponse.mockReturnValueOnce(new Response(JSON.stringify({ error: 'Chapter quota denied' })));
    orch.writeChapter.mockImplementationOnce(async (deps: { createChapterUsage: () => Promise<unknown> }) => {
      await deps.createChapterUsage();
    });
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();

    await executeStartWriting(ctx, sink);

    expect(jobs.finalize).toHaveBeenCalledOnce();
    expectFinalized(jobs, 'failed', 'error', 'Chapter quota denied', {
      stage: 'autonomous_writing', progress: 15,
    });
    expect(sink.emit.mock.calls.filter(([frame]) => frame.type === 'error')).toHaveLength(1);
    expect(sink.emit).toHaveBeenCalledWith({ type: 'error', error: 'Chapter quota denied' });
    const finalizeOrder = jobs.finalize.mock.invocationCallOrder[0];
    const terminalEmit = sink.emit.mock.calls.findIndex(([frame]) => frame.type === 'error');
    expect(finalizeOrder).toBeLessThan(sink.emit.mock.invocationCallOrder[terminalEmit]);
  });

  it('keeps an empty chapter as one failed terminal instead of rewriting it as a batch pause', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    const emptyError = 'Chapter 1 failed: the model produced no usable content (0 words); writing was aborted.';
    orch.writeChapter.mockResolvedValue({ status: 'empty', errorMessage: emptyError });
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();

    await executeStartWriting(ctx, sink);

    expectFinalized(jobs, 'failed', 'error', emptyError, {
      stage: 'autonomous_writing', progress: 15,
    });
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'batch_done' }));
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'phase', phase: 'paused' }));
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'phase', phase: 'failed' }));
    expect(sink.emit).toHaveBeenCalledWith({ type: 'error', error: emptyError });
    expect(sink.emit.mock.calls.filter(([frame]) => frame.type === 'error')).toHaveLength(1);
    expect(sink.emit.mock.calls.filter(([frame]) => frame.type === 'phase' && frame.phase === 'failed')).toHaveLength(1);
    expect(jobs.finalize).toHaveBeenCalledTimes(1);
    const finalizeOrder = jobs.finalize.mock.invocationCallOrder[0];
    const terminalEmit = sink.emit.mock.calls.findIndex(([frame]) => frame.type === 'error');
    expect(finalizeOrder).toBeLessThan(sink.emit.mock.invocationCallOrder[terminalEmit]);
  });

  it('keeps a determined empty result failed when cancellation arrives concurrently', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    const emptyError = 'Chapter 1 failed: empty';
    orch.writeChapter.mockResolvedValue({ status: 'empty', errorMessage: emptyError });
    const isCancelled = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx({
      lifecycle: { signal: { aborted: false }, isCancelled, cancel: vi.fn() } as never,
    });

    await executeStartWriting(ctx, sink);

    expectFinalized(jobs, 'failed', 'error', emptyError);
    expect(sink.emit).toHaveBeenCalledWith({ type: 'error', error: emptyError });
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'phase', phase: 'paused' }));
  });

  it('does not bump progress and settles a lost lock as one durable failure', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();
    (ctx.lease.renew as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await executeStartWriting(ctx, sink);

    expect(orch.writeChapter).not.toHaveBeenCalled();
    expect(jobs.bumpProgress).not.toHaveBeenCalled();
    expectFinalized(jobs, 'failed', 'lock_failed', 'Writing lock lost (another session took over).', {
      stage: 'autonomous_writing', progress: 15,
    });
    expect(sink.emit.mock.calls.filter(([frame]) => frame.type === 'error')).toHaveLength(1);
    expect(sink.emit).toHaveBeenCalledWith({
      type: 'error',
      error: 'Writing lock lost (another session took over).',
    });
  });

  it('keeps a chapter saved before lock loss in progress without claiming post-processing completed', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockResolvedValue({
      ...writtenOutcome(1),
      status: 'lock_failed',
      errorMessage: 'Writing lock lost after saving the chapter.',
    });
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).toHaveBeenNthCalledWith(1, 'n1', { stage: 'autonomous_writing', progress: 5 });
    expect(db.updateNovel).toHaveBeenLastCalledWith('n1', { stage: 'autonomous_writing', progress: 90 });
    expect(db.updateNovel).not.toHaveBeenCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expect(jobs.bumpProgress).toHaveBeenCalledWith(1, 1);
    expectFinalized(jobs, 'failed', 'lock_failed', 'Writing lock lost after saving the chapter.', {
      stage: 'autonomous_writing', progress: 90,
    });
    expect(sink.emit.mock.calls.filter(([frame]) => frame.type === 'error')).toHaveLength(1);
    expect(sink.emit).toHaveBeenCalledWith({
      type: 'error',
      error: 'Writing lock lost after saving the chapter.',
    });
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chapter_done' }));
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('counts a saved chapter before failing on its usage record', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockResolvedValue({
      ...writtenOutcome(1),
      status: 'saved_failed',
      errorMessage: 'usage ledger unavailable',
    });
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();

    await executeStartWriting(ctx, sink);

    expect(jobs.bumpProgress).toHaveBeenCalledWith(1, 1);
    expect(db.updateNovel).toHaveBeenLastCalledWith('n1', { stage: 'autonomous_writing', progress: 90 });
    expectFinalized(jobs, 'failed', 'error', 'usage ledger unavailable', {
      stage: 'autonomous_writing', progress: 90,
    });
    expect(sink.emit).toHaveBeenCalledWith({ type: 'error', error: 'usage ledger unavailable' });
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chapter_done' }));
  });

  it('emits one truthful failure when the atomic terminal settlement fails', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockRejectedValue(new Error('generation exploded'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();
    jobs.finalize.mockImplementation(() => { throw new Error('disk unavailable'); });

    await executeStartWriting(ctx, sink);

    expect(jobs.finalize).toHaveBeenCalledOnce();
    expect(sink.emit.mock.calls.filter(([frame]) => frame.type === 'error')).toHaveLength(1);
    expect(sink.emit).toHaveBeenCalledWith({
      type: 'error',
      error: 'Writing failed and its terminal state could not be saved. Please retry.',
    });
  });

  it('preserves approval and a resumable 5 percent state when blueprint generation is aborted', async () => {
    steps.loadOrGenerateBlueprint.mockRejectedValue(new Error('aborted upstream'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const controller = new AbortController();
    controller.abort();
    const { ctx, jobs, sink } = makeCtx({
      lifecycle: { signal: controller.signal, isCancelled: () => true, cancel: vi.fn() },
    });

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).toHaveBeenNthCalledWith(1, 'n1', { stage: 'autonomous_writing', progress: 5 });
    expect(orch.writeChapter).not.toHaveBeenCalled();
    expectFinalized(jobs, 'paused', 'aborted', 'Writing stopped before any chapter was created.', {
      stage: 'autonomous_writing', progress: 5,
    });
  });

  it('does NOT demote an existing-chapter novel to greenlight when blueprint is aborted (resume)', async () => {
    // WR-01: `completedChapters` is still 0 during the blueprint stage, but this
    // novel already has chapters. A cold-abort must restore the pre-run
    // stage/progress, not roll it back to ready_for_greenlight/0.
    steps.loadOrGenerateBlueprint.mockRejectedValue(new Error('aborted upstream'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const controller = new AbortController();
    controller.abort();
    const { ctx, jobs, sink } = makeCtx({
      novel: { stage: 'autonomous_writing', progress: 45, targetWords: 80_000, title: 'T', genre: 'F' } as unknown as StartWritingContext['novel'],
      existingChapters: [{ chapterNumber: 1, title: 'C1', content: 'x' }] as unknown as StartWritingContext['existingChapters'],
      lifecycle: { signal: controller.signal, isCancelled: () => true, cancel: vi.fn() } as unknown as StartWritingContext['lifecycle'],
    });

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).toHaveBeenNthCalledWith(1, 'n1', { stage: 'autonomous_writing', progress: 5 });
    expect(db.updateNovel).not.toHaveBeenCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expect(orch.writeChapter).not.toHaveBeenCalled();
    expectFinalized(jobs, 'paused', 'aborted', 'Writing stopped before any chapter was created.', {
      stage: 'autonomous_writing', progress: 45,
    });
  });

  it('restores an existing-chapter novel to its pre-run stage/progress on a blueprint error (not cancelled)', async () => {
    steps.loadOrGenerateBlueprint.mockRejectedValue(new Error('blueprint model failed'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx({
      novel: { stage: 'whole_book_unification', progress: 100, targetWords: 80_000, title: 'T', genre: 'F' } as unknown as StartWritingContext['novel'],
      existingChapters: [{ chapterNumber: 1, title: 'C1', content: 'x' }] as unknown as StartWritingContext['existingChapters'],
    });

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).not.toHaveBeenCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expectFinalized(jobs, 'failed', 'error', 'blueprint model failed', {
      stage: 'whole_book_unification', progress: 100,
    });
  });

  it('keeps autonomous_writing + latestProgress on a pre-first-chapter error for a fresh approved run', async () => {
    steps.loadOrGenerateBlueprint.mockRejectedValue(new Error('blueprint boom'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx({
      novel: { stage: 'ready_for_greenlight', progress: 0, targetWords: 80_000, title: 'T', genre: 'F' } as unknown as StartWritingContext['novel'],
      existingChapters: [],
    });

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).toHaveBeenNthCalledWith(1, 'n1', { stage: 'autonomous_writing', progress: 5 });
    expect(db.updateNovel).not.toHaveBeenCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expectFinalized(jobs, 'failed', 'error', 'blueprint boom', {
      stage: 'autonomous_writing', progress: 5,
    });
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'phase', phase: 'failed', progress: 5 }));
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', error: expect.any(String) }));
  });

  it('records a disconnect (controller_closed) when the controller closes on the final send', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockResolvedValue(writtenOutcome(1));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs } = makeCtx();
    let closed = false;
    // The chapter_done enqueue is the one that fails when the client has gone:
    // there is no further loop-entry check to catch it, so the post-loop guard
    // must record the disconnect instead of letting it finalize as completed.
    const sink = {
      emit: vi.fn((frame: { type: string }) => {
        if (frame.type === 'chapter_done') closed = true;
      }),
      isClosed: () => closed,
    } as unknown as WritingEventSink;

    await executeStartWriting(ctx, sink);

    expectFinalized(jobs, 'paused', 'controller_closed', null, {
      stage: 'autonomous_writing', progress: 90,
    });
  });

  it('keeps a cold disconnect paused when its latest pause-state write fails', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();
    jobs.finalize.mockImplementation(() => { throw new Error('disk unavailable'); });
    sink.isClosed = () => true;

    await executeStartWriting(ctx, sink);

    expect(orch.writeChapter).not.toHaveBeenCalled();
    expectFinalized(jobs, 'paused', 'controller_closed', 'Writing stopped before any chapter was created because the client connection closed.');
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'phase', phase: 'failed' }));
  });
});
