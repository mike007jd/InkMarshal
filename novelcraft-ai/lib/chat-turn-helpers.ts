import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import {
  addMessageWithId,
  attachChatTurnBrainstormReceipt,
  beginChatTurn,
  completeChatTurn,
  findNovelMessageById,
  type ChatTurn,
} from '@/lib/db';
import {
  persistChatTurnAssistantMessage,
  resetEmptySucceededChatTurn,
} from '@/lib/db/queries-chat-turns';
import { ensureBrainstormReceipt } from '@/lib/brainstorm-receipts';
import type { NovelChatUIMessage } from '@/lib/chat-ui-message';
import type { Message } from '@/lib/db-types';
import type { ChatTurnMode } from '@/lib/db/queries-chat-turns';

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

function chatTurnInProgressResponse(): NextResponse {
  return NextResponse.json({
    code: 'CHAT_TURN_IN_PROGRESS',
    error: 'This chat turn is already running. Retry shortly to replay the completed response.',
    retryable: true,
  }, { status: 409 });
}

export function chatTurnCollisionResponse(): NextResponse {
  return NextResponse.json({
    code: 'CHAT_TURN_REQUEST_COLLISION',
    error: 'This message id was already used with different content.',
  }, { status: 409 });
}

function streamDeterministicAssistantMessage(args: {
  userMessageId: string;
  originalMessages: NovelChatUIMessage[];
  assistantMessage: Pick<Message, 'id' | 'content' | 'createdAt' | 'conversationId'>;
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

async function streamReplayFromChatTurn(args: {
  novelId: string;
  userMessageId: string;
  originalMessages: NovelChatUIMessage[];
  turn: ChatTurn;
  conversationId?: string | null;
}): Promise<Response> {
  const content = args.turn.responseText ?? '';
  const conversationId = args.conversationId ?? null;
  // Recreate a missing response row from the durable receipt. A collision must
  // fail closed: never stream a fabricated "persisted" assistant message when
  // the deterministic id is owned by different content/scope.
  const assistantMessage = await addMessageWithId(
    args.novelId,
    args.turn.assistantMessageId,
    'assistant',
    content,
    conversationId,
  );
  return streamDeterministicAssistantMessage({
    userMessageId: args.userMessageId,
    originalMessages: args.originalMessages,
    assistantMessage,
  });
}

export async function persistOrReplayDeterministicAssistantText(args: {
  novelId: string;
  userMessageId: string;
  claimToken: string;
  originalMessages: NovelChatUIMessage[];
  completionText: string;
  conversationId?: string | null;
}): Promise<Response> {
  const conversationId = args.conversationId ?? null;
  const responseMessageId = deterministicAssistantMessageId(args.userMessageId);
  const assistantMessage = persistChatTurnAssistantMessage({
    novelId: args.novelId,
    userMessageId: args.userMessageId,
    claimToken: args.claimToken,
    assistantMessageId: responseMessageId,
    responseText: args.completionText,
    conversationId,
  });
  if (!assistantMessage) throw new Error('Chat turn claim lost before assistant persistence');
  return streamDeterministicAssistantMessage({
    userMessageId: args.userMessageId,
    originalMessages: args.originalMessages,
    assistantMessage,
  });
}

/**
 * Claim a durable turn, or return an HTTP/stream response for
 * collision / in-progress / succeeded replay (including empty-succeeded reclaim).
 */
export async function acquireChatTurnOrRespond(args: {
  novelId: string;
  userMessageId: string;
  requestHash: string;
  assistantMessageId: string;
  originalMessages: NovelChatUIMessage[];
  conversationId?: string | null;
}): Promise<{ kind: 'acquired'; turn: ChatTurn } | { kind: 'response'; response: Response }> {
  const conversationId = args.conversationId ?? null;
  const replayExistingAssistant = (): Response | null => {
    const recovered = findNovelMessageById(args.novelId, args.assistantMessageId);
    if (
      !recovered
      || recovered.role !== 'assistant'
      || recovered.conversationId !== conversationId
    ) {
      return null;
    }
    if (turnBegin.kind !== 'acquired' || !turnBegin.turn.claimToken) {
      return null;
    }
    const completed = completeChatTurn({
      novelId: args.novelId,
      userMessageId: args.userMessageId,
      claimToken: turnBegin.turn.claimToken,
      responseText: recovered.content,
    });
    if (!completed) return null;
    return streamDeterministicAssistantMessage({
      userMessageId: args.userMessageId,
      originalMessages: args.originalMessages,
      assistantMessage: {
        id: recovered.id,
        content: recovered.content,
        createdAt: Date.now(),
        conversationId: recovered.conversationId,
      },
    });
  };

  let turnBegin = beginChatTurn({
    novelId: args.novelId,
    userMessageId: args.userMessageId,
    requestHash: args.requestHash,
    assistantMessageId: args.assistantMessageId,
  });

  if (turnBegin.kind === 'collision') {
    return { kind: 'response', response: chatTurnCollisionResponse() };
  }
  if (turnBegin.kind === 'in_progress') {
    return { kind: 'response', response: chatTurnInProgressResponse() };
  }
  if (turnBegin.kind === 'acquired') {
    // Covers a failed/cancelled reclaim whose assistant INSERT actually won,
    // plus pre-receipt deterministic rows from an older build.
    const recovered = replayExistingAssistant();
    if (recovered) return { kind: 'response', response: recovered };
  }
  if (turnBegin.kind === 'replay') {
    if (turnBegin.turn.responseText != null && turnBegin.turn.responseText !== '') {
      return {
        kind: 'response',
        response: await streamReplayFromChatTurn({
          novelId: args.novelId,
          userMessageId: args.userMessageId,
          originalMessages: args.originalMessages,
          turn: turnBegin.turn,
          conversationId,
        }),
      };
    }
    const recovered = replayExistingAssistant();
    if (recovered) return { kind: 'response', response: recovered };
    resetEmptySucceededChatTurn({
      novelId: args.novelId,
      userMessageId: args.userMessageId,
      requestHash: args.requestHash,
      assistantMessageId: args.assistantMessageId,
    });
    turnBegin = beginChatTurn({
      novelId: args.novelId,
      userMessageId: args.userMessageId,
      requestHash: args.requestHash,
      assistantMessageId: args.assistantMessageId,
    });
    if (turnBegin.kind !== 'acquired') {
      if (turnBegin.kind === 'in_progress') {
        return { kind: 'response', response: chatTurnInProgressResponse() };
      }
      if (turnBegin.kind === 'collision') {
        return { kind: 'response', response: chatTurnCollisionResponse() };
      }
      if (turnBegin.kind === 'replay' && turnBegin.turn.responseText) {
        return {
          kind: 'response',
          response: await streamReplayFromChatTurn({
            novelId: args.novelId,
            userMessageId: args.userMessageId,
            originalMessages: args.originalMessages,
            turn: turnBegin.turn,
            conversationId,
          }),
        };
      }
      return { kind: 'response', response: chatTurnInProgressResponse() };
    }
  }

  return { kind: 'acquired', turn: turnBegin.turn };
}

/** Bind or reuse the durable brainstorm receipt for an acquired running turn. */
export function bindChatTurnBrainstormReceipt(
  novelId: string,
  userMessageId: string,
  turn: ChatTurn,
): string {
  if (!turn.claimToken) {
    throw new Error('Cannot bind brainstorm receipt without an owned chat turn claim');
  }
  const receiptId = ensureBrainstormReceipt(novelId, turn.brainstormReceiptId);
  if (!attachChatTurnBrainstormReceipt(
    novelId,
    userMessageId,
    receiptId,
    turn.claimToken,
  )) {
    throw new Error('Chat turn claim lost before brainstorm receipt binding');
  }
  return receiptId;
}

export function resolveMainChatTurnMode(args: {
  repairStoryDeck: boolean;
  isConfirmedFinalPlan: boolean;
  isExplicitApproval: boolean;
}): ChatTurnMode {
  // Confirmed final-plan requests reuse the existing Story Deck finalization path.
  // They must not widen explicit_approval / approve-to-write semantics.
  if (args.repairStoryDeck || args.isConfirmedFinalPlan) return 'repair_story_deck';
  if (args.isExplicitApproval) return 'explicit_approval';
  return 'ordinary';
}
