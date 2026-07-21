// StartWriting use case (Phase 3): the batch-writing orchestration extracted
// verbatim from the start-writing route's ReadableStream body. The route is now
// a thin adapter that builds the context + collaborators and calls execute.
//
// What MOVED here: stage advance, blueprint load/generate, chapter selection,
// rolling-digest setup, the per-chapter loop (incl. the WriteChapterDeps build,
// copied unchanged), volume summarisation, and terminal handling.
// What stayed in the adapter: owner/lock/preflight, AI-context build, and the
// transport (controller/heartbeat/lock-renew timer/release) — see ndjson-sink.
//
// The writeChapter hard invariants (row-before-usage, length-continuation,
// Ralph 0.8 retention, lock_failed → no done frame) live in
// lib/writing-orchestrator and are untouched; this file only feeds it deps.

import {
  completeWritingDraft,
  getVolumeSummaries,
  updateChapterMeta,
  updateNovel,
  upsertChapter,
  type Chapter,
  type Novel,
} from '@/lib/db';
import {
  adaptiveDigestParams,
  buildRollingDigest,
  getTargetWordsPerChapter,
  selectChapterPlansToWrite,
  streamChapter,
  streamChapterContinuation,
  type RollingDigestSource,
} from '@/lib/ai';
import { isZhLocale, type Locale } from '@/lib/i18n';
import type { GenerationPreset } from '@/lib/ai/generation-presets';
import {
  shouldFinalizeStartWriting,
  START_WRITING_EVENTS,
  type StartWritingEndReason,
} from '@/lib/start-writing-logging';
import { sanitizeError } from '@/lib/utils';
import {
  aiUsageErrorResponse,
  createAIUsageSession,
  type AIStreamLifecycle,
  type AIUsageSession,
} from '@/lib/ai-usage';
import { missingChapterNumbers, shouldStopStartWritingBatch } from '@/lib/start-writing-batch';
import { writeChapter, type WriteChapterDeps } from '@/lib/writing-orchestrator';
import {
  loadOrGenerateBlueprint,
  maybeRunVolumeSummary,
  runRalphRevision,
  runSummarize,
  runValidate,
} from '@/lib/writing/start-writing-steps';
import type { WritingEventSink } from '@/lib/writing/ndjson-sink';
import type { WritingLease } from '@/lib/writing/lease';

type Logger = (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;

/** Persisted run-history hooks (writing_jobs). Injected so the use case is testable. */
export interface WritingJobPort {
  bumpProgress(currentChapter: number, seq: number): void;
  finalize(status: 'completed' | 'paused' | 'failed', endReason: string, errorMessage?: string | null): void;
}

export interface StartWritingContext {
  novelId: string;
  userId: string;
  novel: Novel;
  request: Request;
  systemPrompt: string;
  knowledgeSummaries: string;
  language: Locale;
  chapterPreset: GenerationPreset;
  existingChapters: Chapter[];
  messageCount: number;
  chaptersLimit: number;
  untilChapter: number | null;
  requestStartedAt: number;
  lifecycle: AIStreamLifecycle;
  lease: WritingLease;
  jobs: WritingJobPort;
  log: Logger;
}

function jobStatusForReason(reason: StartWritingEndReason): 'completed' | 'paused' | 'failed' {
  if (reason === 'complete') return 'completed';
  if (reason === 'error') return 'failed';
  return 'paused';
}

function coldAbortMessage(reason: StartWritingEndReason): string {
  if (reason === 'lock_failed') return 'Writing stopped before any chapter was created because the writing lock was lost.';
  if (reason === 'controller_closed') return 'Writing stopped before any chapter was created because the client connection closed.';
  if (reason === 'aborted') return 'Writing stopped before any chapter was created.';
  return 'Writing stopped before any chapter was created.';
}

export async function executeStartWriting(
  ctx: StartWritingContext,
  sink: WritingEventSink,
): Promise<void> {
  const {
    novelId: id,
    userId,
    novel,
    request,
    systemPrompt,
    knowledgeSummaries,
    language,
    chapterPreset,
    existingChapters,
    chaptersLimit,
    untilChapter,
    requestStartedAt,
    lifecycle,
    lease,
    jobs,
    log,
  } = ctx;

  let completedChapters = 0;
  let seq = 0;
  let abortedReason: StartWritingEndReason = 'unknown';
  let errorMessage: string | null = null;
  let latestProgress = novel.progress;

  // Independent persisted fact: whether this novel already had chapters before
  // this run. `completedChapters` is only populated from `existingChapters`
  // AFTER loadOrGenerateBlueprint succeeds (below), so an abort/error during the
  // blueprint stage leaves it at 0 even for a resume of a novel that has many
  // chapters. Cold-reset must key off this, not `completedChapters`, or a failed
  // "continue writing" would demote an existing novel to ready_for_greenlight/0.
  const hadPersistedChapters = existingChapters.length > 0;
  const originalStage = novel.stage;
  const originalProgress = novel.progress;

  const persistPausedRun = async () => {
    if (completedChapters > 0) return;
    if (hadPersistedChapters) {
      // A resume aborted before the blueprint established the true completed
      // count. Never demote to ready_for_greenlight/0 — restore the pre-run
      // stage/progress so the existing chapters aren't visually rolled back.
      await updateNovel(id, { stage: originalStage, progress: originalProgress });
      errorMessage ??= coldAbortMessage(abortedReason);
      return;
    }
    // Approval is durable. Closing the app or pressing Pause cancels the HTTP
    // generation stream, but it must not send the project back through the
    // approval gate. Persist the last real phase so relaunch reconstructs a
    // truthful paused WritingRunState with a Resume action.
    await updateNovel(id, { stage: 'autonomous_writing', progress: latestProgress });
    errorMessage ??= coldAbortMessage(abortedReason);
  };

  try {
    log(START_WRITING_EVENTS.begin, { stage: novel.stage, messages: ctx.messageCount });

    sink.emit({
      type: 'phase',
      phase: 'preparing',
      progress: Math.max(0, novel.progress),
      completedChapters: existingChapters.length,
      message: isZhLocale(language) ? '正在准备写作上下文...' : 'Preparing writing context...',
    });
    await updateNovel(id, { stage: 'autonomous_writing', progress: 5 });
    latestProgress = 5;
    sink.emit({
      type: 'phase',
      phase: 'planning',
      progress: 5,
      completedChapters: existingChapters.length,
      message: isZhLocale(language) ? '正在规划章节蓝图...' : 'Planning chapter blueprint...',
    });
    sink.emit({ type: 'progress', progress: 5, message: isZhLocale(language) ? '正在规划章节蓝图...' : 'Planning chapter blueprint...' });

    const blueprint = await loadOrGenerateBlueprint({
      novelId: id,
      userId,
      novel,
      systemPrompt,
      language,
      request,
      signal: lifecycle.signal,
      existingChapters,
      log,
    });

    sink.emit({ type: 'blueprint', blueprint, total: blueprint.chapters.length });

    // We hold the lock; existingChapters is authoritative for the duration.
    const existingByNumber = new Map(existingChapters.map(c => [c.chapterNumber, c]));
    const chaptersToWrite = selectChapterPlansToWrite(blueprint.chapters, existingChapters);
    // Outline-projected blueprints carry targetWordsPerChapter === 0 when no
    // per-chapter word targets were authored (projectBlueprintFromOutline).
    // Floor it from the novel's intended length so the length gate
    // (minimumRetryWords) stays active and the chapter prompt never says
    // "aim for ~0 words". Freshly generated blueprints already floor at 800.
    const targetWordsPerChapter = blueprint.targetWordsPerChapter > 0
      ? blueprint.targetWordsPerChapter
      : getTargetWordsPerChapter(novel.targetWords || 80_000, Math.max(1, blueprint.chapters.length));
    completedChapters = blueprint.chapters.filter(c => existingByNumber.has(c.chapterNumber)).length;
    const progressForCompleted = (count: number) =>
      15 + Math.floor((count / blueprint.chapters.length) * 75);
    latestProgress = progressForCompleted(completedChapters);

    // Hoist adaptive digest sizing — inputs (target words, chapter count)
    // don't change across the loop, no point recomputing per chapter.
    let digestParams;
    try {
      digestParams = adaptiveDigestParams(
        novel.targetWords || 80_000,
        Math.max(1, blueprint.chapters.length),
      );
    } catch {
      digestParams = { recentWindow: 2, tailCharsPerChapter: 1500, maxBatchChars: 80_000 };
    }

    let writtenThisBatch = 0;

    sink.emit({
      type: 'progress',
      progress: progressForCompleted(completedChapters),
      message: isZhLocale(language)
        ? `蓝图就绪，共 ${blueprint.chapters.length} 章，剩余 ${chaptersToWrite.length} 章待写...`
        : `Blueprint ready: ${blueprint.chapters.length} chapters. ${chaptersToWrite.length} chapters remaining...`,
    });

    const digestSources: RollingDigestSource[] = blueprint.chapters
      .map(p => existingByNumber.get(p.chapterNumber))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map(c => ({
        chapterNumber: c.chapterNumber,
        title: c.title,
        content: c.content,
        summary: c.summary || '',
        summaryStale: c.generationMeta?.summaryStale === true,
        keyFacts: c.keyFacts ?? null,
      }));

    // The per-chapter rolling digest is now the SINGLE memory channel (the
    // system prompt is knowledge-only via excludeRollingMemory). Volume
    // summaries used to ride along in the system memory block, so they must
    // travel with this digest instead — refreshed whenever the loop folds a
    // new volume below (maybeRunVolumeSummary appends past the 100-chapter
    // boundary).
    let volumeSummaries = await getVolumeSummaries(id).catch(() => []);

    for (let i = 0; i < blueprint.chapters.length; i++) {
      if (sink.isClosed() || lifecycle.signal.aborted) {
        abortedReason = lifecycle.signal.aborted ? 'aborted' : 'controller_closed';
        log(START_WRITING_EVENTS.aborted, { chapterIndex: i + 1 });
        break;
      }

      const plan = blueprint.chapters[i];
      if (existingByNumber.has(plan.chapterNumber)) continue;

      // Honour client-requested batching: stop once we've written the
      // hard per-request cap, requested number of chapters, or requested
      // untilChapter. `untilChapter` can extend the default one-chapter step,
      // but it cannot turn one HTTP request into an unbounded book run.
      if (shouldStopStartWritingBatch({
        writtenThisBatch,
        chapterNumber: plan.chapterNumber,
        chaptersLimit,
        untilChapter,
      })) {
        abortedReason = 'batch_complete';
        break;
      }

      if (!(await lease.renew())) {
        sink.emit({ type: 'error', error: 'Writing lock lost (another session took over).' });
        abortedReason = 'lock_failed';
        break;
      }

      const digest = buildRollingDigest(
        digestSources,
        digestParams.recentWindow,
        digestParams.tailCharsPerChapter,
        { volumeSummaries },
      );
      const chapterStartedAt = Date.now();
      log(START_WRITING_EVENTS.chapterStart, { ch: plan.chapterNumber, title: plan.title });
      sink.emit({
        type: 'phase',
        phase: 'drafting',
        progress: progressForCompleted(completedChapters),
        chapterNumber: plan.chapterNumber,
        chapterTitle: plan.title,
        completedChapters,
        totalChapters: blueprint.chapters.length,
        message: isZhLocale(language)
          ? `正在创作第 ${plan.chapterNumber} 章：${plan.title}`
          : `Writing Chapter ${plan.chapterNumber}: ${plan.title}`,
      });
      sink.emit({
        type: 'progress',
        progress: progressForCompleted(completedChapters),
        message: isZhLocale(language)
          ? `正在创作第 ${plan.chapterNumber} 章：${plan.title}...`
          : `Writing Chapter ${plan.chapterNumber}: ${plan.title}...`,
      });

      const chapterDeps: WriteChapterDeps = {
        createChapterUsage: async () => {
          let chapterUsage: AIUsageSession;
          try {
            chapterUsage = await createAIUsageSession(request, { userId, operation: 'chapter' });
          } catch (error) {
            const response = aiUsageErrorResponse(error);
            sink.emit({
              type: 'error',
              error: response
                ? (await response.json().catch(() => ({})))?.error || 'AI usage error'
                : sanitizeError(error, 'AI usage error'),
            });
            throw error;
          }
          chapterUsage.addPromptText(systemPrompt);
          chapterUsage.addPromptText(JSON.stringify(plan));
          return chapterUsage;
        },
        streamChapter: a => streamChapter({
          model: a.model,
          novelContext: novel,
          blueprint: a.blueprint,
          language,
          signal: lifecycle.signal,
          targetWordsPerChapter: a.targetWordsPerChapter,
          systemPrompt,
          recentChapterTails: a.recentChapterTails,
          earlierChapterDigest: a.earlierChapterDigest,
          onFinish: a.onFinish,
          onError: a.onError,
          preset: chapterPreset,
        }),
        streamChapterContinuation: a => streamChapterContinuation({
          model: a.model,
          novelContext: novel,
          blueprint: a.blueprint,
          existingContent: a.existingContent,
          targetExtraWords: a.targetExtraWords,
          language,
          signal: lifecycle.signal,
          systemPrompt,
          onFinish: a.onFinish,
          onError: a.onError,
          preset: chapterPreset,
        }),
        summarize: ({ content, plan: p }) => runSummarize({
          request,
          userId,
          signal: lifecycle.signal,
          chapterContent: content,
          chapterTitle: p.title,
          plan: p,
          language,
          systemPrompt,
          chapterNumber: p.chapterNumber,
          log,
        }),
        validate: ({ content, previousFactsSummary }) => runValidate({
          request,
          userId,
          signal: lifecycle.signal,
          chapterContent: content,
          chapterTitle: plan.title,
          knowledgeContext: knowledgeSummaries,
          previousFactsSummary,
          targetWords: targetWordsPerChapter,
          language,
          systemPrompt,
          chapterNumber: plan.chapterNumber,
          log,
        }),
        revise: ({ content, plan: p, revisionBrief }) => runRalphRevision({
          request,
          userId,
          signal: lifecycle.signal,
          chapterContent: content,
          chapterTitle: p.title,
          plan: p,
          novel,
          revisionBrief,
          language,
          systemPrompt,
          chapterNumber: p.chapterNumber,
          log,
        }),
        upsertChapter: (chapterNumber, title, content) => upsertChapter(id, chapterNumber, title, content),
        updateChapterMeta: (chapterNumber, meta) => updateChapterMeta(id, chapterNumber, meta),
        renewLock: () => lease.renew(),
        emit: frame => sink.emit(frame),
        isCancelled: () => lifecycle.isCancelled(),
        isAborted: () => lifecycle.signal.aborted,
        log,
      };

      let outcome;
      try {
        outcome = await writeChapter(chapterDeps, {
          plan,
          targetWordsPerChapter,
          language,
          earlierDigest: digest.earlierDigest,
          recentTails: digest.recentTails,
          progress: progressForCompleted(completedChapters),
        });
      } catch (error) {
        sink.emit({ type: 'error', error: sanitizeError(error, 'Writing failed') });
        throw error;
      }

      if (outcome.status === 'aborted') {
        abortedReason = 'aborted';
        break;
      }
      if (outcome.status === 'lock_failed') {
        // The lock can be lost immediately after writeChapter persisted the raw
        // draft but before summarize/validate/Ralph completed. Preserve that
        // durable fact in batch progress so resetColdAbort cannot roll the novel
        // back to ready_for_greenlight. Do not emit chapter_done: the chapter's
        // post-processing contract is incomplete, and the preceding error frame
        // tells the client to refresh the saved row from SQLite.
        if (outcome.savedChapter) {
          completedChapters++;
          writtenThisBatch++;
          existingByNumber.set(plan.chapterNumber, outcome.savedChapter);
          const persistedProgress = progressForCompleted(completedChapters);
          await updateNovel(id, { stage: 'autonomous_writing', progress: persistedProgress });
          jobs.bumpProgress(plan.chapterNumber, ++seq);
        }
        abortedReason = 'lock_failed';
        break;
      }
      // `empty` = the model produced no usable content after all continuation
      // passes (fake-success guard in the orchestrator). The orchestrator has
      // already emitted a user-facing error frame and failed usage; here we stop
      // the batch and finalize the job as a generation error so the run ends
      // honestly instead of advancing past an empty chapter.
      if (outcome.status === 'empty') {
        abortedReason = 'error';
        break;
      }

      const chapterContent = outcome.content;
      const actualWords = outcome.actualWords;
      const chapterAttempts = outcome.attempts;
      const chapterSummary = outcome.summary;
      const chapterKeyFacts = outcome.keyFacts;
      const chapterQualityIssues = outcome.qualityIssues;
      const ralphRevisionCount = outcome.ralphRevisions;
      sink.emit({
        type: 'phase',
        phase: 'saving',
        progress: progressForCompleted(completedChapters),
        chapterNumber: plan.chapterNumber,
        chapterTitle: plan.title,
        completedChapters,
        totalChapters: blueprint.chapters.length,
        message: isZhLocale(language)
          ? `正在保存第 ${plan.chapterNumber} 章...`
          : `Saving Chapter ${plan.chapterNumber}...`,
      });
      completedChapters++;
      writtenThisBatch++;
      existingByNumber.set(plan.chapterNumber, outcome.savedChapter!);

      digestSources.push({
        chapterNumber: plan.chapterNumber,
        title: plan.title,
        content: chapterContent,
        summary: chapterSummary,
        keyFacts: chapterKeyFacts,
      });

      // Volume summarisation: once we cross 10 chapters + 100k words since
      // the last summary boundary, compress the unsummarised tail into a
      // single VolumeSummary so buildRollingDigest can prune those chapters
      // from earlierDigest in future iterations. Failures degrade silently.
      await maybeRunVolumeSummary({
        request,
        userId,
        novelId: id,
        digestSources,
        systemPrompt,
        language,
        signal: lifecycle.signal,
        log,
      });
      // Pick up a freshly-folded volume so the next chapter's digest prunes
      // the now-summarised earlier chapters instead of re-sending them.
      volumeSummaries = await getVolumeSummaries(id).catch(() => volumeSummaries);

      if (lifecycle.isCancelled()) {
        abortedReason = 'aborted';
        break;
      }

      const newProgress = progressForCompleted(completedChapters);
      latestProgress = newProgress;
      sink.emit({
        type: 'chapter_done',
        chapterNumber: plan.chapterNumber,
        title: plan.title,
        content: chapterContent,
        wordCount: actualWords,
        qualityIssues: chapterQualityIssues,
        ralphRevisions: ralphRevisionCount,
        progress: newProgress,
        completedChapters,
        totalChapters: blueprint.chapters.length,
      });
      sink.emit({
        type: 'phase',
        phase: 'chapter_complete',
        progress: newProgress,
        chapterNumber: plan.chapterNumber,
        chapterTitle: plan.title,
        completedChapters,
        totalChapters: blueprint.chapters.length,
        message: isZhLocale(language)
          ? `第 ${plan.chapterNumber} 章已完成`
          : `Chapter ${plan.chapterNumber} complete`,
      });

      await updateNovel(id, { progress: newProgress });
      // Run-history progress (status unchanged); seq monotonic for future resume.
      jobs.bumpProgress(plan.chapterNumber, ++seq);

      log(START_WRITING_EVENTS.chapterDone, {
        ch: plan.chapterNumber,
        words: actualWords,
        attempts: chapterAttempts,
        durationMs: Date.now() - chapterStartedAt,
      });
    }

    // The closing send may have been the last one, with no further loop-entry
    // check to catch a client disconnect. Mirror the old route's send-catch,
    // which set controller_closed the instant an enqueue failed, so the end
    // reason + job finalize don't mislabel a disconnect as complete/unknown.
    if (abortedReason === 'unknown' && sink.isClosed()) {
      abortedReason = 'controller_closed';
    }

    // Batch-complete (we stopped because chaptersLimit/untilChapter was
    // reached) is a clean pause point — keep stage at autonomous_writing,
    // send a structured event so the client can switch to its
    // "next chapter / edit blueprint / rewrite current" UI.
    if (abortedReason === 'batch_complete') {
      const missing = missingChapterNumbers(blueprint.chapters, existingByNumber);
      const remaining = missing.length;
      const nextChapter = missing[0] ?? null;
      sink.emit({
        type: 'batch_done',
        nextChapter,
        remaining,
        completedChapters,
        totalChapters: blueprint.chapters.length,
      });
      sink.emit({
        type: 'phase',
        phase: 'paused',
        progress: progressForCompleted(completedChapters),
        completedChapters,
        totalChapters: blueprint.chapters.length,
        message: isZhLocale(language) ? '写作已暂停，可随时继续' : 'Writing paused — ready to continue',
      });
      log(START_WRITING_EVENTS.complete, {
        chapters: writtenThisBatch,
        batchComplete: true,
        durationMs: Date.now() - requestStartedAt,
      });
    }

    if (lifecycle.isCancelled()) {
      abortedReason = 'aborted';
      await persistPausedRun();
      return;
    }

    if (!shouldFinalizeStartWriting(abortedReason)) {
      if (abortedReason !== 'batch_complete') {
        await persistPausedRun();
      }
      return;
    }

    // Real full-book completion — only fall here when we reached the end
    // of the outline without an externally-imposed limit. The batch path
    // above already returned via shouldFinalize=false for batch_complete.
    if (completedChapters < blueprint.chapters.length) {
      // Defensive: shouldn't happen now that batch_complete is handled,
      // but if some future code path drops us here without finishing the
      // book, treat it as a batch_complete rather than promoting to
      // whole_book_unification by mistake.
      const missing = missingChapterNumbers(blueprint.chapters, existingByNumber);
      const remaining = missing.length;
      sink.emit({
        type: 'batch_done',
        nextChapter: missing[0] ?? null,
        remaining,
        completedChapters,
        totalChapters: blueprint.chapters.length,
      });
      abortedReason = 'batch_complete';
      return;
    }

    // Stage moves to whole_book_unification but unify itself is user-triggered
    // via /api/novels/[id]/unify so the user controls token spend.
    const finalMsg = isZhLocale(language)
      ? `全书初稿已完成：共 ${blueprint.chapters.length} 章。可点击「全书统稿」自动检查跨章节一致性，或直接进入创作桌面继续打磨。`
      : `Full-book draft is ready: ${blueprint.chapters.length} chapters written. Run “Whole-book unification” for cross-chapter consistency checks, or open the Writer Desk to revise directly.`;
    const finalNovel = await completeWritingDraft(id, finalMsg);
    if (!finalNovel) {
      throw new Error('Novel not found');
    }
    sink.emit({ type: 'done', novel: finalNovel, message: finalMsg });
    sink.emit({
      type: 'phase',
      phase: 'complete',
      progress: 100,
      completedChapters: blueprint.chapters.length,
      totalChapters: blueprint.chapters.length,
      message: finalMsg,
    });
    abortedReason = 'complete';
    log(START_WRITING_EVENTS.complete, {
      chapters: blueprint.chapters.length,
      durationMs: Date.now() - requestStartedAt,
    });
  } catch (err) {
    if (lifecycle.isCancelled()) {
      abortedReason = 'aborted';
      log(START_WRITING_EVENTS.aborted, { message: err instanceof Error ? err.message : String(err) });
      await persistPausedRun();
      return;
    }
    abortedReason = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    log(START_WRITING_EVENTS.error, {
      message: errorMessage,
      durationMs: Date.now() - requestStartedAt,
    });
    console.error('Writing error:', err);
    await updateNovel(id, completedChapters > 0
      ? { stage: 'autonomous_writing' }
      : hadPersistedChapters
        ? { stage: originalStage, progress: originalProgress }
        : { stage: 'ready_for_greenlight', progress: 0 });
    const publicError = sanitizeError(err, 'Writing failed');
    sink.emit({
      type: 'phase',
      phase: 'failed',
      progress: latestProgress,
      completedChapters,
      message: publicError,
    });
    sink.emit({ type: 'error', error: publicError });
  } finally {
    log(START_WRITING_EVENTS.end, {
      reason: abortedReason,
      durationMs: Date.now() - requestStartedAt,
    });
    // The single terminal run-history write. batch_complete/aborted/lock_failed
    // → paused (a clean pause point); error → failed; full book → completed.
    jobs.finalize(jobStatusForReason(abortedReason), abortedReason, errorMessage);
  }
}
