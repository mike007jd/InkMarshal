import { describe, expect, it, vi } from 'vitest';
import {
  writeChapter,
  type WriteChapterDeps,
  type WriteChapterInput,
  type WritingFrame,
  type SummarizeOutcome,
  type ValidateOutcome,
  type ReviseOutcome,
} from '@/lib/writing-orchestrator';
import type { ChapterBlueprint } from '@/lib/ai';
import type { Chapter } from '@/lib/db';

const PLAN: ChapterBlueprint = { chapterNumber: 1, title: 'Ch1', summary: 'beat' };

function stream(chunks: string[], finish: { finishReason?: string; usage?: { inputTokens?: number; outputTokens?: number } } = {}) {
  return (args: { onFinish: (f: { text?: string; usage?: unknown; finishReason?: string }) => void }) => {
    const text = chunks.join('');
    return {
      textStream: (async function* () {
        for (const c of chunks) yield c;
        args.onFinish({ text, usage: finish.usage, finishReason: finish.finishReason });
      })(),
    };
  };
}

function deferred(): SummarizeOutcome & ValidateOutcome {
  return {
    summary: 's',
    keyFacts: null,
    issues: null,
    score: 95,
    recordUsage: vi.fn(async () => {}),
    failUsage: vi.fn(async () => {}),
    cancelUsage: vi.fn(async () => {}),
  };
}

function fakeChapter(content: string): Chapter {
  return {
    id: 'c1', novelId: 'n1', chapterNumber: 1, title: 'Ch1', content,
    originalContent: null, wordCount: content.split(/\s+/).length, version: 1,
    summary: '', keyFacts: null, qualityIssues: null, generationMeta: null, createdAt: 0,
  };
}

interface Harness {
  deps: WriteChapterDeps;
  frames: WritingFrame[];
  order: string[];
  recordUsage: ReturnType<typeof vi.fn>;
  fail: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  upsertChapter: ReturnType<typeof vi.fn>;
  streamChapterContinuation: ReturnType<typeof vi.fn>;
  revise: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<WriteChapterDeps> = {}, opts: {
  draftChunks?: string[];
  draftFinish?: { finishReason?: string };
  continuationChunks?: string[];
  continuationFinish?: { finishReason?: string };
  validate?: () => ValidateOutcome;
  revise?: () => ReviseOutcome;
  renewLock?: () => Promise<boolean>;
} = {}): Harness {
  const frames: WritingFrame[] = [];
  const order: string[] = [];
  const recordUsage = vi.fn(async () => { order.push('recordUsage'); });
  const fail = vi.fn(async () => { order.push('fail'); });
  const cancel = vi.fn(async () => { order.push('cancel'); });
  const upsertChapter = vi.fn(async (_n: number, _t: string, content: string) => {
    order.push('upsertChapter');
    return fakeChapter(content);
  });
  const streamChapterContinuation = vi.fn(stream(opts.continuationChunks ?? [''], opts.continuationFinish));
  const revise = vi.fn(async () => opts.revise?.() ?? { content: 'revised', recordUsage: vi.fn(async () => {}), failUsage: vi.fn(async () => {}), cancelUsage: vi.fn(async () => {}) });

  const deps: WriteChapterDeps = {
    createChapterUsage: async () => ({
      model: {} as never,
      runtimeModel: { id: 'm1' } as never,
      addPromptText: vi.fn(),
      addPartialOutput: vi.fn(),
      recordUsage,
      settle: vi.fn(async () => {}),
      fail,
      cancel,
    }),
    streamChapter: stream(opts.draftChunks ?? ['the quick brown fox jumps over the lazy dog and then keeps on running through the open field '], opts.draftFinish) as WriteChapterDeps['streamChapter'],
    streamChapterContinuation: streamChapterContinuation as WriteChapterDeps['streamChapterContinuation'],
    summarize: async () => deferred(),
    validate: async () => (opts.validate ? opts.validate() : deferred()),
    revise,
    upsertChapter,
    updateChapterMeta: vi.fn(async () => { order.push('updateChapterMeta'); }),
    renewLock: opts.renewLock ?? (async () => true),
    emit: f => frames.push(f),
    isCancelled: () => false,
    isAborted: () => false,
    log: vi.fn(),
    ...overrides,
  };
  return { deps, frames, order, recordUsage, fail, cancel, upsertChapter, streamChapterContinuation, revise };
}

const input = (over: Partial<WriteChapterInput> = {}): WriteChapterInput => ({
  plan: PLAN,
  targetWordsPerChapter: 4,
  language: 'en',
  earlierDigest: 'digest',
  recentTails: 'tails',
  progress: 50,
  ...over,
});

describe('writeChapter', () => {
  it('records chapter usage only AFTER the chapter is persisted', async () => {
    const h = harness();
    const outcome = await writeChapter(h.deps, input());

    expect(outcome.status).toBe('written');
    // recordUsage must come strictly after upsertChapter.
    expect(h.order.indexOf('recordUsage')).toBeGreaterThan(h.order.indexOf('upsertChapter'));
    expect(h.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('returns the saved chapter when usage recording fails after persistence', async () => {
    const h = harness();
    h.recordUsage.mockRejectedValueOnce(new Error('usage ledger unavailable'));

    const outcome = await writeChapter(h.deps, input());

    expect(outcome.status).toBe('saved_failed');
    expect(outcome.savedChapter).not.toBeNull();
    expect(outcome.errorMessage).toBe('usage ledger unavailable');
    expect(h.upsertChapter).toHaveBeenCalledTimes(1);
    expect(h.frames.some(frame => frame.type === 'chapter_done')).toBe(false);
    expect(h.frames.some(frame => frame.type === 'error')).toBe(false);
  });

  it.each(['summarize', 'validate'] as const)(
    'returns saved_failed after a deferred %s usage settlement fails',
    async failingPhase => {
      const failedRecordUsage = vi.fn(async () => {
        throw new Error(`${failingPhase} usage ledger unavailable`);
      });
      const failedFailUsage = vi.fn(async () => {});
      const healthyRecordUsage = vi.fn(async () => {});
      const failedUsage = {
        ...deferred(),
        recordUsage: failedRecordUsage,
        failUsage: failedFailUsage,
      };
      const healthyUsage = {
        ...deferred(),
        recordUsage: healthyRecordUsage,
      };
      const h = harness({
        summarize: async () => failingPhase === 'summarize' ? failedUsage : healthyUsage,
        validate: async () => failingPhase === 'validate' ? failedUsage : healthyUsage,
      });

      const outcome = await writeChapter(h.deps, input());

      expect(outcome.status).toBe('saved_failed');
      expect(outcome.savedChapter).not.toBeNull();
      expect(outcome.summary).toBe('s');
      expect(outcome.errorMessage).toBe(`${failingPhase} usage ledger unavailable`);
      expect(failedRecordUsage).toHaveBeenCalledTimes(1);
      expect(failedFailUsage).toHaveBeenCalledTimes(1);
      expect(healthyRecordUsage).toHaveBeenCalledTimes(1);
      expect(h.frames.some(frame => frame.type === 'chapter_done')).toBe(false);
      expect(h.frames.some(frame => frame.type === 'error')).toBe(false);
    },
  );

  it('returns saved_failed when deferred Ralph usage settlement fails', async () => {
    const ralphRecordUsage = vi.fn(async () => {
      throw new Error('Ralph usage ledger unavailable');
    });
    const ralphFailUsage = vi.fn(async () => {});
    const summarizeRecordUsage = vi.fn(async () => {});
    const validateRecordUsage = vi.fn(async () => {});
    const draft = 'one two three four five six seven eight nine ten';
    const h = harness({
      summarize: async () => ({ ...deferred(), recordUsage: summarizeRecordUsage }),
    }, {
      draftChunks: [draft],
      validate: () => ({
        ...deferred(),
        issues: [{ type: 'pov', description: 'x', severity: 'major' }],
        score: 50,
        recordUsage: validateRecordUsage,
      }),
      revise: () => ({
        content: 'too short',
        recordUsage: ralphRecordUsage,
        failUsage: ralphFailUsage,
        cancelUsage: vi.fn(async () => {}),
      }),
    });

    const outcome = await writeChapter(h.deps, input({ targetWordsPerChapter: 10 }));

    expect(outcome.status).toBe('saved_failed');
    expect(outcome.savedChapter).not.toBeNull();
    expect(outcome.content).toBe(draft);
    expect(outcome.errorMessage).toBe('Ralph usage ledger unavailable');
    expect(ralphRecordUsage).toHaveBeenCalledTimes(1);
    expect(ralphFailUsage).toHaveBeenCalledTimes(1);
    expect(summarizeRecordUsage).toHaveBeenCalledTimes(1);
    expect(validateRecordUsage).toHaveBeenCalledTimes(1);
  });

  it('settles the chapter run as cancelled (not failed) when the user stops mid-generation', async () => {
    // AI-01: a Stop during generation must record `cancelled`, exactly once,
    // and must not be logged as a provider failure.
    const h = harness({ isCancelled: () => true });
    const outcome = await writeChapter(h.deps, input());

    expect(outcome.status).toBe('aborted');
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('settles an AbortError thrown after Stop as cancelled', async () => {
    let cancelled = false;
    const h = harness({
      isCancelled: () => cancelled,
      isAborted: () => cancelled,
      streamChapter: (() => ({
        textStream: (async function* () {
          yield 'partial prose';
          cancelled = true;
          throw new DOMException('aborted', 'AbortError');
        })(),
      })) as WriteChapterDeps['streamChapter'],
    });

    const outcome = await writeChapter(h.deps, input());

    expect(outcome.status).toBe('aborted');
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('runs exactly one continuation pass when the draft was cut off at the cap (finishReason=length)', async () => {
    // First draft ends with finishReason 'length'; the continuation finishes 'stop'.
    // Content is long enough to clear EMPTY_CHAPTER_WORD_FLOOR after the merge.
    const h = harness({}, {
      draftChunks: ['short draft text here with enough words to clear the floor'],
      draftFinish: { finishReason: 'length' },
      continuationChunks: ['more text here words to finish the chapter properly'],
      continuationFinish: { finishReason: 'stop' },
    });

    const outcome = await writeChapter(h.deps, input({ targetWordsPerChapter: 4 }));

    expect(h.streamChapterContinuation).toHaveBeenCalledTimes(1);
    expect(outcome.content).toContain('short draft text');
    expect(outcome.content).toContain('more text here words');
    expect(outcome.attempts).toBe(2);
  });

  it('discards a Ralph revision shorter than 0.8× the draft and keeps the original', async () => {
    // Draft = 10 words; validation triggers Ralph; revision returns 2 words (<0.8×10=8).
    const draft = 'one two three four five six seven eight nine ten';
    const h = harness({}, {
      draftChunks: [draft],
      validate: () => ({ issues: [{ type: 'pov', description: 'x', severity: 'major' }], score: 50, recordUsage: vi.fn(async () => {}), failUsage: vi.fn(async () => {}), cancelUsage: vi.fn(async () => {}) }),
      revise: () => ({ content: 'too short', recordUsage: vi.fn(async () => {}), failUsage: vi.fn(async () => {}), cancelUsage: vi.fn(async () => {}) }),
    });

    const outcome = await writeChapter(h.deps, input({ targetWordsPerChapter: 10 }));

    // Original draft kept; the revision was NOT persisted.
    expect(outcome.content).toBe(draft);
    expect(outcome.ralphRevisions).toBe(0);
    expect(h.upsertChapter).toHaveBeenCalledTimes(1); // only the original
    expect(outcome.qualityIssues?.some(i => i.description.includes('materially shorter'))).toBe(true);
  });

  it('accepts a full-length Ralph revision and re-persists it', async () => {
    const draft = 'one two three four five six seven eight nine ten';
    const revised = 'one two three four five six seven eight nine ten eleven twelve';
    const h = harness({}, {
      draftChunks: [draft],
      validate: () => ({ issues: [{ type: 'pov', description: 'x', severity: 'major' }], score: 50, recordUsage: vi.fn(async () => {}), failUsage: vi.fn(async () => {}), cancelUsage: vi.fn(async () => {}) }),
      revise: () => ({ content: revised, recordUsage: vi.fn(async () => {}), failUsage: vi.fn(async () => {}), cancelUsage: vi.fn(async () => {}) }),
    });

    const outcome = await writeChapter(h.deps, input({ targetWordsPerChapter: 10 }));

    expect(outcome.content).toBe(revised);
    expect(outcome.ralphRevisions).toBe(1);
    expect(h.upsertChapter).toHaveBeenCalledTimes(2); // original + revision
  });

  it('returns lock_failed for the batch owner to emit after persistence', async () => {
    const h = harness({}, { renewLock: async () => false });
    const outcome = await writeChapter(h.deps, input());

    expect(outcome.status).toBe('lock_failed');
    expect(outcome.errorMessage).toBe('Writing lock lost after saving the chapter.');
    expect(h.frames.some(f => f.type === 'error')).toBe(false);
    expect(h.frames.some(f => f.type === 'chapter_done')).toBe(false);
  });

  it('returns empty with the terminal error for the batch owner to emit after persistence', async () => {
    // Draft + all 3 continuation passes return empty → below EMPTY_CHAPTER_WORD_FLOOR.
    // This is the fake-success guard: an empty result must never be persisted as
    // 'written', advance the batch, or bill usage. It must fail honestly.
    const h = harness({}, {
      draftChunks: [''],
      continuationChunks: [''],
    });
    const outcome = await writeChapter(h.deps, input({ targetWordsPerChapter: 800 }));

    expect(outcome.status).toBe('empty');
    expect(outcome.actualWords).toBe(0);
    // Never persisted, never billed for content the user never received.
    expect(h.upsertChapter).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(outcome.errorMessage).toBe(
      'Chapter 1 failed: the model produced no usable content (0 words); writing was aborted.',
    );
    // Terminal emission belongs to the batch owner after durable state/job
    // persistence; the chapter engine never races that ordering.
    expect(h.frames.some(f => f.type === 'error')).toBe(false);
    expect(h.frames.some(f => f.type === 'chapter_done')).toBe(false);
  });

  it('emits writing frames as prose streams in', async () => {
    const h = harness({}, { draftChunks: ['alpha ', 'beta ', 'gamma delta'] });
    await writeChapter(h.deps, input());
    const writing = h.frames.filter(f => f.type === 'writing');
    expect(writing.map(f => (f as { chunk: string }).chunk)).toEqual(['alpha ', 'beta ', 'gamma delta']);
  });
});
