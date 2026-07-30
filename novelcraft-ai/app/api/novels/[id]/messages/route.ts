import { NextResponse } from 'next/server';
import {
  hasToolCall,
  stepCountIs,
} from 'ai';
import {
  addMessageWithId,
  cancelChatTurn,
  failChatTurn,
  findNovelMessageById,
  getMessages,
  hashChatTurnRequest,
  type ChatTurn,
} from '@/lib/db';
import { persistChatTurnAssistantMessage } from '@/lib/db/queries-chat-turns';
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
  recordBrainstormProfileMutation,
} from '@/lib/brainstorm-receipts';
import { buildUserMessageContentWithAttachments } from '@/lib/chat-attachments.server';
import {
  findLatestUserMessage,
  getUIMessageText,
  parseNovelChatUIMessages,
  type NovelChatUIMessage,
} from '@/lib/chat-ui-message';
import {
  acquireChatTurnOrRespond,
  bindChatTurnBrainstormReceipt,
  chatTurnCollisionResponse,
  deterministicAssistantMessageId,
  persistOrReplayDeterministicAssistantText,
  resolveMainChatTurnMode,
} from '@/lib/chat-turn-helpers';

export const runtime = 'nodejs';
export const maxDuration = 300;

export function normalizeLegacyChatLanguageInput(value: unknown): Locale {
  return normalizeLocale(typeof value === 'string' ? value : undefined);
}

export { deterministicAssistantMessageId } from '@/lib/chat-turn-helpers';

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
  // Server DB is authoritative — never trust client metadata.persisted.
  const existingUserRow = findNovelMessageById(id, userMessage.id);
  if (existingUserRow && (
    existingUserRow.role !== 'user'
    || existingUserRow.content !== content
    || existingUserRow.conversationId !== null
  )) {
    return chatTurnCollisionResponse();
  }
  const userMessageAlreadyPersisted = existingUserRow?.role === 'user'
    && existingUserRow.content === content
    && existingUserRow.conversationId === null;
  const originalMessages = requestMessages.length > 0 ? requestMessages : [userMessage];
  // Authorization must ignore attachment-enhanced model context.
  const approvalText = getUIMessageText(userMessage);

  const mode = resolveMainChatTurnMode({
    repairStoryDeck,
    isExplicitApproval: isExplicitWritingApproval(approvalText),
  });
  const requestHash = hashChatTurnRequest({ content, mode });
  const responseMessageId = deterministicAssistantMessageId(userMessage.id);
  const claim = await acquireChatTurnOrRespond({
    novelId: id,
    userMessageId: userMessage.id,
    requestHash,
    assistantMessageId: responseMessageId,
    originalMessages,
    conversationId: null,
  });
  if (claim.kind === 'response') return claim.response;
  const turn: ChatTurn = claim.turn;
  const claimToken = turn.claimToken;
  if (!claimToken) throw new Error('Acquired chat turn is missing its claim token');

  if (mode === 'repair_story_deck') {
    try {
      await addMessageWithId(id, userMessage.id, 'user', content);
      const receiptId = bindChatTurnBrainstormReceipt(id, userMessage.id, turn);
      const result = await finalizeApprovedStoryDeck(id, locale, receiptId);
      if (!result.ok) {
        failChatTurn({
          novelId: id,
          userMessageId: userMessage.id,
          claimToken,
          errorCode: 'story_deck_repair_failed',
        });
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
        userMessageId: userMessage.id,
        claimToken,
        originalMessages,
        completionText,
      });
    } catch (error) {
      failChatTurn({
        novelId: id,
        userMessageId: userMessage.id,
        claimToken,
        errorCode: 'story_deck_repair_failed',
      });
      throw error;
    }
  }

  // Small local models often emit chapter prose instead of calling
  // finalizeBrainstorm. Explicit approval with a complete Story Deck must
  // advance atomically to ready_for_greenlight without model prose.
  if (mode === 'explicit_approval') {
    try {
      // Validate/persist the immutable request before changing the novel stage.
      await addMessageWithId(id, userMessage.id, 'user', content);
      const result = await approveExplicitWritingPlan(id);
      if (!result.ok) {
        if (result.reason === 'incomplete') {
          return persistOrReplayDeterministicAssistantText({
            novelId: id,
            userMessageId: userMessage.id,
            claimToken,
            originalMessages,
            completionText: incompleteDeckApprovalText(locale),
          });
        }
        failChatTurn({
          novelId: id,
          userMessageId: userMessage.id,
          claimToken,
          errorCode: 'brainstorm_finalize_failed',
        });
        return NextResponse.json({
          code: 'BRAINSTORM_FINALIZE_FAILED',
          error: 'The approved brainstorm could not be finalized.',
          reason: result.reason,
        }, { status: 409 });
      }
      // Receipt only for a real stage transition — never for incomplete/ready CTA.
      if (!result.alreadyReady) {
        const receiptId = bindChatTurnBrainstormReceipt(id, userMessage.id, turn);
        recordBrainstormProfileMutation(receiptId, result.beforeNovel, result.novel);
      }
      return persistOrReplayDeterministicAssistantText({
        novelId: id,
        userMessageId: userMessage.id,
        claimToken,
        originalMessages,
        completionText: approvalFinalizeCompletionText(locale),
      });
    } catch (error) {
      failChatTurn({
        novelId: id,
        userMessageId: userMessage.id,
        claimToken,
        errorCode: 'brainstorm_finalize_failed',
      });
      throw error;
    }
  }

  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(request, { userId: user.id, operation: 'chat' });
  } catch (error) {
    failChatTurn({
      novelId: id,
      userMessageId: userMessage.id,
      claimToken,
      errorCode: 'ai_usage',
    });
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
      failChatTurn({
        novelId: id,
        userMessageId: userMessage.id,
        claimToken,
        errorCode: 'novel_missing',
      });
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    contextResult = resolvedContext;
    systemPrompt = `${contextResult.systemPrompt}\n\n${brainstormAgentSystemAddon(locale, novel.stage)}`;
    aiUsage.addPromptText(systemPrompt + JSON.stringify({ language: locale, novelTitle: novel.title, history }));
  } catch (error) {
    await aiUsage.fail();
    failChatTurn({
      novelId: id,
      userMessageId: userMessage.id,
      claimToken,
      errorCode: 'context_build',
    });
    throw error;
  }

  const { budget } = contextResult;
  const brainstormReceiptId = bindChatTurnBrainstormReceipt(id, userMessage.id, turn);
  return streamChatTurnResponse({
    aiUsage,
    requestSignal: request.signal,
    system: systemPrompt,
    history,
    preset: resolvePreset('chat', readCreativityHeader(request)),
    tools: createBrainstormTools(id, {
      receiptId: brainstormReceiptId,
      userMessageId: userMessage.id,
      claimToken,
    }),
    stopWhen: [hasToolCall('finalizeBrainstorm'), stepCountIs(3)],
    originalMessages,
    submittedUserMessage: userMessage,
    responseMessageId,
    stoppedLabel,
    persistence: {
      persistUser: messageId => addMessageWithId(id, messageId, 'user', content),
      persistAssistant: async (messageId, text) => {
        const message = persistChatTurnAssistantMessage({
          novelId: id,
          userMessageId: userMessage.id,
          claimToken,
          assistantMessageId: messageId,
          responseText: text,
        });
        if (!message) throw new Error('Chat turn claim lost before assistant persistence');
        return message;
      },
      persistStoppedAssistant: async (messageId, text) => {
        const message = persistChatTurnAssistantMessage({
          novelId: id,
          userMessageId: userMessage.id,
          claimToken,
          assistantMessageId: messageId,
          responseText: text,
        });
        if (!message) throw new Error('Chat turn claim lost before assistant persistence');
        return message;
      },
      markFailed: async () => {
        failChatTurn({
          novelId: id,
          userMessageId: userMessage.id,
          claimToken,
          errorCode: 'provider_failed',
        });
      },
      markCancelled: async () => {
        cancelChatTurn({ novelId: id, userMessageId: userMessage.id, claimToken });
      },
    },
    headers: {
      'X-Context-Pressure': budget.pressure,
      'X-Context-Tokens': formatTokensHeader(budget.estTokens, budget.ctxTokens),
    },
  });
}
