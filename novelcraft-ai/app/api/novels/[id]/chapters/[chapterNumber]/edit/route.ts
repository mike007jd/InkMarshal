import { NextResponse } from 'next/server';
import {
  acquireWritingLock,
  addChatMessagePairSync,
  getChapter,
  releaseWritingLock,
  setChapterOriginalContent,
} from '@/lib/db';
import { getDb } from '@/lib/db/connection';
import { streamEdit, type ChapterEditChange } from '@/lib/ai';
import { buildAIContext } from '@/lib/ai-context-builder';
import { formatTokensHeader } from '@/lib/token-budget';
import { detectLanguage, sanitizeError, safeParseJsonObject } from '@/lib/utils';
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
const LOCK_TTL_SEC = 180;

interface EditPayload {
  instruction: string;
  selectedText?: string;
  fullText?: string;
  chatHistory?: { role: string; content: string }[];
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
  const instruction = body.instruction;
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

  if (!instruction || typeof instruction !== 'string') {
    return Response.json({ error: 'instruction is required' }, { status: 400 });
  }
  if (instruction.length > 5_000) {
    return Response.json({ error: 'Instruction too long (max 5000 chars)' }, { status: 400 });
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

        let sentChanges = 0;
        let lastObject: { changes?: ChapterEditChange[]; summary?: string } | null = null;

        const emitChange = (i: number, change: ChapterEditChange) => {
          send({ type: 'change', id: `c${i + 1}`, original: change.original, replacement: change.replacement });
          sentChanges = i + 1;
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
            for (let i = sentChanges; i < changes.length - 1; i++) {
              const change = changes[i];
              if (!change || typeof change.original !== 'string' || typeof change.replacement !== 'string') break;
              emitChange(i, change);
            }
          }

          if (lifecycle.isCancelled()) {
            await cancelUsageOnce();
            return;
          }

          const finalObject = await result.output;
          if (lifecycle.isCancelled()) {
            await cancelUsageOnce();
            return;
          }

          const finalChanges = (finalObject?.changes ?? []) as ChapterEditChange[];
          for (let i = sentChanges; i < finalChanges.length; i++) {
            const change = finalChanges[i];
            if (!change || typeof change.original !== 'string' || typeof change.replacement !== 'string') continue;
            emitChange(i, change);
          }

          const summary = (finalObject?.summary ?? lastObject?.summary ?? '') as string;
          const buffer = JSON.stringify(finalObject ?? lastObject ?? {});
          // Persist originalContent (first-edit baseline) AND the chat pair in
          // ONE transaction so a crash can't leave originalContent set without
          // the matching chat history (or vice versa). recordUsage is best-effort
          // usage accounting and stays outside the txn (it is async).
          const db = getDb();
          db.transaction(() => {
            if (chapter.originalContent === null) {
              setChapterOriginalContent(db, id, chapterNumber, chapter.content);
            }
            addChatMessagePairSync(
              db,
              id,
              chapterNumber,
              { role: 'user', content: instruction, status: 'done' },
              { role: 'assistant', content: buffer, status: 'done' },
            );
          })();

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
