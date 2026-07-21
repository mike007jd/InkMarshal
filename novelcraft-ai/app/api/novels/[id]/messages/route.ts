import { NextResponse } from 'next/server';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  hasToolCall,
  stepCountIs,
} from 'ai';
import { addMessageWithId, getMessages } from '@/lib/db';
import { type ChatMessage } from '@/lib/ai';
import { buildAIContext } from '@/lib/ai-context-builder';
import { formatTokensHeader } from '@/lib/token-budget';
import { requireNovelOwner } from '@/lib/local-auth';
import { safeParseJsonObject, toChatHistory } from '@/lib/utils';
import { aiUsageErrorResponse, createAIUsageSession } from '@/lib/ai-usage';
import { streamChatTurnResponse } from '@/lib/chat-stream-route';
import { normalizeLocale, type Locale } from '@/lib/i18n';
import { readCreativityHeader, resolvePreset } from '@/lib/ai/generation-presets';
import { resolveEmbeddingEndpointFromRequest } from '@/lib/knowledge/embedding';
import { parseRequiredMessageContent } from '@/lib/message-content';
import {
  brainstormAgentSystemAddon,
  createBrainstormTools,
  finalizeApprovedStoryDeck,
} from '@/lib/brainstorm-agent';
import { beginBrainstormReceipt } from '@/lib/brainstorm-receipts';
import { buildUserMessageContentWithAttachments } from '@/lib/chat-attachments.server';
import {
  findLatestUserMessage,
  parseNovelChatUIMessages,
  type NovelChatUIMessage,
} from '@/lib/chat-ui-message';

export const runtime = 'nodejs';
export const maxDuration = 300;

export function normalizeLegacyChatLanguageInput(value: unknown): Locale {
  return normalizeLocale(typeof value === 'string' ? value : undefined);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const messages = await getMessages(id);
  return NextResponse.json(messages);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user, novel } = ownerCheck;

  const parsed = await safeParseJsonObject<{
    content?: unknown;
    language?: unknown;
    messages?: unknown;
    stoppedLabel?: unknown;
    repairStoryDeck?: unknown;
  }>(request, { maxBytes: 20 * 1024 * 1024 });
  if (parsed.error) return parsed.error as NextResponse;
  const { language } = parsed.data;
  const repairStoryDeck = parsed.data.repairStoryDeck === true;
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
  const locale = normalizeLegacyChatLanguageInput(language);
  const userMessage: NovelChatUIMessage = submittedUserMessage ?? {
    id: crypto.randomUUID(),
    role: 'user',
    metadata: { conversationId: null, persisted: false },
    parts: [{ type: 'text', text: content, state: 'done' }],
  };
  const userMessageAlreadyPersisted = userMessage.metadata?.persisted === true;
  const originalMessages = requestMessages.length > 0 ? requestMessages : [userMessage];

  if (repairStoryDeck) {
    const receiptId = beginBrainstormReceipt(id);
    const result = await finalizeApprovedStoryDeck(id, locale, receiptId);
    if (!result.ok) {
      return NextResponse.json({
        code: 'STORY_DECK_REPAIR_FAILED',
        error: 'The approved Story Deck could not be completed.',
        reason: result.reason,
      }, { status: 409 });
    }
    if (!userMessageAlreadyPersisted) {
      await addMessageWithId(id, userMessage.id, 'user', content);
    }
    const responseMessageId = crypto.randomUUID();
    const completionText = locale === 'en'
      ? 'Story Deck completed: character, world, and outline cards are ready for review.'
      : locale === 'zh-TW'
        ? 'Story Deck 已補全：角色、世界觀與大綱卡片已可供審閱。'
        : 'Story Deck 已补全：角色、世界观和大纲卡片已可供审阅。';
    const assistantMessage = await addMessageWithId(
      id,
      responseMessageId,
      'assistant',
      completionText,
    );
    const textId = crypto.randomUUID();
    const metadata = {
      createdAt: assistantMessage.createdAt,
      conversationId: assistantMessage.conversationId ?? null,
      persisted: true,
    };
    const stream = createUIMessageStream<NovelChatUIMessage>({
      originalMessages,
      generateId: () => responseMessageId,
      execute: ({ writer }) => {
        writer.write({ type: 'start', messageId: responseMessageId, messageMetadata: metadata });
        writer.write({ type: 'text-start', id: textId });
        writer.write({ type: 'text-delta', id: textId, delta: completionText });
        writer.write({ type: 'text-end', id: textId });
        writer.write({ type: 'finish', finishReason: 'stop', messageMetadata: metadata });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(request, { userId: user.id, operation: 'chat' });
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) return response as NextResponse;
    throw error;
  }

  let contextResult: NonNullable<Awaited<ReturnType<typeof buildAIContext>>>;
  let history: ChatMessage[];
  let systemPrompt = '';
  try {
    // Serial, not Promise.all: if the SELECT lands after the INSERT commits the
    // history already contains this turn and the explicit append below would
    // duplicate it (extra tokens + confused prompt).
    const existingHistory = toChatHistory(await getMessages(id));
    history = userMessageAlreadyPersisted
      ? existingHistory
      : [...existingHistory, { role: 'user', content }];
    const resolvedContext = await buildAIContext({
      novelId: id,
      locale,
      novel,
      op: 'chat',
      modelCtxTokens: aiUsage.runtimeModel.contextWindow,
      styleId: request.headers.get('x-im-style-id') || undefined,
      embeddingHint: resolveEmbeddingEndpointFromRequest(request),
    });
    if (!resolvedContext) {
      await aiUsage.fail();
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    contextResult = resolvedContext;
    systemPrompt = `${contextResult.systemPrompt}\n\n${brainstormAgentSystemAddon(locale, novel.stage)}`;
    aiUsage.addPromptText(systemPrompt + JSON.stringify({ language: locale, novelTitle: novel.title, history }));
  } catch (error) {
    await aiUsage.fail();
    throw error;
  }

  const { budget } = contextResult;
  const brainstormReceiptId = beginBrainstormReceipt(id);
  return streamChatTurnResponse({
    aiUsage,
    requestSignal: request.signal,
    system: systemPrompt,
    history,
    preset: resolvePreset('chat', readCreativityHeader(request)),
    tools: createBrainstormTools(id, brainstormReceiptId),
    stopWhen: [hasToolCall('finalizeBrainstorm'), stepCountIs(3)],
    originalMessages,
    submittedUserMessage: userMessage,
    responseMessageId: crypto.randomUUID(),
    stoppedLabel,
    persistence: {
      persistUser: messageId => addMessageWithId(id, messageId, 'user', content),
      persistAssistant: (messageId, text) => addMessageWithId(id, messageId, 'assistant', text),
    },
    headers: {
      'X-Context-Pressure': budget.pressure,
      'X-Context-Tokens': formatTokensHeader(budget.estTokens, budget.ctxTokens),
    },
  });
}
