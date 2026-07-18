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
  createAIUsageSession: vi.fn(),
  aiUsageErrorResponse: vi.fn(() => null),
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
  const jobs = { bumpProgress: vi.fn(), finalize: vi.fn() };
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
    lease: { renew: vi.fn(async () => true), renewQuietly: vi.fn(), release: vi.fn(async () => {}) },
    jobs,
    log: vi.fn(),
    ...overrides,
  } as unknown as StartWritingContext;
  return { ctx, jobs, sink };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(jobs.finalize).toHaveBeenCalledWith('completed', 'complete', null);
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
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
    expect(jobs.finalize).toHaveBeenCalledWith('paused', 'batch_complete', null);
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'batch_done' }));
  });

  it('finalizes the job as failed and stops on a writeChapter error', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockRejectedValue(new Error('boom'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();

    await executeStartWriting(ctx, sink);

    expect(jobs.finalize).toHaveBeenCalledWith('failed', 'error', 'boom');
    expect(sink.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('does not bump progress and finalizes paused when the lock is lost', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();
    (ctx.lease.renew as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    await executeStartWriting(ctx, sink);

    expect(orch.writeChapter).not.toHaveBeenCalled();
    expect(jobs.bumpProgress).not.toHaveBeenCalled();
    expect(db.updateNovel).toHaveBeenLastCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expect(jobs.finalize).toHaveBeenCalledWith(
      'paused',
      'lock_failed',
      'Writing stopped before any chapter was created because the writing lock was lost.',
    );
  });

  it('keeps a chapter saved before lock loss in progress without claiming post-processing completed', async () => {
    steps.loadOrGenerateBlueprint.mockResolvedValue(blueprint(1));
    orch.writeChapter.mockResolvedValue({
      ...writtenOutcome(1),
      status: 'lock_failed',
    });
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx();

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).toHaveBeenNthCalledWith(1, 'n1', { stage: 'autonomous_writing', progress: 5 });
    expect(db.updateNovel).toHaveBeenLastCalledWith('n1', { stage: 'autonomous_writing', progress: 90 });
    expect(db.updateNovel).not.toHaveBeenCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expect(jobs.bumpProgress).toHaveBeenCalledWith(1, 1);
    expect(jobs.finalize).toHaveBeenCalledWith('paused', 'lock_failed', null);
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chapter_done' }));
    expect(sink.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('resets the novel out of 5 percent drafting when blueprint generation is aborted', async () => {
    steps.loadOrGenerateBlueprint.mockRejectedValue(new Error('aborted upstream'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const controller = new AbortController();
    controller.abort();
    const { ctx, jobs, sink } = makeCtx({
      lifecycle: { signal: controller.signal, isCancelled: () => true, cancel: vi.fn() },
    });

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).toHaveBeenNthCalledWith(1, 'n1', { stage: 'autonomous_writing', progress: 5 });
    expect(db.updateNovel).toHaveBeenLastCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expect(orch.writeChapter).not.toHaveBeenCalled();
    expect(jobs.finalize).toHaveBeenCalledWith(
      'paused',
      'aborted',
      'Writing stopped before any chapter was created.',
    );
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
    expect(db.updateNovel).toHaveBeenLastCalledWith('n1', { stage: 'autonomous_writing', progress: 45 });
    expect(db.updateNovel).not.toHaveBeenCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expect(orch.writeChapter).not.toHaveBeenCalled();
  });

  it('restores an existing-chapter novel to its pre-run stage/progress on a blueprint error (not cancelled)', async () => {
    steps.loadOrGenerateBlueprint.mockRejectedValue(new Error('blueprint model failed'));
    const { executeStartWriting } = await import('@/lib/writing/start-writing-usecase');
    const { ctx, jobs, sink } = makeCtx({
      novel: { stage: 'whole_book_unification', progress: 100, targetWords: 80_000, title: 'T', genre: 'F' } as unknown as StartWritingContext['novel'],
      existingChapters: [{ chapterNumber: 1, title: 'C1', content: 'x' }] as unknown as StartWritingContext['existingChapters'],
    });

    await executeStartWriting(ctx, sink);

    expect(db.updateNovel).toHaveBeenLastCalledWith('n1', { stage: 'whole_book_unification', progress: 100 });
    expect(db.updateNovel).not.toHaveBeenCalledWith('n1', { stage: 'ready_for_greenlight', progress: 0 });
    expect(jobs.finalize).toHaveBeenCalledWith('failed', 'error', 'blueprint model failed');
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

    expect(jobs.finalize).toHaveBeenCalledWith('paused', 'controller_closed', null);
  });
});
