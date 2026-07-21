// Autonomous-writing per-chapter engine, extracted from the start-writing route
// so the core loop is unit-testable in isolation. Every external effect — AI
// calls, db writes, lock renewal, frame emission, cancellation — is injected via
// `WriteChapterDeps`, so a test drives the exact same code the route runs with
// plain mock functions (no module mocking, no real model).
//
// The route keeps ownership of batch-level state (which chapters to write,
// digest/volume bookkeeping, blueprint, finalization); this module owns ONE
// chapter end-to-end: draft → length-continuation → persist → record usage →
// validate → Ralph revision → metadata.

import { countWords, sanitizeError } from '@/lib/utils';
import { isZhLocale, type Locale } from '@/lib/i18n';
import { ensureLengthIssue, minimumRetryWords } from '@/lib/start-writing-quality';
import {
  formatRalphRevisionBrief,
  RALPH_LOOP_MAX_REVISIONS,
  shouldReviseChapterInRalphLoop,
} from '@/lib/ralph-writing-loop';
import { createFinalTextCapture, textStreamWithFinalTextFallback } from '@/lib/streaming-helpers';
import { START_WRITING_EVENTS } from '@/lib/start-writing-logging';
import type { ChapterBlueprint } from '@/lib/ai';
import type {
  Chapter,
  ChapterGenerationMeta,
  ChapterKeyFacts,
  ChapterQualityIssue,
  NovelBlueprint,
} from '@/lib/db';
import type { AIUsageSession } from '@/lib/ai-usage';

// ── Tuning constants (were inline in the route) ─────────────────────────────
// Bound the per-chapter continuation passes that finish an under-length or
// cap-truncated draft. 3 covers the realistic worst case without unbounded spend.
export const MAX_CHAPTER_CONTINUATION_PASSES = 3;
// Minimum extra words to request when a chapter was cut off at the output-token
// ceiling (finishReason='length') but still cleared the length floor.
export const CAP_TRUNCATION_EXTRA_WORDS = 800;
// Ralph revisions must return the full chapter. Discard a revision under this
// fraction of the pre-revision word count — a truncated "fix" would otherwise
// overwrite the good draft with an unrecoverable stub.
export const RALPH_MIN_RETAINED_RATIO = 0.8;
// Absolute floor below which a "written" chapter is treated as a failed
// generation, not a real chapter. A genuine chapter is always far above this;
// only a model that returned empty/refusal/garbage (after all continuation
// passes) lands here. Persisting such a result as `status: 'written'` would be
// a fake-success bug — an empty chapter committed, the batch advanced, and
// usage billed for content the user never received. Instead we surface a hard
// failure (status 'empty') that stops the batch, mirroring `lock_failed`.
export const EMPTY_CHAPTER_WORD_FLOOR = 10;

// ── Wire protocol ───────────────────────────────────────────────────────────
/** The NDJSON frames the writing stream emits. Typed so the server `send` and
 *  the client reducer (lib/writing-session.ts) share one definition. */
export type WritingPhase =
  | 'preparing'
  | 'planning'
  | 'drafting'
  | 'saving'
  | 'chapter_complete'
  | 'paused'
  | 'failed'
  | 'complete';

export type WritingFrame =
  | { type: 'heartbeat'; at?: string }
  | {
      type: 'phase';
      phase: WritingPhase;
      message: string;
      progress?: number;
      chapterNumber?: number;
      chapterTitle?: string;
      completedChapters?: number;
      totalChapters?: number;
    }
  | { type: 'progress'; progress: number; message: string }
  | { type: 'blueprint'; blueprint: NovelBlueprint; total: number }
  | { type: 'writing'; chapterNumber: number; chunk: string; title: string }
  | {
      type: 'chapter_done';
      chapterNumber: number;
      title: string;
      content: string;
      wordCount: number;
      qualityIssues: ChapterQualityIssue[] | null;
      ralphRevisions: number;
      progress: number;
      completedChapters: number;
      totalChapters: number;
    }
  | {
      type: 'batch_done';
      nextChapter: number | null;
      remaining: number;
      completedChapters: number;
      totalChapters: number;
    }
  | { type: 'done'; novel: unknown; message: string }
  | { type: 'error'; error: string };

// ── Injected dependency shapes ──────────────────────────────────────────────
interface StreamResult {
  textStream: AsyncIterable<string>;
}
interface StreamFinish {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
}
/** A deferred post-chapter AI side effect (summarize/validate/ralph) whose token
 *  usage is settled only after the chapter content is persisted. */
export interface DeferredUsage {
  recordUsage: () => Promise<void>;
  failUsage: () => Promise<void>;
  cancelUsage: () => Promise<void>;
}
export interface SummarizeOutcome extends DeferredUsage {
  summary: string;
  keyFacts: ChapterKeyFacts | null;
}
export interface ValidateOutcome extends DeferredUsage {
  issues: ChapterQualityIssue[] | null;
  score: number | null;
}
export interface ReviseOutcome extends DeferredUsage {
  content: string;
}

export interface WriteChapterDeps {
  /** Create the per-chapter draft usage session (model + token accounting). */
  createChapterUsage: () => Promise<AIUsageSession>;
  streamChapter: (args: {
    model: AIUsageSession['model'];
    blueprint: ChapterBlueprint;
    targetWordsPerChapter: number;
    recentChapterTails: string;
    earlierChapterDigest: string;
    onFinish: (f: StreamFinish) => void;
    onError: (e: { error: unknown }) => void;
  }) => StreamResult;
  streamChapterContinuation: (args: {
    model: AIUsageSession['model'];
    blueprint: ChapterBlueprint;
    existingContent: string;
    targetExtraWords: number;
    onFinish: (f: StreamFinish) => void;
    onError: (e: { error: unknown }) => void;
  }) => StreamResult;
  summarize: (input: { content: string; plan: ChapterBlueprint }) => Promise<SummarizeOutcome>;
  validate: (input: { content: string; previousFactsSummary: string }) => Promise<ValidateOutcome>;
  revise: (input: { content: string; plan: ChapterBlueprint; revisionBrief: string }) => Promise<ReviseOutcome>;
  upsertChapter: (chapterNumber: number, title: string, content: string) => Promise<Chapter>;
  updateChapterMeta: (
    chapterNumber: number,
    meta: {
      summary: string;
      keyFacts: ChapterKeyFacts | null;
      qualityIssues: ChapterQualityIssue[] | null;
      generationMeta: ChapterGenerationMeta;
    },
  ) => Promise<void>;
  /** Renew the writing lock; false ⇒ another session took over. */
  renewLock: () => Promise<boolean>;
  emit: (frame: WritingFrame) => void;
  isCancelled: () => boolean;
  isAborted: () => boolean;
  log: (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}

export interface WriteChapterInput {
  plan: ChapterBlueprint;
  targetWordsPerChapter: number;
  language: Locale;
  earlierDigest: string;
  recentTails: string;
  /** Progress percentage to attach to Ralph/degraded progress frames. */
  progress: number;
}

export type ChapterOutcomeStatus = 'written' | 'aborted' | 'lock_failed' | 'saved_failed' | 'empty';

export interface ChapterOutcome {
  status: ChapterOutcomeStatus;
  errorMessage: string | null;
  content: string;
  actualWords: number;
  attempts: number;
  qualityIssues: ChapterQualityIssue[] | null;
  ralphRevisions: number;
  summary: string;
  keyFacts: ChapterKeyFacts | null;
  generationMeta: ChapterGenerationMeta;
  savedChapter: Chapter | null;
}

/** Fail (settle-as-error) any post-chapter usage sessions that were created,
 *  ignoring ones whose creation rejected. Used on every abort/lock-loss path. */
async function failSettledUsages(...outcomes: PromiseSettledResult<DeferredUsage>[]): Promise<void> {
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') await outcome.value.failUsage();
  }
}

async function cancelSettledUsages(...outcomes: PromiseSettledResult<DeferredUsage>[]): Promise<void> {
  for (const outcome of outcomes) {
    if (outcome.status === 'fulfilled') await outcome.value.cancelUsage();
  }
}

/**
 * Write ONE chapter end-to-end. Emits `writing` chunks + Ralph `progress` frames
 * via `deps.emit`; the caller emits `chapter_done` from the returned outcome.
 *
 * Hard invariants (locked by writing-orchestrator.test.ts):
 *  - chapter usage is recorded ONLY after `upsertChapter` succeeds;
 *  - `finishReason === 'length'` triggers a bounded continuation pass;
 *  - a Ralph revision shorter than {@link RALPH_MIN_RETAINED_RATIO} of the
 *    pre-revision word count is discarded (the original draft is kept);
 *  - a lost lock returns status `'lock_failed'` (no chapter_done / done frame).
 */
export async function writeChapter(deps: WriteChapterDeps, input: WriteChapterInput): Promise<ChapterOutcome> {
  const { plan, targetWordsPerChapter, language } = input;
  const chapterUsage = await deps.createChapterUsage();

  let chapterContent = '';
  let chapterAttempts = 1;
  let aggregatedInputTokens = 0;
  let aggregatedOutputTokens = 0;
  let chapterUsageSettled = false;
  const settleChapterUsageOnce = async (run: () => Promise<void>) => {
    if (chapterUsageSettled) return;
    chapterUsageSettled = true;
    await run();
  };
  // Provider/stream error → failed. User Stop / abort → cancelled (AI-01), with
  // the tokens the provider reported before the cancel so the run is costed.
  const failChapterUsageOnce = () => settleChapterUsageOnce(() => chapterUsage.fail());
  const cancelChapterUsageOnce = () =>
    settleChapterUsageOnce(() =>
      chapterUsage.cancel({
        inputTokens: aggregatedInputTokens || undefined,
        outputTokens: aggregatedOutputTokens || undefined,
        totalTokens: aggregatedInputTokens + aggregatedOutputTokens || undefined,
      }),
    );

  const consumeProse = async (
    textStream: AsyncIterable<string>,
    finalText: Promise<string | null | undefined>,
  ) => {
    for await (const chunk of textStreamWithFinalTextFallback(textStream, { finalText })) {
      if (deps.isAborted()) break;
      chapterContent += chunk;
      deps.emit({ type: 'writing', chapterNumber: plan.chapterNumber, chunk, title: plan.title });
    }
  };
  const accumulateUsage = ({ usage }: { usage?: { inputTokens?: number; outputTokens?: number } }) => {
    if (usage) {
      aggregatedInputTokens += usage.inputTokens ?? 0;
      aggregatedOutputTokens += usage.outputTokens ?? 0;
    }
  };

  const aborted = (): ChapterOutcome => buildOutcome('aborted');
  function buildOutcome(status: ChapterOutcomeStatus, over: Partial<ChapterOutcome> = {}): ChapterOutcome {
    return {
      status,
      errorMessage: null,
      content: chapterContent,
      actualWords: countWords(chapterContent),
      attempts: chapterAttempts,
      qualityIssues: null,
      ralphRevisions: 0,
      summary: chapterContent.slice(-600).trim(),
      keyFacts: null,
      generationMeta: {
        targetWords: targetWordsPerChapter,
        actualWords: countWords(chapterContent),
        attempts: chapterAttempts,
        modelId: chapterUsage.runtimeModel.id,
        generatedAt: new Date().toISOString(),
      },
      savedChapter: null,
      ...over,
    };
  }

  let chapterFinishReason: string | undefined;
  try {
    const chapterFinalText = createFinalTextCapture();
    const chapterResult = deps.streamChapter({
      model: chapterUsage.model,
      blueprint: plan,
      targetWordsPerChapter,
      recentChapterTails: input.recentTails,
      earlierChapterDigest: input.earlierDigest,
      onFinish: ({ text, usage, finishReason }) => {
        chapterFinalText.resolve(text);
        chapterFinishReason = finishReason;
        accumulateUsage({ usage });
      },
      onError: ({ error }) => {
        chapterFinalText.reject(error);
      },
    });
    await consumeProse(chapterResult.textStream, chapterFinalText.promise);

    if (deps.isCancelled()) {
      chapterUsage.addPartialOutput(chapterContent);
      await cancelChapterUsageOnce();
      return aborted();
    }

    // Finish an incomplete chapter: under the length floor (model under-produced)
    // or finishReason==='length' (cut off at the output ceiling mid-scene).
    const minWords = minimumRetryWords(targetWordsPerChapter);
    for (let pass = 0; pass < MAX_CHAPTER_CONTINUATION_PASSES; pass++) {
      const words = countWords(chapterContent);
      const underLength = words < minWords;
      const cutOffAtCap = chapterFinishReason === 'length';
      if (!underLength && !cutOffAtCap) break;
      const targetExtraWords = Math.max(
        targetWordsPerChapter - words,
        cutOffAtCap ? CAP_TRUNCATION_EXTRA_WORDS : 0,
      );
      if (targetExtraWords <= 0) break;
      deps.log(START_WRITING_EVENTS.lengthRetry, {
        ch: plan.chapterNumber,
        actualWords: words,
        target: targetWordsPerChapter,
        extraTarget: targetExtraWords,
        reason: cutOffAtCap ? 'cap_truncation' : 'under_length',
      });
      chapterFinishReason = undefined;
      const continuationFinalText = createFinalTextCapture();
      const cont = deps.streamChapterContinuation({
        model: chapterUsage.model,
        blueprint: plan,
        existingContent: chapterContent,
        targetExtraWords,
        onFinish: ({ text, usage, finishReason }) => {
          continuationFinalText.resolve(text);
          chapterFinishReason = finishReason;
          accumulateUsage({ usage });
        },
        onError: ({ error }) => {
          continuationFinalText.reject(error);
        },
      });
      await consumeProse(cont.textStream, continuationFinalText.promise);
      chapterAttempts = pass + 2;
      if (deps.isCancelled()) break;
    }

    if (deps.isCancelled()) {
      chapterUsage.addPartialOutput(chapterContent);
      await cancelChapterUsageOnce();
      return aborted();
    }

    chapterUsage.addPartialOutput(chapterContent);
  } catch (error) {
    chapterUsage.addPartialOutput(chapterContent);
    if (deps.isCancelled()) {
      await cancelChapterUsageOnce();
      return aborted();
    }
    await failChapterUsageOnce();
    throw error;
  }

  if (deps.isCancelled()) {
    // Settle the primary chapter run exactly once so a Stop here isn't an orphan.
    await cancelChapterUsageOnce();
    return aborted();
  }

  let actualWords = countWords(chapterContent);
  const generationMeta: ChapterGenerationMeta = {
    targetWords: targetWordsPerChapter,
    actualWords,
    attempts: chapterAttempts,
    modelId: chapterUsage.runtimeModel.id,
    generatedAt: new Date().toISOString(),
  };

  // Non-triviality gate: if every generation + continuation pass still yielded
  // a (near-)empty chapter, the model failed to produce real content. Treating
  // this as `status: 'written'` would be fake-success — an empty chapter
  // persisted, the batch advanced, and usage billed for nothing. Instead fail
  // honestly: do NOT upsert, do NOT record usage, surface a hard error, and
  // stop the batch (the usecase maps 'empty' to a non-advancing break, like
  // 'lock_failed'). A 'minor' length flag is for under-target-but-real drafts;
  // a sub-floor result is a generation failure, not a cosmetic drift.
  if (actualWords < EMPTY_CHAPTER_WORD_FLOOR) {
    await failChapterUsageOnce();
    const errorMessage = isZhLocale(language)
      ? `第 ${plan.chapterNumber} 章生成失败：模型未产出有效内容（${actualWords} 字），已中止本次写作。`
      : `Chapter ${plan.chapterNumber} failed: the model produced no usable content (${actualWords} words); writing was aborted.`;
    // The batch use case owns terminal ordering. Returning the exact message
    // lets it persist novel + job truth before exposing the error frame, so the
    // client's single terminal refresh cannot observe a still-running job.
    return buildOutcome('empty', {
      content: chapterContent,
      actualWords,
      generationMeta,
      errorMessage,
    });
  }

  // CRITICAL: record usage strictly AFTER the chapter content is persisted, so a
  // failed write can't bill tokens for a chapter the user never received.
  let savedChapter: Chapter;
  try {
    savedChapter = await deps.upsertChapter(plan.chapterNumber, plan.title, chapterContent);
  } catch (error) {
    await failChapterUsageOnce();
    throw error;
  }
  try {
    await chapterUsage.recordUsage({
      inputTokens: aggregatedInputTokens || undefined,
      outputTokens: aggregatedOutputTokens || undefined,
      totalTokens: aggregatedInputTokens + aggregatedOutputTokens || undefined,
    });
    chapterUsageSettled = true;
  } catch (error) {
    await failChapterUsageOnce().catch(() => {});
    return buildOutcome('saved_failed', {
      content: chapterContent,
      actualWords,
      generationMeta,
      savedChapter,
      errorMessage: sanitizeError(error, 'The chapter was saved, but its usage record failed.'),
    });
  }

  if (!(await deps.renewLock())) {
    return buildOutcome('lock_failed', {
      content: chapterContent,
      actualWords,
      generationMeta,
      savedChapter,
      errorMessage: 'Writing lock lost after saving the chapter.',
    });
  }

  const deferredPostChapterUsages: DeferredUsage[] = [];
  const failDeferredPostChapterUsages = async () => {
    await Promise.allSettled(deferredPostChapterUsages.map(u => u.failUsage()));
  };

  let [summarizeOutcome, validateOutcome] = await Promise.allSettled([
    deps.summarize({ content: chapterContent, plan }),
    deps.validate({ content: chapterContent, previousFactsSummary: input.earlierDigest }),
  ]);

  if (deps.isCancelled()) {
    await cancelSettledUsages(summarizeOutcome, validateOutcome);
    return buildOutcome('aborted', { savedChapter });
  }

  let chapterQualityIssues: ChapterQualityIssue[] | null =
    validateOutcome.status === 'fulfilled' ? validateOutcome.value.issues : null;
  let chapterQualityScore: number | null =
    validateOutcome.status === 'fulfilled' ? validateOutcome.value.score : null;
  chapterQualityIssues = ensureLengthIssue(chapterQualityIssues, actualWords, targetWordsPerChapter);

  let ralphRevisionCount = 0;
  if (
    validateOutcome.status === 'fulfilled' &&
    shouldReviseChapterInRalphLoop({ issues: chapterQualityIssues, score: chapterQualityScore })
  ) {
    deps.emit({
      type: 'progress',
      progress: input.progress,
      message: isZhLocale(language)
        ? `Ralph loop 正在修订第 ${plan.chapterNumber} 章的一致性问题...`
        : `Ralph loop is revising Chapter ${plan.chapterNumber} for continuity...`,
    });
    if (!(await deps.renewLock())) {
      await failSettledUsages(summarizeOutcome, validateOutcome);
      return buildOutcome('lock_failed', {
        content: chapterContent,
        actualWords,
        qualityIssues: chapterQualityIssues,
        generationMeta,
        savedChapter,
        errorMessage: 'Writing lock lost before Ralph revision.',
      });
    }
    let repairOutcome: ReviseOutcome | null;
    try {
      repairOutcome = await deps.revise({
        content: chapterContent,
        plan,
        revisionBrief: formatRalphRevisionBrief({
          issues: chapterQualityIssues,
          score: chapterQualityScore,
          targetWords: targetWordsPerChapter,
        }),
      });
    } catch (error) {
      const repairError = sanitizeError(error, 'Ralph repair failed');
      chapterQualityIssues = [
        ...(chapterQualityIssues ?? []),
        { type: 'other', description: `Ralph repair failed; kept the original chapter draft. ${repairError}`, severity: 'minor' },
      ];
      deps.log(START_WRITING_EVENTS.validateDone, { ch: plan.chapterNumber, ralphRevision: 'degraded', error: repairError });
      deps.emit({
        type: 'progress',
        progress: input.progress,
        message: isZhLocale(language)
          ? `Ralph loop 修订失败，已保留第 ${plan.chapterNumber} 章初稿并继续...`
          : `Ralph loop repair failed; keeping Chapter ${plan.chapterNumber}'s draft and continuing...`,
      });
      repairOutcome = null;
    }

    if (repairOutcome && deps.isCancelled()) {
      await repairOutcome.cancelUsage();
      await cancelSettledUsages(summarizeOutcome, validateOutcome);
      return buildOutcome('aborted', { qualityIssues: chapterQualityIssues, savedChapter });
    }

    if (repairOutcome && countWords(repairOutcome.content) < Math.floor(actualWords * RALPH_MIN_RETAINED_RATIO)) {
      // Ralph must return the FULL revised chapter. A materially shorter result
      // means truncation/over-summarisation — keep the longer original draft
      // (already persisted; a shrunk revision would be unrecoverable loss).
      const revisedWords = countWords(repairOutcome.content);
      deferredPostChapterUsages.push(repairOutcome); // tokens spent; record honestly
      chapterQualityIssues = [
        ...(chapterQualityIssues ?? []),
        { type: 'other', description: `Ralph revision returned materially shorter prose (${revisedWords} vs ${actualWords} words); kept the original draft.`, severity: 'minor' },
      ];
      deps.log(START_WRITING_EVENTS.validateDone, { ch: plan.chapterNumber, ralphRevision: 'rejected_short', revisedWords, preRevisionWords: actualWords });
      deps.emit({
        type: 'progress',
        progress: input.progress,
        message: isZhLocale(language)
          ? `Ralph 修订结果偏短，已保留第 ${plan.chapterNumber} 章初稿。`
          : `Ralph revision came back too short; kept Chapter ${plan.chapterNumber}'s original draft.`,
      });
      repairOutcome = null;
    }

    if (repairOutcome) {
      chapterContent = repairOutcome.content;
      actualWords = countWords(chapterContent);
      generationMeta.actualWords = actualWords;
      generationMeta.ralphLoop = { revisionCount: RALPH_LOOP_MAX_REVISIONS, finalScore: null, fixedIssues: chapterQualityIssues?.length ?? 0 };
      ralphRevisionCount = RALPH_LOOP_MAX_REVISIONS;
      deferredPostChapterUsages.push(repairOutcome);
      if (summarizeOutcome.status === 'fulfilled') deferredPostChapterUsages.push(summarizeOutcome.value);
      if (validateOutcome.status === 'fulfilled') deferredPostChapterUsages.push(validateOutcome.value);
      try {
        savedChapter = await deps.upsertChapter(plan.chapterNumber, plan.title, chapterContent);
      } catch (error) {
        await failDeferredPostChapterUsages();
        throw error;
      }

      [summarizeOutcome, validateOutcome] = await Promise.allSettled([
        deps.summarize({ content: chapterContent, plan }),
        deps.validate({
          content: chapterContent,
          // Validate the revised chapter against a facts summary that reflects
          // what just changed (the chapter tail), not the stale pre-revision digest.
          previousFactsSummary: `${input.earlierDigest}\n\nCurrent chapter (just revised), tail:\n${chapterContent.slice(-600)}`,
        }),
      ]);
      chapterQualityIssues = validateOutcome.status === 'fulfilled' ? validateOutcome.value.issues : null;
      chapterQualityScore = validateOutcome.status === 'fulfilled' ? validateOutcome.value.score : null;
      if (generationMeta.ralphLoop) generationMeta.ralphLoop.finalScore = chapterQualityScore;
    }
  }

  const chapterSummary = summarizeOutcome.status === 'fulfilled' ? summarizeOutcome.value.summary : chapterContent.slice(-600).trim();
  const chapterKeyFacts = summarizeOutcome.status === 'fulfilled' ? summarizeOutcome.value.keyFacts : null;

  chapterQualityIssues = ensureLengthIssue(chapterQualityIssues, actualWords, targetWordsPerChapter);

  try {
    await deps.updateChapterMeta(plan.chapterNumber, {
      summary: chapterSummary,
      keyFacts: chapterKeyFacts,
      qualityIssues: chapterQualityIssues,
      generationMeta,
    });
  } catch (error) {
    await failDeferredPostChapterUsages();
    await failSettledUsages(summarizeOutcome, validateOutcome);
    throw error;
  }
  for (const deferredUsage of deferredPostChapterUsages) await deferredUsage.recordUsage();
  if (summarizeOutcome.status === 'fulfilled') await summarizeOutcome.value.recordUsage();
  if (validateOutcome.status === 'fulfilled') await validateOutcome.value.recordUsage();

  return {
    status: 'written',
    errorMessage: null,
    content: chapterContent,
    actualWords,
    attempts: chapterAttempts,
    qualityIssues: chapterQualityIssues,
    ralphRevisions: ralphRevisionCount,
    summary: chapterSummary,
    keyFacts: chapterKeyFacts,
    generationMeta,
    savedChapter,
  };
}
