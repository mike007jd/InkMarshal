import { NextResponse } from 'next/server';
import {
  acquireWritingLock,
  commitTerminalEditChatPairSync,
  getChapter,
  getChatHistory,
  releaseWritingLock,
  setChapterOriginalContent,
} from '@/lib/db';
import { getDb } from '@/lib/db/connection';
import { streamEdit, type ChapterEditChange } from '@/lib/ai';
import { buildAIContext } from '@/lib/ai-context-builder';
import { isEffectiveTextReplacement } from '@/lib/diff-utils';
import { formatTokensHeader } from '@/lib/token-budget';
import { detectLanguage, isUuid, sanitizeError, safeParseJsonObject } from '@/lib/utils';
import { requireNovelOwner } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIStreamLifecycle, createAIUsageSession, type ProviderUsage } from '@/lib/ai-usage';
import { readCreativityHeader, resolvePreset } from '@/lib/ai/generation-presets';
import { requestLocale } from '@/lib/request-locale';
import { parsePositiveIntegerParam } from '@/lib/route-params';
import { resolveEmbeddingEndpointFromRequest } from '@/lib/knowledge/embedding';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/streaming-helpers';

export const runtime = 'nodejs';
export const maxDuration = 120;

const VALID_ROLES = new Set(['user', 'assistant']);
const SELECTED_TEXT_MAX_CHARS = 100_000;
const FULL_TEXT_MAX_CHARS = 500_000;
const INSTRUCTION_MAX_CHARS = 5_000;
/** Client-localized Stop label bound; never invent server locale text. */
export const STOPPED_LABEL_MAX_CHARS = 200;
const LOCK_TTL_SEC = 180;

interface EditPayload {
  instruction: string;
  selectedText?: string;
  fullText?: string;
  chatHistory?: { role: string; content: string }[];
  runId?: string;
}

interface EditStopPayload {
  runId?: string;
  instruction?: string;
  stoppedLabel?: string;
}

type NormalizedEditChatMessage = { role: 'user' | 'assistant'; content: string };

export function normalizeOptionalEditText(
  value: unknown,
  field: 'selectedText' | 'fullText',
  maxChars: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  if (value.length > maxChars) {
    throw new Error(field === 'fullText' ? 'Chapter text too large' : 'Selected text too large');
  }
  return value;
}

export function normalizeEditChatHistory(value: unknown): NormalizedEditChatMessage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('Chat history invalid');
  }
  if (value.length > 50) {
    throw new Error('Chat history too long (max 50 messages)');
  }
  return value.map(message => {
    if (!message || typeof message !== 'object') {
      throw new Error('Chat history invalid');
    }
    const record = message as Record<string, unknown>;
    if (!VALID_ROLES.has(record.role as string) || typeof record.content !== 'string') {
      throw new Error('Chat history invalid');
    }
    if (record.content.length > 50_000) {
      throw new Error('Chat history invalid or too large');
    }
    return {
      role: record.role as 'user' | 'assistant',
      content: record.content,
    };
  });
}

/** Client-localized Stop label; max ~200 chars; never invent server locale text. */
export function normalizeEditStoppedLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > STOPPED_LABEL_MAX_CHARS) return undefined;
  return trimmed;
}

export function normalizeEditRunId(value: unknown): string | undefined {
  return isUuid(value) ? value : undefined;
}

export function normalizeEditInstruction(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > INSTRUCTION_MAX_CHARS) {
    throw new Error('Instruction too long');
  }
  return trimmed;
}

/**
 * GET — authenticated chapter-scoped durable edit transcript
 * (`chapter_chat_history`) for reload hydration.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; chapterNumber: string }> },
) {
  const { id, chapterNumber: chapterNumStr } = await params;
  const chapterNumber = parsePositiveIntegerParam(chapterNumStr);
  if (chapterNumber === null) {
    return NextResponse.json({ error: 'Invalid chapter number' }, { status: 400 });
  }

  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const chapter = await getChapter(id, chapterNumber);
  if (!chapter) {
    return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
  }

  const messages = await getChatHistory(id, chapterNumber);
  return NextResponse.json(
    { messages },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * PATCH — explicit user Stop acknowledgement.
 * Idempotent by runId; races safely with successful completion. Generic POST
 * abort/cancel must never call this path.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; chapterNumber: string }> },
) {
  const { id, chapterNumber: chapterNumStr } = await params;
  const chapterNumber = parsePositiveIntegerParam(chapterNumStr);
  if (chapterNumber === null) {
    return NextResponse.json({ error: 'Invalid chapter number' }, { status: 400 });
  }

  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const chapter = await getChapter(id, chapterNumber);
  if (!chapter) {
    return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
  }

  const parsed = await safeParseJsonObject<Partial<EditStopPayload>>(request);
  if (parsed.error) return parsed.error;

  const runId = normalizeEditRunId(parsed.data.runId);
  let instruction: string | undefined;
  try {
    instruction = normalizeEditInstruction(parsed.data.instruction);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid instruction' },
      { status: 400 },
    );
  }
  const stoppedLabel = normalizeEditStoppedLabel(parsed.data.stoppedLabel);

  if (!runId) {
    return NextResponse.json({ error: 'runId is required' }, { status: 400 });
  }
  if (!instruction) {
    return NextResponse.json({ error: 'instruction is required' }, { status: 400 });
  }
  if (!stoppedLabel) {
    return NextResponse.json({ error: 'stoppedLabel is required' }, { status: 400 });
  }

  const terminal = commitTerminalEditChatPairSync(
    getDb(),
    id,
    chapterNumber,
    runId,
    { role: 'user', content: instruction, status: 'cancelled' },
    { role: 'assistant', content: stoppedLabel, status: 'cancelled' },
  );

  return NextResponse.json(
    { status: terminal.status, outcome: terminal.outcome },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; chapterNumber: string }> },
) {
  const { id, chapterNumber: chapterNumStr } = await params;
  const chapterNumber = parsePositiveIntegerParam(chapterNumStr);
  if (chapterNumber === null) {
    return Response.json({ error: 'Invalid chapter number' }, { status: 400 });
  }

  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user, novel } = ownerCheck;

  const parsed = await safeParseJsonObject<Partial<EditPayload>>(request);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const runId = normalizeEditRunId(body.runId);
  if (!runId) {
    return Response.json({ error: 'runId is required' }, { status: 400 });
  }
  let instruction: string | undefined;
  try {
    instruction = normalizeEditInstruction(body.instruction);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid instruction' },
      { status: 400 },
    );
  }
  if (!instruction) {
    return Response.json({ error: 'instruction is required' }, { status: 400 });
  }
  let selectedText: string | undefined;
  let requestedFullText: string | undefined;
  try {
    selectedText = normalizeOptionalEditText(body.selectedText, 'selectedText', SELECTED_TEXT_MAX_CHARS);
    requestedFullText = normalizeOptionalEditText(body.fullText, 'fullText', FULL_TEXT_MAX_CHARS);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Invalid edit text' },
      { status: 400 },
    );
  }
  let chatHistory: NormalizedEditChatMessage[];
  try {
    chatHistory = normalizeEditChatHistory(body.chatHistory);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Chat history invalid' },
      { status: 400 },
    );
  }

  const lock = await acquireWritingLock(id, LOCK_TTL_SEC);
  if (!lock) {
    return Response.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  let lockTransferredToStream = false;
  let lockReleased = false;
  const releaseLockOnce = async () => {
    if (lockReleased) return;
    lockReleased = true;
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  };

  try {
    const chapter = await getChapter(id, chapterNumber);
    if (!chapter) {
      return Response.json({ error: 'Chapter not found' }, { status: 404 });
    }
    const chapterText = requestedFullText || chapter.content;
    const novelContext = { title: novel.title, genre: novel.genre };

    let aiUsage;
    try {
      aiUsage = await createAIUsageSession(request, { userId: user.id, operation: 'polish' });
      aiUsage.addPromptText(JSON.stringify({ instruction, selectedText, chapterText, chatHistory, novelContext }));
    } catch (error) {
      const response = aiUsageErrorResponse(error);
      if (response) return response;
      throw error;
    }

    // Resolve the unified novel context (knowledge + minimal memory, no
    // earlier-chapter tails) so the edit model sees consistent world/character
    // names while making surgical changes.
    // Forward `x-im-style-id` so a user-selected style entry tints the system
    // prompt during edits too — same plumbing as rewrite.
    const styleId = request.headers.get('x-im-style-id') || undefined;
    let contextResult: NonNullable<Awaited<ReturnType<typeof buildAIContext>>>;
    try {
      const resolvedContext = await buildAIContext({
        novelId: id,
        locale: requestLocale(request.headers),
        novel,
        op: 'edit',
        focus: { chapterNumber, selectedText },
        modelCtxTokens: aiUsage.runtimeModel.contextWindow,
        styleId,
        embeddingHint: resolveEmbeddingEndpointFromRequest(request),
      });
      if (!resolvedContext) {
        await aiUsage.fail();
        return Response.json({ error: 'Novel not found' }, { status: 404 });
      }
      contextResult = resolvedContext;
    } catch (error) {
      await aiUsage.fail();
      throw error;
    }

    const language = detectLanguage([chapterText]);
    const encoder = new TextEncoder();

    // Edit is a polish-class operation: default = conservative so surgical
    // edits don't drift the chapter voice. Header lets the user pin
    // balanced/wild for bigger rewrites; resolvePreset returns sane fallbacks
    // when the header is missing or invalid.
    const preset = resolvePreset('polish', readCreativityHeader(request));

    const lifecycle = createAIStreamLifecycle(request.signal);
    let usageSettled = false;
    let pendingUsage: ProviderUsage | undefined;
    const failUsageOnce = async () => {
      if (!usageSettled) {
        usageSettled = true;
        await aiUsage.fail();
      }
    };
    const cancelUsageOnce = async () => {
      if (!usageSettled) {
        usageSettled = true;
        await aiUsage.cancel(pendingUsage);
      }
    };

    let result: ReturnType<typeof streamEdit>;
    try {
      result = streamEdit({
        model: aiUsage.model,
        novelContext,
        chapterText,
        instruction,
        selectedText,
        chatHistory,
        language,
        signal: lifecycle.signal,
        novelSystemPrompt: contextResult.systemPrompt,
        preset,
        onFinish: async ({ object, usage }) => {
          if (lifecycle.isCancelled()) {
            if (object?.summary) aiUsage.addPartialOutput(object.summary);
            pendingUsage = usage;
            await cancelUsageOnce();
            return;
          }
          const json = object ? JSON.stringify(object) : '';
          if (json) aiUsage.addPartialOutput(json);
          pendingUsage = usage;
        },
      });
    } catch (error) {
      const wasCancelled = lifecycle.isCancelled();
      lifecycle.cancel();
      if (wasCancelled) await cancelUsageOnce();
      else await failUsageOnce();
      throw error;
    }

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: object) => {
          if (lifecycle.signal.aborted) return;
          controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
        };

        let processedChanges = 0;
        let emittedChanges = 0;
        let lastObject: { changes?: ChapterEditChange[]; summary?: string } | null = null;

        const emitChange = (change: ChapterEditChange) => {
          if (!isEffectiveTextReplacement(change)) return;
          emittedChanges += 1;
          send({
            type: 'change',
            id: `c${emittedChanges}`,
            original: change.original,
            replacement: change.replacement,
          });
        };

        try {
          send({ type: 'thinking' });

          for await (const partial of result.partialOutputStream) {
            if (lifecycle.signal.aborted) break;
            lastObject = partial as { changes?: ChapterEditChange[]; summary?: string };

            const changes = lastObject.changes ?? [];
            // Stream the second-to-last entries as they become complete; the
            // tail entry can still be growing, so it's only emitted in the
            // post-stream flush below where result.output guarantees it's done.
            for (let i = processedChanges; i < changes.length - 1; i++) {
              const change = changes[i];
              if (!change || typeof change.original !== 'string' || typeof change.replacement !== 'string') break;
              emitChange(change);
              processedChanges = i + 1;
            }
          }

          if (lifecycle.isCancelled()) {
            // Generic abort/cancel must never persist Stopped — only explicit
            // PATCH Stop acknowledgement writes a cancelled terminal pair.
            await cancelUsageOnce();
            return;
          }

          const finalObject = await result.output;
          if (lifecycle.isCancelled()) {
            await cancelUsageOnce();
            return;
          }

          const finalChanges = (finalObject?.changes ?? []) as ChapterEditChange[];
          for (let i = processedChanges; i < finalChanges.length; i++) {
            const change = finalChanges[i];
            if (!change || typeof change.original !== 'string' || typeof change.replacement !== 'string') continue;
            emitChange(change);
          }

          const summary = (finalObject?.summary ?? lastObject?.summary ?? '') as string;
          const effectiveFinalObject = {
            ...(finalObject ?? lastObject ?? {}),
            changes: finalChanges.filter(isEffectiveTextReplacement),
          };
          const buffer = JSON.stringify(effectiveFinalObject);
          // Persist originalContent (first-edit baseline) AND the successful
          // chat pair in ONE transaction, keyed by runId so a cancelled
          // terminal that already won blocks both writes and done emission.
          // recordUsage stays outside the txn (async, best-effort).
          const db = getDb();
          const terminal = db.transaction(() => {
            const result = commitTerminalEditChatPairSync(
              db,
              id,
              chapterNumber,
              runId,
              { role: 'user', content: instruction, status: 'done' },
              { role: 'assistant', content: buffer, status: 'done' },
            );
            if (result.outcome === 'inserted' && result.status === 'done') {
              if (chapter.originalContent === null) {
                setChapterOriginalContent(db, id, chapterNumber, chapter.content);
              }
            }
            return result;
          })();

          if (terminal.status !== 'done') {
            await cancelUsageOnce();
            return;
          }

          await aiUsage.recordUsage(pendingUsage);
          usageSettled = true;
          send({ type: 'done', summary });
        } catch (err) {
          console.error('Edit error:', err);
          if (lifecycle.isCancelled()) await cancelUsageOnce();
          else await failUsageOnce();
          send({ type: 'error', error: sanitizeError(err) });
        } finally {
          await releaseLockOnce();
          try { controller.close(); } catch { /* already closed */ }
        }
      },
      async cancel() {
        lifecycle.cancel();
        await Promise.allSettled([
          cancelUsageOnce(),
          releaseLockOnce(),
        ]);
      },
    });

    const headers: Record<string, string> = { ...STREAMING_RESPONSE_HEADERS };
    headers['X-Context-Pressure'] = contextResult.budget.pressure;
    headers['X-Context-Tokens'] = formatTokensHeader(
      contextResult.budget.estTokens,
      contextResult.budget.ctxTokens,
    );
    lockTransferredToStream = true;
    return new Response(stream, { headers });
  } finally {
    if (!lockTransferredToStream) {
      await releaseLockOnce();
    }
  }
}
