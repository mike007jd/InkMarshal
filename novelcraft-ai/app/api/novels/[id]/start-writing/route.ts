import { NextResponse } from 'next/server';
import {
  acquireWritingLock,
  getChapters,
  getKnowledgeEntries,
  getMessages,
  getNovel,
  isInStages,
  releaseWritingLock,
  STAGES_THAT_CAN_START_WRITING,
} from '@/lib/db';
import { buildNovelLanguageSignals } from '@/lib/ai';
import { buildAIContext } from '@/lib/ai-context-builder';
import { formatTokensHeader } from '@/lib/token-budget';
import { normalizeLocale } from '@/lib/i18n';
import { readCreativityHeader, resolvePreset } from '@/lib/ai/generation-presets';
import { createStartWritingLogger, START_WRITING_EVENTS } from '@/lib/start-writing-logging';
import { detectLanguage } from '@/lib/utils';
import { requireNovelOwner } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIStreamLifecycle, createAIUsageSession } from '@/lib/ai-usage';
import { parseStartWritingBatchParams } from '@/lib/start-writing-batch';
import { resolveEmbeddingEndpointFromRequest } from '@/lib/knowledge/embedding';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/streaming-helpers';
import { createWritingLease, WRITING_LOCK_TTL_SEC } from '@/lib/writing/lease';
import { createNdjsonWritingStream } from '@/lib/writing/ndjson-sink';
import { executeStartWriting, type WritingJobPort } from '@/lib/writing/start-writing-usecase';
import {
  bumpWritingJobProgress,
  createWritingJob,
  finalizeWritingJob,
} from '@/lib/db/queries-writing-jobs';

export const runtime = 'nodejs';
export {
  MAX_START_WRITING_CHAPTERS_PER_REQUEST,
  missingChapterNumbers,
  parseStartWritingBatchParams,
  shouldStopStartWritingBatch,
} from '@/lib/start-writing-batch';
// Long enough for many chapters in one connection while staying under platform
// limits. Client reconnects on disconnect; the persisted blueprint + per-chapter
// summaries make resume idempotent.
export const maxDuration = 300;

// This route is a thin adapter: owner/lock/preflight + AI-context build, then it
// hands the batch-writing orchestration to the use case (executeStartWriting)
// over an NDJSON stream. The loop, per-chapter steps, lock-lease, and run-history
// live in lib/writing/*; see lib/writing/start-writing-usecase.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user } = ownerCheck;

  // Pause-friendly batching: ?chapters=N (default 1) / ?untilChapter=k.
  const batchParams = parseStartWritingBatchParams(new URL(request.url).searchParams);
  if ('error' in batchParams) {
    return Response.json({ error: batchParams.error }, { status: 400 });
  }
  const { chaptersLimit, untilChapter } = batchParams;

  // Acquire the lock synchronously so a concurrent session gets a 409 before any
  // stream is created; the lease (renew/release) is handed to the stream below.
  const lock = await acquireWritingLock(id, WRITING_LOCK_TTL_SEC);
  if (!lock) {
    return Response.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  const currentNovel = await getNovel(id);
  if (!currentNovel || currentNovel.userId !== user.id) {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
    return Response.json({ error: 'Novel not found' }, { status: 404 });
  }
  if (!isInStages(currentNovel.stage, STAGES_THAT_CAN_START_WRITING)) {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
    return Response.json(
      { error: 'Writing can only be started after the outline is ready.' },
      { status: 409 },
    );
  }

  const storyDeckEntries = await getKnowledgeEntries(id);
  const storyDeckTypes = new Set(storyDeckEntries.map(entry => entry.type));
  const missingStoryDeckTypes = ['character', 'world', 'outline'].filter(
    type => !storyDeckTypes.has(type),
  );
  if (missingStoryDeckTypes.length > 0) {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
    return Response.json({
      code: 'STORY_DECK_INCOMPLETE',
      error: 'Story Deck is incomplete. Complete the character, world, and outline cards before writing.',
      missingTypes: missingStoryDeckTypes,
    }, { status: 409 });
  }

  const novel = currentNovel;
  let chapterContextWindow: number | undefined;
  try {
    const chapterPreflightUsage = await createAIUsageSession(request, { userId: user.id, operation: 'chapter' });
    chapterContextWindow = chapterPreflightUsage.runtimeModel.contextWindow;
  } catch (error) {
    await releaseWritingLock(id, lock.token);
    const response = aiUsageErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const locale = normalizeLocale(request.headers.get('x-locale'));
  // One `x-im-creativity` header drives chapter prose sampling for this whole
  // writing session (the outline phase uses its own planning default).
  const chapterPreset = resolvePreset('chapter', readCreativityHeader(request));
  let contextResult: Awaited<ReturnType<typeof buildAIContext>>;
  let history: Awaited<ReturnType<typeof getMessages>>;
  let existingChapters: Awaited<ReturnType<typeof getChapters>>;
  try {
    [contextResult, history, existingChapters] = await Promise.all([
      buildAIContext({
        novelId: id,
        locale,
        novel,
        op: 'chapter',
        modelCtxTokens: chapterContextWindow,
        embeddingHint: resolveEmbeddingEndpointFromRequest(request),
        // The loop owns rolling memory via a fresh per-chapter digest in the user
        // prompt; keep it out of the system prompt so it isn't sent twice.
        excludeRollingMemory: true,
      }),
      getMessages(id),
      getChapters(id),
    ]);
  } catch (error) {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
    throw error;
  }
  if (!contextResult) {
    await releaseWritingLock(id, lock.token);
    return Response.json({ error: 'Novel not found' }, { status: 404 });
  }
  const { systemPrompt, knowledgeSummaries } = contextResult;
  const initialBudget = contextResult.budget;
  const language = detectLanguage(buildNovelLanguageSignals(novel, history));
  const requestStartedAt = Date.now();
  const log = createStartWritingLogger(id);

  log(START_WRITING_EVENTS.lockAcquired, { token: lock.token, ttlSec: WRITING_LOCK_TTL_SEC });

  // Run-history: open the job AFTER the lock (createWritingJob reclaims any
  // crashed prior 'running' row). The port binds the use case's progress +
  // finalize writes to this job id.
  let job: ReturnType<typeof createWritingJob>;
  try {
    job = createWritingJob(id);
  } catch (error) {
    // createWritingJob writes to SQLite; if it throws, release the lock we just
    // acquired rather than leaking it until the TTL expires.
    await releaseWritingLock(id, lock.token).catch(() => undefined);
    throw error;
  }
  const jobs: WritingJobPort = {
    bumpProgress: (chapter, seq) => bumpWritingJobProgress(job.id, chapter, seq),
    finalize: (status, endReason, errorMessage) =>
      finalizeWritingJob(job.id, status, endReason, errorMessage),
  };

  const lifecycle = createAIStreamLifecycle(request.signal);
  const lease = createWritingLease(id, lock.token, log);

  const stream = createNdjsonWritingStream({
    signal: lifecycle.signal,
    lease,
    log,
    onTimerLockLost: () => lifecycle.cancel(),
    run: sink =>
      executeStartWriting(
        {
          novelId: id,
          userId: user.id,
          novel,
          request,
          systemPrompt,
          knowledgeSummaries,
          language,
          chapterPreset,
          existingChapters,
          messageCount: history.length,
          chaptersLimit,
          untilChapter,
          requestStartedAt,
          lifecycle,
          lease,
          jobs,
          log,
        },
        sink,
      ),
  });

  return new Response(stream, {
    headers: {
      ...STREAMING_RESPONSE_HEADERS,
      'X-Context-Pressure': initialBudget.pressure,
      'X-Context-Tokens': formatTokensHeader(initialBudget.estTokens, initialBudget.ctxTokens),
    },
  });
}
