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
import { normalizeRewriteContext, type RewriteContext } from '@/lib/rewrite-context';

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

  const parsed = await safeParseJsonObject<{ selectedText?: unknown; instruction?: unknown; context?: { before?: string; after?: string } }>(req);
  if (parsed.error) return parsed.error as NextResponse;
  const { selectedText, instruction, context } = parsed.data;
  if (typeof selectedText !== 'string' || typeof instruction !== 'string') return NextResponse.json({ error: 'selectedText and instruction required' }, { status: 400 });
  if (selectedText.length > 100_000 || instruction.length > 5_000) return NextResponse.json({ error: 'selectedText or instruction too large' }, { status: 400 });
  let normalizedContext: RewriteContext;
  try {
    normalizedContext = normalizeRewriteContext(context);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid context' }, { status: 400 });
  }

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
    aiUsage = await createAIUsageSession(req, { userId: ownerCheck.user.id, operation: 'polish' });
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) return response as NextResponse;
    throw error;
  }

  // Pass the user-selected style entry id through so the context builder
  // injects the style_reference block into the system prompt.
  // Missing/unknown styleId is harmless (resolveStyleReference returns null).
  const styleId = req.headers.get('x-im-style-id') || undefined;
  let contextResult: NonNullable<Awaited<ReturnType<typeof buildAIContext>>>;
  try {
    const resolvedContext = await buildAIContext({
      novelId,
      locale: requestLocale(req.headers),
      novel: ownerCheck.novel,
      op: 'rewrite',
      focus: {
        chapterNumber,
        selectedText,
        selectionTail: normalizedContext.before.slice(-2_000),
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

  const userMsg = `Rewrite the following text according to this instruction: "${instruction}"

Context before: ${normalizedContext.before || '(start of chapter)'}

--- TEXT TO REWRITE ---
${selectedText}
--- END ---

Context after: ${normalizedContext.after || '(end of chapter)'}

Return ONLY the rewritten text, nothing else.`;

  aiUsage.addPromptText(contextResult.systemPrompt + userMsg);

  // Polish-class operation: default = conservative (preserve voice, change as
  // little as required). Header lets the user pin balanced/wild if they want a
  // bigger rewrite swing. Mirrors the previous hard-coded 0.7.
  const preset = resolvePreset('polish', readCreativityHeader(req));

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
