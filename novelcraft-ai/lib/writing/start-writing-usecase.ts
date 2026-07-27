// The route owns authorization, preflight, lock acquisition, and transport.
// This use case owns the durable writing lifecycle after those gates succeed.

import {
  updateNovel,
  type Novel,
} from '@/lib/db';
import {
  getTargetWordsPerChapter,
  selectChapterPlansToWrite,
} from '@/lib/ai';
import { isZhLocale } from '@/lib/i18n';
import {
  shouldFinalizeStartWriting,
  START_WRITING_EVENTS,
  type StartWritingEndReason,
} from '@/lib/start-writing-logging';
import { sanitizeError } from '@/lib/utils';
import { missingChapterNumbers } from '@/lib/start-writing-batch';
import { loadOrGenerateBlueprint } from '@/lib/writing/start-writing-steps';
import type { WritingEventSink } from '@/lib/writing/ndjson-sink';
import { executeWritingChapterBatch } from '@/lib/writing/start-writing-batch-executor';
import type { StartWritingContext } from '@/lib/writing/start-writing-types';

export type {
  StartWritingContext,
  WritingJobPort,
} from '@/lib/writing/start-writing-types';

function jobStatusForReason(reason: StartWritingEndReason): 'completed' | 'paused' | 'failed' {
  if (reason === 'complete') return 'completed';
  if (reason === 'error' || reason === 'lock_failed') return 'failed';
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
    language,
    existingChapters,
    requestStartedAt,
    lifecycle,
    lease,
    jobs,
    log,
  } = ctx;

  let completedChapters = 0;
  let abortedReason: StartWritingEndReason = 'unknown';
  let errorMessage: string | null = null;
  let latestProgress = novel.progress;
  let jobFinalized = false;
  let jobFinalizationAttempted = false;

  const finalizeJob = (
    novelUpdate: Partial<Novel>,
    assistantMessage?: string,
  ): Novel | null => {
    if (jobFinalized || jobFinalizationAttempted) return null;
    jobFinalizationAttempted = true;
    const settledNovel = jobs.finalize(
      jobStatusForReason(abortedReason),
      abortedReason,
      errorMessage,
      novelUpdate,
      assistantMessage,
    );
    jobFinalized = true;
    return settledNovel;
  };

  // Independent persisted fact: whether this novel already had chapters before
  // this run. `completedChapters` is only populated from `existingChapters`
  // AFTER loadOrGenerateBlueprint succeeds (below), so an abort/error during the
  // blueprint stage leaves it at 0 even for a resume of a novel that has many
  // chapters. Cold-reset must key off this, not `completedChapters`, or a failed
  // "continue writing" would demote an existing novel to ready_for_greenlight/0.
  const hadPersistedChapters = existingChapters.length > 0;
  const originalStage = novel.stage;
  const originalProgress = novel.progress;

  const pausedNovelUpdate = (): Partial<Novel> => {
    if (completedChapters > 0) {
      return { stage: 'autonomous_writing', progress: latestProgress };
    }
    if (hadPersistedChapters) {
      // A resume aborted before the blueprint established the true completed
      // count. Never demote to ready_for_greenlight/0 — restore the pre-run
      // stage/progress so the existing chapters aren't visually rolled back.
      errorMessage ??= coldAbortMessage(abortedReason);
      return { stage: originalStage, progress: originalProgress };
    }
    // Approval is durable. Closing the app or pressing Pause cancels the HTTP
    // generation stream, but it must not send the project back through the
    // approval gate. Persist the last real phase so relaunch reconstructs a
    // truthful paused WritingRunState with a Resume action.
    errorMessage ??= coldAbortMessage(abortedReason);
    return { stage: 'autonomous_writing', progress: latestProgress };
  };

  const failedNovelUpdate = (): Partial<Novel> => (
    completedChapters > 0
      ? { stage: 'autonomous_writing', progress: latestProgress }
      : hadPersistedChapters
        ? { stage: originalStage, progress: originalProgress }
        : { stage: 'autonomous_writing', progress: latestProgress }
  );

  const settlePausedRun = async () => {
    try {
      finalizeJob(pausedNovelUpdate());
    } catch (settlementError) {
      console.error('Failed to atomically settle paused writing run:', settlementError);
      errorMessage = isZhLocale(language)
        ? '写作已暂停，但无法原子保存暂停状态与运行记录。'
        : 'Writing paused, but its state and run record could not be saved atomically.';
    }
  };

  const emitFailedTerminal = (publicError: string) => {
    sink.emit({
      type: 'phase',
      phase: 'failed',
      progress: latestProgress,
      completedChapters,
      message: publicError,
    });
    sink.emit({ type: 'error', error: publicError });
  };

  const settleFailedRun = async (publicError: string) => {
    try {
      finalizeJob(failedNovelUpdate());
    } catch (settlementError) {
      console.error('Failed to atomically settle failed writing run:', settlementError);
      const settlementMessage = isZhLocale(language)
        ? '写作失败，且无法保存最终状态。请重试。'
        : 'Writing failed and its terminal state could not be saved. Please retry.';
      emitFailedTerminal(settlementMessage);
      return;
    }
    emitFailedTerminal(publicError);
  };

  const finalizeBeforeTerminal = (
    failureMessage: string,
    novelUpdate: Partial<Novel>,
    assistantMessage?: string,
  ): Novel | null => {
    try {
      return finalizeJob(novelUpdate, assistantMessage);
    } catch (finalizeError) {
      console.error('Failed to finalize writing job:', finalizeError);
      errorMessage = failureMessage;
      sink.emit({ type: 'error', error: failureMessage });
      return null;
    }
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

    sink.emit({
      type: 'progress',
      progress: progressForCompleted(completedChapters),
      message: isZhLocale(language)
        ? `蓝图就绪，共 ${blueprint.chapters.length} 章，剩余 ${chaptersToWrite.length} 章待写...`
        : `Blueprint ready: ${blueprint.chapters.length} chapters. ${chaptersToWrite.length} chapters remaining...`,
    });

    const batch = await executeWritingChapterBatch({
      ctx,
      sink,
      blueprint,
      targetWordsPerChapter,
      existingByNumber,
      completedChapters,
      progressForCompleted,
    });
    abortedReason = batch.abortedReason;
    errorMessage = batch.errorMessage;
    completedChapters = batch.completedChapters;
    latestProgress = batch.latestProgress;
    const writtenThisBatch = batch.writtenThisBatch;

    // Batch-complete (we stopped because chaptersLimit/untilChapter was
    // reached) is a clean pause point — keep stage at autonomous_writing,
    // send a structured event so the client can switch to its
    // "next chapter / edit blueprint / rewrite current" UI.
    if (abortedReason === 'batch_complete') {
      const missing = missingChapterNumbers(blueprint.chapters, existingByNumber);
      const remaining = missing.length;
      const nextChapter = missing[0] ?? null;
      const finalizeMessage = isZhLocale(language)
        ? '章节已保存，但无法完成本次写作记录。请重试。'
        : 'The chapter was saved, but this writing run could not be finalized. Please retry.';
      if (!finalizeBeforeTerminal(finalizeMessage, {
        stage: 'autonomous_writing',
        progress: latestProgress,
      })) return;
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
      return;
    }

    // A chapter failure or lock loss is already a determined terminal result.
    // Settle it before consulting cancellation so a concurrent abort cannot
    // rewrite a real failure as a clean pause.
    if (abortedReason === 'error' || abortedReason === 'lock_failed') {
      const publicError = errorMessage ?? 'Writing failed';
      await settleFailedRun(publicError);
      return;
    }

    if (lifecycle.isCancelled()) {
      abortedReason = lease.hasLost() ? 'lock_failed' : 'aborted';
      if (abortedReason === 'lock_failed') {
        const publicError = isZhLocale(language)
          ? '写作锁已丢失（另一个会话已接管）。'
          : 'Writing lock lost (another session took over).';
        errorMessage = publicError;
        await settleFailedRun(publicError);
      } else {
        await settlePausedRun();
      }
      return;
    }

    if (!shouldFinalizeStartWriting(abortedReason)) {
      await settlePausedRun();
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
      abortedReason = 'batch_complete';
      await settlePausedRun();
      sink.emit({
        type: 'batch_done',
        nextChapter: missing[0] ?? null,
        remaining,
        completedChapters,
        totalChapters: blueprint.chapters.length,
      });
      return;
    }

    // Stage moves to whole_book_unification but unify itself is user-triggered
    // via /api/novels/[id]/unify so the user controls token spend.
    const finalMsg = isZhLocale(language)
      ? `全书初稿已完成：共 ${blueprint.chapters.length} 章。可点击「全书统稿」自动检查跨章节一致性，或直接进入创作桌面继续打磨。`
      : `Full-book draft is ready: ${blueprint.chapters.length} chapters written. Run “Whole-book unification” for cross-chapter consistency checks, or open the Writer Desk to revise directly.`;
    abortedReason = 'complete';
    const finalizeMessage = isZhLocale(language)
      ? '全书初稿已保存，但无法完成写作记录。请重试。'
      : 'The full draft was saved, but its writing run could not be finalized. Please retry.';
    const finalNovel = finalizeBeforeTerminal(
      finalizeMessage,
      { stage: 'whole_book_unification', progress: 100 },
      finalMsg,
    );
    if (!finalNovel) return;
    sink.emit({ type: 'done', novel: finalNovel, message: finalMsg });
    sink.emit({
      type: 'phase',
      phase: 'complete',
      progress: 100,
      completedChapters: blueprint.chapters.length,
      totalChapters: blueprint.chapters.length,
      message: finalMsg,
    });
    log(START_WRITING_EVENTS.complete, {
      chapters: blueprint.chapters.length,
      durationMs: Date.now() - requestStartedAt,
    });
  } catch (err) {
    if (lifecycle.isCancelled()) {
      abortedReason = lease.hasLost() ? 'lock_failed' : 'aborted';
      if (abortedReason === 'lock_failed') {
        const publicError = isZhLocale(language)
          ? '写作锁已丢失（另一个会话已接管）。'
          : 'Writing lock lost (another session took over).';
        errorMessage = publicError;
        await settleFailedRun(publicError);
      } else {
        log(START_WRITING_EVENTS.aborted, { message: err instanceof Error ? err.message : String(err) });
        await settlePausedRun();
      }
      return;
    }
    abortedReason = 'error';
    errorMessage = err instanceof Error ? err.message : String(err);
    log(START_WRITING_EVENTS.error, {
      message: errorMessage,
      durationMs: Date.now() - requestStartedAt,
    });
    console.error('Writing error:', err);
    // Fresh approved runs (no chapters yet) already advanced to autonomous_writing
    // at prepare. A real pre-first-chapter error must stay there with the last
    // progress so reload reconstructs failed + Retry — never demote back through
    // the greenlight gate. Resumes with existing chapters restore pre-run truth.
    const publicError = sanitizeError(err, 'Writing failed');
    await settleFailedRun(publicError);
  } finally {
    log(START_WRITING_EVENTS.end, {
      reason: abortedReason,
      durationMs: Date.now() - requestStartedAt,
    });
    if (!jobFinalized && !jobFinalizationAttempted) {
      console.error(`Writing run ended without an atomic terminal settlement (${abortedReason})`);
    }
  }
}
