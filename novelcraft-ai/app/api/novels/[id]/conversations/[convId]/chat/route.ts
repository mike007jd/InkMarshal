import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import {
  addMessageWithId,
  cancelChatTurn,
  failChatTurn,
  findNovelMessageById,
  hashChatTurnRequest,
} from '@/lib/db';
import { persistChatTurnAssistantMessage } from '@/lib/db/queries-chat-turns';
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
import {
  acquireChatTurnOrRespond,
  chatTurnCollisionResponse,
  deterministicAssistantMessageId,
} from '@/lib/chat-turn-helpers';

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

  const existingUserRow = findNovelMessageById(novelId, userMessage.id);
  if (existingUserRow && (
    existingUserRow.role !== 'user'
    || existingUserRow.content !== content
    || existingUserRow.conversationId !== convId
  )) {
    return chatTurnCollisionResponse();
  }

  const responseMessageId = deterministicAssistantMessageId(userMessage.id);
  const requestHash = hashChatTurnRequest({
    content,
    mode: 'conversation',
    conversationId: convId,
  });
  const claim = await acquireChatTurnOrRespond({
    novelId,
    userMessageId: userMessage.id,
    requestHash,
    assistantMessageId: responseMessageId,
    originalMessages,
    conversationId: convId,
  });
  if (claim.kind === 'response') return claim.response;
  const claimToken = claim.turn.claimToken;
  if (!claimToken) throw new Error('Acquired chat turn is missing its claim token');

  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(req, { userId: user.id, operation: 'chat' });
    aiUsage.addPromptText(content);
  } catch (error) {
    failChatTurn({
      novelId,
      userMessageId: userMessage.id,
      claimToken,
      errorCode: 'ai_usage',
    });
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
      failChatTurn({
        novelId,
        userMessageId: userMessage.id,
        claimToken,
        errorCode: 'novel_missing',
      });
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    contextResult = resolvedContext;
    const userAlreadyInChain = contextMessages.some(message => message.id === userMessage.id);
    chatHistory = [
      ...contextMessages.map(m => ({
        role: m.role as ChatMessage['role'],
        content: m.content,
      })),
      ...(userAlreadyInChain ? [] : [{ role: 'user' as const, content }]),
    ];
  } catch (error) {
    await aiUsage.fail();
    failChatTurn({
      novelId,
      userMessageId: userMessage.id,
      claimToken,
      errorCode: 'context_build',
    });
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
    responseMessageId,
    stoppedLabel,
    persistence: {
      persistUser: messageId => addMessageWithId(novelId, messageId, 'user', content, convId),
      persistAssistant: async (messageId, text) => {
        const message = persistChatTurnAssistantMessage({
          novelId,
          userMessageId: userMessage.id,
          claimToken,
          assistantMessageId: messageId,
          responseText: text,
          conversationId: convId,
        });
        if (!message) throw new Error('Chat turn claim lost before assistant persistence');
        return message;
      },
      persistStoppedAssistant: async (messageId, text) => {
        const message = persistChatTurnAssistantMessage({
          novelId,
          userMessageId: userMessage.id,
          claimToken,
          assistantMessageId: messageId,
          responseText: text,
          conversationId: convId,
        });
        if (!message) throw new Error('Chat turn claim lost before assistant persistence');
        return message;
      },
      markFailed: async () => {
        failChatTurn({
          novelId,
          userMessageId: userMessage.id,
          claimToken,
          errorCode: 'provider_failed',
        });
      },
      markCancelled: async () => {
        cancelChatTurn({ novelId, userMessageId: userMessage.id, claimToken });
      },
    },
    headers: {
      'X-Context-Pressure': budget.pressure,
      'X-Context-Tokens': formatTokensHeader(budget.estTokens, budget.ctxTokens),
    },
  });
}
