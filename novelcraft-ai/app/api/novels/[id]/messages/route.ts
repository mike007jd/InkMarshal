import { createHash } from 'node:crypto';
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
  approveExplicitWritingPlan,
  brainstormAgentSystemAddon,
  createBrainstormTools,
  finalizeApprovedStoryDeck,
  isExplicitWritingApproval,
} from '@/lib/brainstorm-agent';
import {
  beginBrainstormReceipt,
  recordBrainstormProfileMutation,
} from '@/lib/brainstorm-receipts';
import { buildUserMessageContentWithAttachments } from '@/lib/chat-attachments.server';
import {
  findLatestUserMessage,
  getUIMessageText,
  parseNovelChatUIMessages,
  type NovelChatUIMessage,
} from '@/lib/chat-ui-message';

export const runtime = 'nodejs';
export const maxDuration = 300;

export function normalizeLegacyChatLanguageInput(value: unknown): Locale {
  return normalizeLocale(typeof value === 'string' ? value : undefined);
}

/** Stable UUID derived from the submitted user turn — retries stay idempotent. */
export function deterministicAssistantMessageId(userMessageId: string): string {
  const hex = createHash('sha256')
    .update('inkmarshal.deterministic-assistant:')
    .update(userMessageId)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function approvalFinalizeCompletionText(locale: Locale): string {
  if (locale === 'en') {
    return 'The story plan is ready for approval. Review the Story Deck, then click "Approve & Begin Writing" to start Chapter 1. Manuscript prose is not written in chat.';
  }
  if (locale === 'zh-TW') {
    return '故事方案已就緒，可供批准。請審閱故事卡組，然後點擊「大綱無誤，開始動筆」開始第一章。我不會在聊天裡直接寫正文。';
  }
  return '故事方案已就绪，可供批准。请审阅故事卡组，然后点击「大纲无误，开始动笔」开始第一章。我不会在聊天里直接写正文。';
}

function incompleteDeckApprovalText(locale: Locale): string {
  if (locale === 'en') {
    return 'I cannot approve writing yet — the Story Deck still needs at least one character, world, and outline card. Continue brainstorming until those cards are saved; do not write manuscript prose in chat.';
  }
  if (locale === 'zh-TW') {
    return '還不能批准寫作：故事卡組仍需至少一張角色、世界觀與大綱卡片。請先繼續構思並保存這些卡片；不要在聊天裡直接寫正文。';
  }
  return '还不能批准写作：故事卡组仍需至少一张角色、世界观和大纲卡片。请先继续构思并保存这些卡片；不要在聊天里直接写正文。';
}

type PersistedMessage = Awaited<ReturnType<typeof addMessageWithId>>;

async function findDeterministicAssistantMessage(
  novelId: string,
  userMessageId: string,
): Promise<PersistedMessage | null> {
  const responseMessageId = deterministicAssistantMessageId(userMessageId);
  return (await getMessages(novelId)).find(message => (
    message.id === responseMessageId
    && message.role === 'assistant'
    && message.conversationId === null
  )) ?? null;
}

function streamDeterministicAssistantMessage(args: {
  userMessageId: string;
  originalMessages: NovelChatUIMessage[];
  assistantMessage: PersistedMessage;
}): Response {
  const responseMessageId = args.assistantMessage.id;
  const textId = deterministicAssistantMessageId(`${args.userMessageId}:text`);
  const metadata = {
    createdAt: args.assistantMessage.createdAt,
    conversationId: args.assistantMessage.conversationId ?? null,
    persisted: true,
  };
  const stream = createUIMessageStream<NovelChatUIMessage>({
    originalMessages: args.originalMessages,
    generateId: () => responseMessageId,
    execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: responseMessageId, messageMetadata: metadata });
      writer.write({ type: 'text-start', id: textId });
      writer.write({ type: 'text-delta', id: textId, delta: args.assistantMessage.content });
      writer.write({ type: 'text-end', id: textId });
      writer.write({ type: 'finish', finishReason: 'stop', messageMetadata: metadata });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

async function persistOrReplayDeterministicAssistantText(args: {
  novelId: string;
  userMessage: NovelChatUIMessage;
  originalMessages: NovelChatUIMessage[];
  completionText: string;
}): Promise<Response> {
  const responseMessageId = deterministicAssistantMessageId(args.userMessage.id);
  let assistantMessage: PersistedMessage;
  try {
    assistantMessage = await addMessageWithId(
      args.novelId,
      responseMessageId,
      'assistant',
      args.completionText,
    );
  } catch (error) {
    const winner = await findDeterministicAssistantMessage(args.novelId, args.userMessage.id);
    if (!winner) throw error;
    assistantMessage = winner;
  }
  return streamDeterministicAssistantMessage({
    userMessageId: args.userMessage.id,
    originalMessages: args.originalMessages,
    assistantMessage,
  });
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
  // Authorization must ignore attachment-enhanced model context.
  const approvalText = getUIMessageText(userMessage);

  // A submitted message ID is an immutable idempotency key. Replay an existing
  // deterministic result before re-evaluating state, locale, or side effects.
  const existingDeterministicAssistant = await findDeterministicAssistantMessage(
    id,
    userMessage.id,
  );
  if (existingDeterministicAssistant) {
    return streamDeterministicAssistantMessage({
      userMessageId: userMessage.id,
      originalMessages,
      assistantMessage: existingDeterministicAssistant,
    });
  }

  if (repairStoryDeck) {
    await addMessageWithId(id, userMessage.id, 'user', content);
    const receiptId = beginBrainstormReceipt(id);
    const result = await finalizeApprovedStoryDeck(id, locale, receiptId);
    if (!result.ok) {
      return NextResponse.json({
        code: 'STORY_DECK_REPAIR_FAILED',
        error: 'The approved Story Deck could not be completed.',
        reason: result.reason,
      }, { status: 409 });
    }
    const completionText = locale === 'en'
      ? 'Story Deck completed: character, world, and outline cards are ready for review.'
      : locale === 'zh-TW'
        ? 'Story Deck 已補全：角色、世界觀與大綱卡片已可供審閱。'
        : 'Story Deck 已补全：角色、世界观和大纲卡片已可供审阅。';
    return persistOrReplayDeterministicAssistantText({
      novelId: id,
      userMessage,
      originalMessages,
      completionText,
    });
  }

  // Small local models often emit chapter prose instead of calling
  // finalizeBrainstorm. Explicit approval with a complete Story Deck must
  // advance atomically to ready_for_greenlight without model prose.
  if (isExplicitWritingApproval(approvalText)) {
    // Validate/persist the immutable request before changing the novel stage.
    await addMessageWithId(id, userMessage.id, 'user', content);
    const result = await approveExplicitWritingPlan(id);
    if (!result.ok) {
      if (result.reason === 'incomplete') {
        return persistOrReplayDeterministicAssistantText({
          novelId: id,
          userMessage,
          originalMessages,
          completionText: incompleteDeckApprovalText(locale),
        });
      }
      return NextResponse.json({
        code: 'BRAINSTORM_FINALIZE_FAILED',
        error: 'The approved brainstorm could not be finalized.',
        reason: result.reason,
      }, { status: 409 });
    }
    // Receipt only for a real stage transition — never for incomplete/ready CTA.
    if (!result.alreadyReady) {
      const receiptId = beginBrainstormReceipt(id);
      recordBrainstormProfileMutation(receiptId, result.beforeNovel, result.novel);
    }
    return persistOrReplayDeterministicAssistantText({
      novelId: id,
      userMessage,
      originalMessages,
      completionText: approvalFinalizeCompletionText(locale),
    });
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
