import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { addMessageWithId } from '@/lib/db';
import { type ChatMessage } from '@/lib/ai';
import { buildAIContext } from '@/lib/ai-context-builder';
import { formatTokensHeader } from '@/lib/token-budget';
import { resolveFullMessageChain, verifyConversationOwnership } from '@/lib/conversations';
import { aiUsageErrorResponse, createAIUsageSession } from '@/lib/ai-usage';
import { streamChatTurnResponse } from '@/lib/chat-stream-route';
import { safeParseJsonObject } from '@/lib/utils';
import { readCreativityHeader, resolvePreset } from '@/lib/ai/generation-presets';
import { requestLocale } from '@/lib/request-locale';
import { resolveEmbeddingEndpointFromRequest } from '@/lib/knowledge/embedding';
import { parseRequiredMessageContent } from '@/lib/message-content';
import { buildUserMessageContentWithAttachments } from '@/lib/chat-attachments.server';
import {
  findLatestUserMessage,
  parseNovelChatUIMessages,
  type NovelChatUIMessage,
} from '@/lib/chat-ui-message';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id: novelId, convId } = await params;
  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user, novel } = ownerCheck;

  if (!(await verifyConversationOwnership(convId, novelId, user.id))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = await safeParseJsonObject<{ content?: unknown; messages?: unknown; stoppedLabel?: unknown }>(
    req,
    { maxBytes: 20 * 1024 * 1024 },
  );
  if (parsed.error) return parsed.error as NextResponse;
  const requestMessages = parseNovelChatUIMessages(parsed.data.messages);
  const submittedUserMessage = findLatestUserMessage(requestMessages);
  const submittedContent = submittedUserMessage
    ? await buildUserMessageContentWithAttachments(submittedUserMessage)
    : { content: typeof parsed.data.content === 'string' ? parsed.data.content : '', errors: [] };
  if (submittedContent.errors.length > 0) {
    return NextResponse.json({ error: submittedContent.errors[0] }, { status: 400 });
  }
  const content = parseRequiredMessageContent(submittedContent.content);
  if (content === null) {
    return NextResponse.json({ error: 'Message content invalid or too large' }, { status: 400 });
  }
  const stoppedLabel = typeof parsed.data.stoppedLabel === 'string'
    ? parseRequiredMessageContent(parsed.data.stoppedLabel) ?? undefined
    : undefined;
  const userMessage: NovelChatUIMessage = submittedUserMessage ?? {
    id: crypto.randomUUID(),
    role: 'user',
    metadata: { conversationId: convId, persisted: false },
    parts: [{ type: 'text', text: content, state: 'done' }],
  };
  const originalMessages = requestMessages.length > 0 ? requestMessages : [userMessage];

  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(req, { userId: user.id, operation: 'chat' });
    aiUsage.addPromptText(content);
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) return response as NextResponse;
    throw error;
  }

  // Pass the style entry id into the context builder so chat replies stay in
  // the user's chosen voice.
  const styleId = req.headers.get('x-im-style-id') || undefined;
  let contextResult: NonNullable<Awaited<ReturnType<typeof buildAIContext>>>;
  let chatHistory: ChatMessage[];
  try {
    const [resolvedContext, contextMessages] = await Promise.all([
      buildAIContext({
        novelId,
        locale: requestLocale(req.headers),
        novel,
        op: 'chat',
        focus: { conversationId: convId },
        modelCtxTokens: aiUsage.runtimeModel.contextWindow,
        styleId,
        embeddingHint: resolveEmbeddingEndpointFromRequest(req),
      }),
      resolveFullMessageChain(novelId, convId, user.id),
    ]);
    if (!resolvedContext) {
      await aiUsage.fail();
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    contextResult = resolvedContext;
    chatHistory = [
      ...contextMessages.map(m => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
      })),
      { role: 'user' as const, content },
    ];
  } catch (error) {
    await aiUsage.fail();
    throw error;
  }
  aiUsage.addPromptText(contextResult.systemPrompt + JSON.stringify(chatHistory));

  // Chat default = balanced; header pinning lets brainstorm chats lean wild
  // while plot-tightening chats lean conservative (balanced preset = 0.75).
  const { budget } = contextResult;
  return streamChatTurnResponse({
    aiUsage,
    requestSignal: req.signal,
    system: contextResult.systemPrompt,
    history: chatHistory,
    preset: resolvePreset('chat', readCreativityHeader(req)),
    originalMessages,
    submittedUserMessage: userMessage,
    responseMessageId: crypto.randomUUID(),
    stoppedLabel,
    persistence: {
      persistUser: messageId => addMessageWithId(novelId, messageId, 'user', content, convId),
      persistAssistant: (messageId, text) => addMessageWithId(novelId, messageId, 'assistant', text, convId),
    },
    headers: {
      'X-Context-Pressure': budget.pressure,
      'X-Context-Tokens': formatTokensHeader(budget.estTokens, budget.ctxTokens),
    },
  });
}
