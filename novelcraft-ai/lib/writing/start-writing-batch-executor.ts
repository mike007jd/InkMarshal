import {
  adaptiveDigestParams,
  buildRollingDigest,
  streamChapter,
  streamChapterContinuation,
  type RollingDigestSource,
} from '@/lib/ai';
import {
  getVolumeSummaries,
  updateChapterMeta,
  updateNovel,
  upsertChapter,
  type Chapter,
  type NovelBlueprint,
} from '@/lib/db';
import { createAIUsageSession, aiUsageErrorResponse, type AIUsageSession } from '@/lib/ai-usage';
import { isZhLocale } from '@/lib/i18n';
import { shouldStopStartWritingBatch } from '@/lib/start-writing-batch';
import { START_WRITING_EVENTS, type StartWritingEndReason } from '@/lib/start-writing-logging';
import { sanitizeError } from '@/lib/utils';
import { writeChapter, type WriteChapterDeps } from '@/lib/writing-orchestrator';
import type { WritingEventSink } from '@/lib/writing/ndjson-sink';
import {
  maybeRunVolumeSummary,
  runRalphRevision,
  runSummarize,
  runValidate,
} from '@/lib/writing/start-writing-steps';
import type { StartWritingContext } from '@/lib/writing/start-writing-types';

export interface WritingBatchResult {
  abortedReason: StartWritingEndReason;
  errorMessage: string | null;
  completedChapters: number;
  writtenThisBatch: number;
  latestProgress: number;
}

export async function executeWritingChapterBatch(args: {
  ctx: StartWritingContext;
  sink: WritingEventSink;
  blueprint: NovelBlueprint;
  targetWordsPerChapter: number;
  existingByNumber: Map<number, Chapter>;
  completedChapters: number;
  progressForCompleted(count: number): number;
}): Promise<WritingBatchResult> {
  const {
    ctx,
    sink,
    blueprint,
    targetWordsPerChapter,
    existingByNumber,
    progressForCompleted,
  } = args;
  const {
    novelId,
    userId,
    novel,
    request,
    systemPrompt,
    knowledgeSummaries,
    language,
    chapterPreset,
    chaptersLimit,
    untilChapter,
    lifecycle,
    lease,
    jobs,
    log,
  } = ctx;

  let completedChapters = args.completedChapters;
  let writtenThisBatch = 0;
  let latestProgress = progressForCompleted(completedChapters);
  let abortedReason: StartWritingEndReason = 'unknown';
  let errorMessage: string | null = null;
  let seq = 0;
  let digestParams;
  try {
    digestParams = adaptiveDigestParams(
      novel.targetWords || 80_000,
      Math.max(1, blueprint.chapters.length),
    );
  } catch {
    digestParams = { recentWindow: 2, tailCharsPerChapter: 1500, maxBatchChars: 80_000 };
  }
  const digestSources: RollingDigestSource[] = blueprint.chapters
    .map(plan => existingByNumber.get(plan.chapterNumber))
    .filter((chapter): chapter is Chapter => chapter !== undefined)
    .map(chapter => ({
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      content: chapter.content,
      summary: chapter.summary || '',
      summaryStale: chapter.generationMeta?.summaryStale === true,
      keyFacts: chapter.keyFacts ?? null,
    }));
  let volumeSummaries = await getVolumeSummaries(novelId).catch(() => []);

  for (let index = 0; index < blueprint.chapters.length; index += 1) {
    if (sink.isClosed() || lifecycle.signal.aborted) {
      abortedReason = lifecycle.signal.aborted ? 'aborted' : 'controller_closed';
      log(START_WRITING_EVENTS.aborted, { chapterIndex: index + 1 });
      break;
    }

    const plan = blueprint.chapters[index];
    if (existingByNumber.has(plan.chapterNumber)) continue;
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
      errorMessage = isZhLocale(language)
        ? '写作锁已丢失（另一个会话已接管）。'
        : 'Writing lock lost (another session took over).';
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
          chapterUsage = await createAIUsageSession(request, {
            userId,
            operation: 'chapter',
          });
        } catch (error) {
          const response = aiUsageErrorResponse(error);
          const message = response
            ? (await response.json().catch(() => ({})))?.error || 'AI usage error'
            : sanitizeError(error, 'AI usage error');
          throw new Error(message, { cause: error });
        }
        chapterUsage.addPromptText(systemPrompt);
        chapterUsage.addPromptText(JSON.stringify(plan));
        return chapterUsage;
      },
      streamChapter: streamArgs => streamChapter({
        model: streamArgs.model,
        novelContext: novel,
        blueprint: streamArgs.blueprint,
        language,
        signal: lifecycle.signal,
        targetWordsPerChapter: streamArgs.targetWordsPerChapter,
        systemPrompt,
        recentChapterTails: streamArgs.recentChapterTails,
        earlierChapterDigest: streamArgs.earlierChapterDigest,
        onFinish: streamArgs.onFinish,
        onError: streamArgs.onError,
        preset: chapterPreset,
      }),
      streamChapterContinuation: continuationArgs => streamChapterContinuation({
        model: continuationArgs.model,
        novelContext: novel,
        blueprint: continuationArgs.blueprint,
        existingContent: continuationArgs.existingContent,
        targetExtraWords: continuationArgs.targetExtraWords,
        language,
        signal: lifecycle.signal,
        systemPrompt,
        onFinish: continuationArgs.onFinish,
        onError: continuationArgs.onError,
        preset: chapterPreset,
      }),
      summarize: ({ content, plan: chapterPlan }) => runSummarize({
        request,
        userId,
        signal: lifecycle.signal,
        chapterContent: content,
        chapterTitle: chapterPlan.title,
        plan: chapterPlan,
        language,
        systemPrompt,
        chapterNumber: chapterPlan.chapterNumber,
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
      revise: ({ content, plan: chapterPlan, revisionBrief }) => runRalphRevision({
        request,
        userId,
        signal: lifecycle.signal,
        chapterContent: content,
        chapterTitle: chapterPlan.title,
        plan: chapterPlan,
        novel,
        revisionBrief,
        language,
        systemPrompt,
        chapterNumber: chapterPlan.chapterNumber,
        log,
      }),
      upsertChapter: (chapterNumber, title, content) =>
        upsertChapter(novelId, chapterNumber, title, content),
      updateChapterMeta: (chapterNumber, meta) =>
        updateChapterMeta(novelId, chapterNumber, meta),
      renewLock: () => lease.renew(),
      emit: frame => sink.emit(frame),
      isCancelled: () => lifecycle.isCancelled(),
      isAborted: () => lifecycle.signal.aborted,
      log,
    };

    const outcome = await writeChapter(chapterDeps, {
      plan,
      targetWordsPerChapter,
      language,
      earlierDigest: digest.earlierDigest,
      recentTails: digest.recentTails,
      progress: progressForCompleted(completedChapters),
    });

    if (outcome.status === 'aborted') {
      abortedReason = 'aborted';
      break;
    }
    if (outcome.status === 'lock_failed' || outcome.status === 'saved_failed') {
      if (outcome.savedChapter) {
        completedChapters += 1;
        writtenThisBatch += 1;
        existingByNumber.set(plan.chapterNumber, outcome.savedChapter);
        latestProgress = progressForCompleted(completedChapters);
        await updateNovel(novelId, {
          stage: 'autonomous_writing',
          progress: latestProgress,
        });
        jobs.bumpProgress(plan.chapterNumber, ++seq);
      }
      errorMessage = outcome.errorMessage ?? (
        outcome.status === 'lock_failed'
          ? (isZhLocale(language)
              ? '写作锁已丢失（另一个会话已接管）。'
              : 'Writing lock lost (another session took over).')
          : (isZhLocale(language)
              ? '章节已保存，但用量记录失败。'
              : 'The chapter was saved, but its usage record failed.')
      );
      abortedReason = outcome.status === 'lock_failed' ? 'lock_failed' : 'error';
      break;
    }
    if (outcome.status === 'empty') {
      errorMessage = outcome.errorMessage ?? (
        isZhLocale(language)
          ? '模型未生成可用的章节内容。'
          : 'The model produced no usable chapter content.'
      );
      abortedReason = 'error';
      break;
    }

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
    completedChapters += 1;
    writtenThisBatch += 1;
    existingByNumber.set(plan.chapterNumber, outcome.savedChapter!);
    digestSources.push({
      chapterNumber: plan.chapterNumber,
      title: plan.title,
      content: outcome.content,
      summary: outcome.summary,
      keyFacts: outcome.keyFacts,
    });

    await maybeRunVolumeSummary({
      request,
      userId,
      novelId,
      digestSources,
      systemPrompt,
      language,
      signal: lifecycle.signal,
      log,
    });
    try {
      volumeSummaries = await getVolumeSummaries(novelId);
    } catch (error) {
      console.warn('Failed to refresh volume summaries; retaining the last durable set.', error);
    }

    if (lifecycle.isCancelled()) {
      abortedReason = lease.hasLost() ? 'lock_failed' : 'aborted';
      if (abortedReason === 'lock_failed') {
        errorMessage = isZhLocale(language)
          ? '写作锁已丢失（另一个会话已接管）。'
          : 'Writing lock lost (another session took over).';
      }
      break;
    }

    latestProgress = progressForCompleted(completedChapters);
    sink.emit({
      type: 'chapter_done',
      chapterNumber: plan.chapterNumber,
      title: plan.title,
      content: outcome.content,
      wordCount: outcome.actualWords,
      qualityIssues: outcome.qualityIssues,
      ralphRevisions: outcome.ralphRevisions,
      progress: latestProgress,
      completedChapters,
      totalChapters: blueprint.chapters.length,
    });
    sink.emit({
      type: 'phase',
      phase: 'chapter_complete',
      progress: latestProgress,
      chapterNumber: plan.chapterNumber,
      chapterTitle: plan.title,
      completedChapters,
      totalChapters: blueprint.chapters.length,
      message: isZhLocale(language)
        ? `第 ${plan.chapterNumber} 章已完成`
        : `Chapter ${plan.chapterNumber} complete`,
    });
    await updateNovel(novelId, { progress: latestProgress });
    jobs.bumpProgress(plan.chapterNumber, ++seq);
    log(START_WRITING_EVENTS.chapterDone, {
      ch: plan.chapterNumber,
      words: outcome.actualWords,
      attempts: outcome.attempts,
      durationMs: Date.now() - chapterStartedAt,
    });
  }

  if (abortedReason === 'unknown' && sink.isClosed()) {
    abortedReason = 'controller_closed';
  }

  return {
    abortedReason,
    errorMessage,
    completedChapters,
    writtenThisBatch,
    latestProgress,
  };
}
