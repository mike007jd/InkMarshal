// POST /api/novels/[id]/conversations/[convId]/messages/[messageId]/extract
//
// Wave 2 commit E. Given an assistant message in a ConversationThread, ask
// the recall-class model to distill it into a structured knowledge-entry
// prefill ({ type, title, summary, data, suggestedWikilinks, suggestedRelations }).
// Returns the prefill JSON; never writes to the DB or vault — the frontend
// opens KnowledgeEntryForm with the prefill so the user can review/save.
//
// Degradation chain:
//   1. Local-user + novel-ownership checks (same shape as the messages route).
//   2. Lookup the message; verify it is visible in this conversation's fork chain.
//   3. Try createAIUsageSession({ operation: 'summarize' }) — resolves to the
//      `recall` role. If no model bound → return 200 with the manual stub so
//      the form still opens.
//   4. extractEntryFromMessage swallows abort/validation/model errors and
//      returns the stub itself; the route layer just relays.

import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIUsageSession } from '@/lib/ai-usage';
import { resolveFullMessageChain, verifyConversationOwnership } from '@/lib/conversations';
import { safeParseJsonObject } from '@/lib/utils';
import { requestLocale } from '@/lib/request-locale';
import {
  buildExtractStub,
  extractEntryFromMessageResult,
} from '@/lib/ai/conversation-extract';
import { KNOWLEDGE_TYPES, type KnowledgeType } from '@/lib/types/knowledge';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface ExtractRequestBody {
  targetType?: string;
}

function looksLikeKnowledgeType(value: string): value is KnowledgeType {
  return (KNOWLEDGE_TYPES as readonly string[]).includes(value);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; convId: string; messageId: string }> },
) {
  const { id: novelId, convId, messageId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  if (!(await verifyConversationOwnership(convId, novelId, ownerCheck.user.id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Body is optional — { targetType?: KnowledgeType }. We accept either an
  // empty body (Content-Type: application/json with `{}`) or no body at all.
  let targetType: KnowledgeType | undefined;
  if (req.headers.get('content-type')?.includes('application/json')) {
    const parsed = await safeParseJsonObject<ExtractRequestBody>(req);
    if (parsed.error) return parsed.error as NextResponse;
    const raw = parsed.data.targetType;
    if (typeof raw === 'string' && looksLikeKnowledgeType(raw)) targetType = raw;
  }

  // Verify the message is visible in this conversation's resolved fork chain.
  // Parent-chain messages are rendered in the thread and should be extractable,
  // but unrelated same-novel conversations must not become addressable here.
  const row = (await resolveFullMessageChain(novelId, convId, ownerCheck.user.id)).find(message => message.id === messageId);
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  // Only assistant messages get the structured extractor — extracting a user
  // prompt would just echo back their words. (Plan §4.1 — assistant-only.)
  if (row.role !== 'assistant') {
    return NextResponse.json({ error: 'Only assistant messages can be extracted' }, { status: 400 });
  }

  // Try to bind a recall-class model. If nothing's available we still return
  // 200 with a manual stub so the form opens.
  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(req, {
      userId: ownerCheck.user.id,
      operation: 'summarize',
    });
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) {
      return NextResponse.json(
        { ...buildExtractStub(row.content, targetType), _modelUnavailable: true },
        { status: 200 },
      );
    }
    throw error;
  }

  aiUsage.addPromptText(row.content.slice(0, 4_000));
  let result: Awaited<ReturnType<typeof extractEntryFromMessageResult>>;
  try {
    result = await extractEntryFromMessageResult({
      messageContent: row.content,
      model: aiUsage.model,
      targetType,
      locale: requestLocale(req.headers),
      signal: req.signal,
    });
  } catch (err) {
    // extractEntryFromMessageResult re-throws on user-initiated cancel (it must
    // not masquerade an abort as a succeeded-with-stub). Settle usage and
    // return 499 here rather than letting the abort escape as an unhandled 500.
    if (req.signal.aborted) {
      await aiUsage.cancel();
      return new Response(null, { status: 499 });
    }
    await aiUsage.fail();
    throw err;
  }
  if (req.signal.aborted) {
    await aiUsage.cancel();
    return new Response(null, { status: 499 });
  }
  if (!result.ok) {
    await aiUsage.fail();
    return NextResponse.json({ ...result.entry, _degraded: true });
  }
  await aiUsage.recordUsage(undefined);

  return NextResponse.json(result.entry);
}
