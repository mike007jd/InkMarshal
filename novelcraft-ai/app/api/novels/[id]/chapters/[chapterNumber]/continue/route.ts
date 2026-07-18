import { NextResponse } from 'next/server';
import { streamText } from 'ai';
import { requireNovelOwner } from '@/lib/local-auth';
import { buildAIContext } from '@/lib/ai-context-builder';
import { formatTokensHeader } from '@/lib/token-budget';
import { aiUsageErrorResponse, createAIStreamLifecycle, createAIUsageSession, createStreamUsageCapture, streamTextWithAIUsageCleanup } from '@/lib/ai-usage';
import { safeParseJsonObject } from '@/lib/utils';
import { readCreativityHeader, resolvePreset } from '@/lib/ai/generation-presets';
import { requestLocale } from '@/lib/request-locale';
import { parsePositiveIntegerParam } from '@/lib/route-params';
import { acquireWritingLock, getChapter, releaseWritingLock, renewWritingLock } from '@/lib/db';
import { resolveEmbeddingEndpointFromRequest } from '@/lib/knowledge/embedding';
import { frameTextStreamWithCleanup, STREAMING_RESPONSE_HEADERS } from '@/lib/streaming-helpers';

export const runtime = 'nodejs';
export const maxDuration = 120;
const LOCK_TTL_SEC = 180;

export async function POST(req: Request, { params }: { params: Promise<{ id: string; chapterNumber: string }> }) {
  const { id: novelId, chapterNumber: chapterNumStr } = await params;
  const chapterNumber = parsePositiveIntegerParam(chapterNumStr);
  if (chapterNumber === null) {
    return NextResponse.json({ error: 'Invalid chapter number' }, { status: 400 });
  }

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const parsed = await safeParseJsonObject<{ contextBefore?: unknown; instruction?: unknown }>(req);
  if (parsed.error) return parsed.error as NextResponse;
  const { contextBefore, instruction } = parsed.data;
  if (typeof contextBefore !== 'string' || contextBefore.length > 200_000) return NextResponse.json({ error: 'contextBefore required' }, { status: 400 });
  if (instruction !== undefined && (typeof instruction !== 'string' || instruction.length > 5_000)) return NextResponse.json({ error: 'instruction invalid or too large' }, { status: 400 });

  const lock = await acquireWritingLock(novelId, LOCK_TTL_SEC);
  if (!lock) {
    return NextResponse.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }
  let lockTransferredToStream = false;
  let lockReleased = false;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  const releaseLockOnce = async () => {
    if (lockReleased) return;
    lockReleased = true;
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    await releaseWritingLock(novelId, lock.token).catch(() => undefined);
  };
  const renewLockOnce = async () => {
    const expiry = await renewWritingLock(novelId, lock.token, LOCK_TTL_SEC);
    if (!expiry) throw new Error('Writing lock lost (another session took over).');
  };

  try {
    if (!(await getChapter(novelId, chapterNumber))) {
      return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
    }
    await renewLockOnce();

  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(req, { userId: ownerCheck.user.id, operation: 'chapter' });
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) return response as NextResponse;
    throw error;
  }

  // Forward style-reference id when picked in the writing surface so the
  // system prompt includes the writer's voice notes.
  const styleId = req.headers.get('x-im-style-id') || undefined;
  let contextResult: NonNullable<Awaited<ReturnType<typeof buildAIContext>>>;
  try {
    const resolvedContext = await buildAIContext({
      novelId,
      locale: requestLocale(req.headers),
      novel: ownerCheck.novel,
      op: 'continue',
      focus: {
        chapterNumber,
        // Pass the cursor-prefix tail in case the builder needs it for
        // pressure-driven compression decisions.
        selectionTail: contextBefore.slice(-4_000),
      },
      modelCtxTokens: aiUsage.runtimeModel.contextWindow,
      styleId,
      embeddingHint: resolveEmbeddingEndpointFromRequest(req),
    });
    if (!resolvedContext) {
      await aiUsage.fail();
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    contextResult = resolvedContext;
  } catch (error) {
    await aiUsage.fail();
    throw error;
  }

  const userMsg = instruction
    ? `Continue writing from where this text ends. Instruction: ${instruction}\n\n---\n${contextBefore}`
    : `Continue writing seamlessly from where this text ends. Maintain the same tone, style, and narrative voice.\n\n---\n${contextBefore}`;

  aiUsage.addPromptText(contextResult.systemPrompt + userMsg);

  // Honour the `x-im-creativity` header — the picker on ManuscriptEditingView
  // lets the user pin a level (defaults to balanced for chapter drafting,
  // matching the previous hard-coded 0.8). resolvePreset spreads
  // temperature/topP/penalties; an absent/invalid header falls back to the
  // operation default from OPERATION_DEFAULT_CREATIVITY.
  const preset = resolvePreset('chapter', readCreativityHeader(req));

  const lifecycle = createAIStreamLifecycle(req.signal);
  const capture = createStreamUsageCapture(aiUsage, lifecycle);

  let result: ReturnType<typeof streamText>;
  try {
    result = streamText({
      model: aiUsage.model,
      system: contextResult.systemPrompt,
      prompt: userMsg,
      ...preset,
      abortSignal: lifecycle.signal,
      onFinish: event => capture.recordFinish(event),
      onError: ({ error }) => capture.recordError(error),
    });
  } catch (error) {
    const wasCancelled = lifecycle.isCancelled();
    lifecycle.cancel();
    capture.abandon();
    if (wasCancelled) await aiUsage.cancel();
    else await aiUsage.fail();
    throw error;
  }

  renewTimer = setInterval(() => {
    void renewLockOnce().catch(async () => {
      await aiUsage.fail();
      lifecycle.cancel();
    });
  }, Math.max(30_000, Math.floor((LOCK_TTL_SEC * 1000) / 2)));

  const textStreamWithLockRelease = frameTextStreamWithCleanup(
    result.textStream,
    releaseLockOnce,
    capture.framing,
  );
  const stream = streamTextWithAIUsageCleanup(textStreamWithLockRelease, aiUsage, lifecycle.signal, {
    onCancel: async () => {
      lifecycle.cancel();
      await releaseLockOnce();
    },
  });
  const { budget } = contextResult;
  lockTransferredToStream = true;
  return new Response(stream, {
    headers: {
      ...STREAMING_RESPONSE_HEADERS,
      'X-Context-Pressure': budget.pressure,
      'X-Context-Tokens': formatTokensHeader(budget.estTokens, budget.ctxTokens),
    },
  });
  } finally {
    if (!lockTransferredToStream) {
      await releaseLockOnce();
    }
  }
}
