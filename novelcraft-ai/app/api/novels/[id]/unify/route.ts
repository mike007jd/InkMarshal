import { NextResponse } from 'next/server';
import {
  acquireWritingLock,
  getChapters,
  getNovel,
  isInStages,
  persistUnificationReportWithMessage,
  releaseWritingLock,
  renewWritingLock,
  STAGES_THAT_CAN_UNIFY,
  type UnificationEdit,
} from '@/lib/db';
import {
  buildUnificationBatches,
  generateUnificationReport,
  UNIFICATION_REPORT_LIMITS,
  type UnificationChapterInput,
} from '@/lib/ai';
import { buildNovelSystemPromptFromDB } from '@/lib/ai-context';
import { requireNovelOwner } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIStreamLifecycle, createAIUsageSession } from '@/lib/ai-usage';
import { isZhLocale, normalizeLocale } from '@/lib/i18n';
import { createStartWritingLogger, START_WRITING_EVENTS } from '@/lib/start-writing-logging';
import { sanitizeError } from '@/lib/utils';
import { resolveEmbeddingEndpointFromRequest } from '@/lib/knowledge/embedding';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/streaming-helpers';
import {
  applyAndPersistUnificationEdits,
  appendUnificationBatch,
  buildGlobalChapterMap,
  createUnificationReport,
} from '@/lib/whole-book-unification';

export const maxDuration = 300;

const LOCK_TTL_SEC = 600;
const GLOBAL_CHAPTER_MAP_BUDGET = 30_000;

// Streams the cross-chapter unification pass. Persists a structured report
// the user can review and selectively apply via /unify/apply.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user } = ownerCheck;

  const lock = await acquireWritingLock(id, LOCK_TTL_SEC);
  if (!lock) {
    return NextResponse.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  let lockTransferredToStream = false;
  try {
    const currentNovel = await getNovel(id);
    if (!currentNovel || currentNovel.userId !== user.id) {
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }

    if (!isInStages(currentNovel.stage, STAGES_THAT_CAN_UNIFY)) {
      return NextResponse.json(
        { error: 'Unification is only available after the full draft is written.' },
        { status: 409 },
      );
    }

    const chapters = await getChapters(id);
    if (chapters.length === 0) {
      return NextResponse.json({ error: 'No chapters to unify.' }, { status: 409 });
    }

    let unifyContextWindow: number | undefined;
    try {
      const unifyPreflightUsage = await createAIUsageSession(request, {
        userId: user.id,
        operation: 'unify',
      });
      unifyContextWindow = unifyPreflightUsage.runtimeModel.contextWindow;
    } catch (error) {
      const response = aiUsageErrorResponse(error);
      if (response) return response;
      throw error;
    }

    // Resolve the system prompt + knowledge context BEFORE opening the stream.
    // Returning 404 over an already-200 SSE error event leaves the client unable
    // to distinguish "novel missing" from a mid-stream crash.
    const locale = normalizeLocale(request.headers.get('x-locale'));
    // W2-C: unify uses the op-aware builder so it picks up FS-backed recall +
    // the unify-sized knowledge budget (all volume summaries).
    const promptResult = await buildNovelSystemPromptFromDB(
      id,
      locale,
      currentNovel,
      {
        op: 'unify',
        modelCtxTokens: unifyContextWindow,
        embeddingHint: resolveEmbeddingEndpointFromRequest(request),
      },
    );
    if (!promptResult) {
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }

    const log = createStartWritingLogger(id);

    const encoder = new TextEncoder();
    const lifecycle = createAIStreamLifecycle(request.signal);
    let streamLockReleasePromise: Promise<void> | null = null;
    const releaseStreamLockOnce = () => {
      streamLockReleasePromise ??= releaseWritingLock(id, lock.token);
      return streamLockReleasePromise;
    };
    const stream = new ReadableStream({
      async start(controller) {
      let closed = false;
      const send = (data: object) => {
        if (closed || lifecycle.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 5000);
      let renewingLock = false;
      let lockLost = false;
      const markLockLost = () => {
        if (lockLost) return;
        lockLost = true;
        log(START_WRITING_EVENTS.lockFailed, { reason: 'lock_lost_during_unification' });
        send({ type: 'error', error: 'Writing lock lost (another session took over).' });
        lifecycle.cancel();
      };
      const renewLock = async (): Promise<boolean> => {
        if (lockLost) return false;
        if (renewingLock) return true;
        renewingLock = true;
        try {
          const newExpiry = await renewWritingLock(id, lock.token, LOCK_TTL_SEC);
          if (newExpiry) {
            log(START_WRITING_EVENTS.lockRenewed, { expiresAt: new Date(newExpiry).toISOString() });
            return true;
          }
          markLockLost();
          return false;
        } catch {
          markLockLost();
          return false;
        } finally {
          renewingLock = false;
        }
      };
      // Renew at half the TTL. The previous `LOCK_TTL_SEC * 500` form happened
      // to equal half-TTL only because TTL is in seconds (×500ms ≈ ×1000ms/2),
      // which read like a unit bug and could silently renew slower than the TTL
      // if the constant changed. Make the half-TTL intent explicit.
      const lockRenewal = setInterval(() => {
        void renewLock();
      }, Math.max(1000, Math.floor((LOCK_TTL_SEC * 1000) / 2)));
      const startedAt = Date.now();

      try {
        log(START_WRITING_EVENTS.unifyStart, { chapters: chapters.length });
        send({ type: 'progress', message: isZhLocale(locale) ? '正在扫描全书一致性...' : 'Scanning full manuscript for consistency issues...' });

        const chapterDumps: UnificationChapterInput[] = chapters.map(c => ({
          chapterNumber: c.chapterNumber,
          title: c.title,
          content: c.content,
        }));
        const batches = buildUnificationBatches(chapterDumps);
        const knowledgeContext = [
          promptResult.knowledgeSummaries,
          buildGlobalChapterMap(chapters, GLOBAL_CHAPTER_MAP_BUDGET),
        ].filter(Boolean).join('\n\n');
        let mergedEdits: UnificationEdit[] = [];
        const summaries: string[] = [];
        let modelId = '';
        const pendingBatchUsages: Array<{
          recordUsage: () => Promise<void>;
          failUsage: () => Promise<void>;
          cancelUsage: () => Promise<void>;
        }> = [];
        const failPendingBatchUsages = async () => {
          await Promise.allSettled(pendingBatchUsages.map(p => p.failUsage()));
        };
        const cancelPendingBatchUsages = async () => {
          await Promise.allSettled(pendingBatchUsages.map(p => p.cancelUsage()));
        };

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          if (lifecycle.signal.aborted) {
            if (lockLost) await failPendingBatchUsages();
            else await cancelPendingBatchUsages();
            return;
          }
          if (!(await renewLock())) {
            await failPendingBatchUsages();
            return;
          }
          const batch = batches[batchIndex];
          let usage;
          try {
            usage = await createAIUsageSession(request, {
              userId: user.id,
              operation: 'unify',
            });
          } catch (error) {
            const r = aiUsageErrorResponse(error);
            await failPendingBatchUsages();
            send({
              type: 'error',
              error: r ? (await r.json().catch(() => ({})))?.error || 'AI usage error' : sanitizeError(error, 'AI usage error'),
            });
            return;
          }

          let usageSettled = false;
          const failUsageOnce = async () => {
            if (!usageSettled) {
              usageSettled = true;
              await usage.fail();
            }
          };
          const cancelUsageOnce = async () => {
            if (!usageSettled) {
              usageSettled = true;
              await usage.cancel();
            }
          };

          try {
            usage.addPromptText(promptResult.systemPrompt);
            usage.addPromptText(batch.map(c => c.content).join('\n\n'));
            const r = await generateUnificationReport({
              model: usage.model,
              novelContext: currentNovel,
              chapters: batch,
              knowledgeContext,
              language: locale,
              signal: lifecycle.signal,
              systemPrompt: promptResult.systemPrompt,
            });
            if (lifecycle.isCancelled()) {
              usage.addPartialOutput(JSON.stringify(r.result));
              if (lockLost) {
                await failUsageOnce();
                await failPendingBatchUsages();
              } else {
                await cancelUsageOnce();
                await cancelPendingBatchUsages();
              }
              return;
            }
            modelId = usage.runtimeModel.id;
            const merged = appendUnificationBatch(mergedEdits, r.result, { novelId: id });
            mergedEdits = merged.edits;
            if (merged.summary) summaries.push(merged.summary);
            usage.addPartialOutput(JSON.stringify(r.result));
            pendingBatchUsages.push({
              recordUsage: async () => {
                try {
                  await usage.recordUsage(r.usage);
                  usageSettled = true;
                } catch (error) {
                  await failUsageOnce();
                  throw error;
                }
              },
              failUsage: failUsageOnce,
              cancelUsage: cancelUsageOnce,
            });
            if (mergedEdits.length >= UNIFICATION_REPORT_LIMITS.edits) {
              log(START_WRITING_EVENTS.unifyDone, {
                edits: mergedEdits.length,
                capped: true,
              });
              break;
            }
          } catch (err) {
            if (lifecycle.isCancelled() && !lockLost) {
              await cancelUsageOnce();
              await cancelPendingBatchUsages();
            } else {
              await failUsageOnce();
              await failPendingBatchUsages();
            }
            throw err;
          }
          send({
            type: 'progress',
            message: isZhLocale(locale)
              ? `统稿扫描进度 ${batchIndex + 1}/${batches.length}`
              : `Unification scan ${batchIndex + 1}/${batches.length}`,
          });
        }

        if (lifecycle.isCancelled()) {
          if (lockLost) await failPendingBatchUsages();
          else await cancelPendingBatchUsages();
          return;
        }

        const report = createUnificationReport({ edits: mergedEdits, summaries, modelId });
        try {
          if (!(await renewLock())) {
            await failPendingBatchUsages();
            return;
          }
          const finalMsg = isZhLocale(locale)
            ? `统稿扫描完成：发现 ${mergedEdits.length} 处建议修订。`
            : `Unification scan complete: ${mergedEdits.length} suggested edits.`;
          await persistUnificationReportWithMessage(id, report, finalMsg);
          if (report.edits.length === 0) {
            applyAndPersistUnificationEdits({
              novelId: id,
              report,
              applyAll: true,
            });
          }
          for (const pendingUsage of pendingBatchUsages) {
            await pendingUsage.recordUsage();
          }

          log(START_WRITING_EVENTS.unifyDone, {
            edits: mergedEdits.length,
            batches: batches.length,
            durationMs: Date.now() - startedAt,
          });
          send({ type: 'done', report, message: finalMsg });
        } catch (error) {
          await failPendingBatchUsages();
          throw error;
        }
      } catch (err) {
        console.error('Unification error:', err);
        log(START_WRITING_EVENTS.error, { message: err instanceof Error ? err.message : String(err) });
        if (!lockLost) {
          send({ type: 'error', error: sanitizeError(err, 'Unification failed') });
        }
      } finally {
        clearInterval(heartbeat);
        clearInterval(lockRenewal);
        await releaseStreamLockOnce().catch(() => undefined);
        if (!closed) {
          try { controller.close(); } catch { /* already closed */ }
        }
      }
      },
      async cancel() {
        lifecycle.cancel();
        await releaseStreamLockOnce();
      },
    });

    lockTransferredToStream = true;
    return new Response(stream, {
      headers: {
        ...STREAMING_RESPONSE_HEADERS,
      },
    });
  } finally {
    if (!lockTransferredToStream) {
      await releaseWritingLock(id, lock.token).catch(() => undefined);
    }
  }
}
