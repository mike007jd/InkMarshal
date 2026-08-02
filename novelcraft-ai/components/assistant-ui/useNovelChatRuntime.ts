'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import type { ChatStatus } from 'ai';
import { AssistantChatTransport, useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import type { AssistantRuntime } from '@assistant-ui/react';
import type { Message } from '@/lib/db-types';
import {
  findLatestUserMessage,
  messagesToUIMessages,
  type NovelChatUIMessage,
} from '@/lib/chat-ui-message';
import { buildAIRequestHeaders } from '@/lib/streaming-client';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import { getTranslations, LOCALES, type Locale } from '@/lib/i18n';
import {
  CHAT_TURN_STATUS_HEADER,
  PERSISTED_CHAT_STOP_MARKER,
  parseChatTurnRecoveryStatus,
  type ChatTurnRecoveryStatus,
} from '@/lib/chat-turn-recovery';
import { isAIActionGateCancellation } from '@/lib/ai-action-gate';
import {
  isAIErrorPayload,
  presentAIErrorMessage,
  serializeAIErrorPayload,
} from '@/lib/ai-error';

/**
 * Turn-correlated outcome reported by the AI SDK `onFinish` callback:
 * - `succeeded`: the turn finished without abort, disconnect, or error.
 * - `aborted`: the turn was cancelled (Stop) or its request was aborted.
 * - `failed`: the turn ended by an error or a network disconnect.
 */
export type NovelChatTurnOutcome = 'succeeded' | 'aborted' | 'failed';
type NovelChatRetryKind = 'history' | 'ordinary' | 'repair' | 'stopped';

export interface NovelChatRuntimeArgs {
  novelId: string;
  conversationId?: string;
  locale: Locale;
  creativity?: CreativityLevel;
  stoppedLabel?: string;
  streamFailedLabel: string;
  requestFailedLabel?: string;
  loadFailedLabel?: string;
  autoStartLastUserTurn?: boolean;
  onError?: (message: string) => void;
  onTurnComplete?: () => void;
  onTurnFinish?: (outcome: NovelChatTurnOutcome) => void;
  onLoadError?: () => void;
}

export interface NovelChatRuntimeResult {
  runtime: AssistantRuntime;
  status: ChatStatus;
  messages: Message[];
  loading: boolean;
  recovering: boolean;
  errorMessage: string | null;
  retryKind: NovelChatRetryKind;
  retry: () => Promise<void>;
  refresh: () => Promise<void>;
  sendMessage: (text: string, body?: Record<string, unknown>) => Promise<void>;
}

function messagesEndpoint(
  novelId: string,
  conversationId?: string,
  pendingTurnId?: string | null,
): string {
  const endpoint = conversationId
    ? `/api/novels/${novelId}/conversations/${conversationId}/messages`
    : `/api/novels/${novelId}/messages`;
  return pendingTurnId
    ? `${endpoint}?pendingTurnId=${encodeURIComponent(pendingTurnId)}`
    : endpoint;
}

function chatEndpoint(novelId: string, conversationId?: string): string {
  return conversationId
    ? `/api/novels/${novelId}/conversations/${conversationId}/chat`
    : `/api/novels/${novelId}/messages`;
}

export function stoppedPersistenceLabel(locale: Locale): string {
  return `${PERSISTED_CHAT_STOP_MARKER}\n${getTranslations(locale).writingStopped}`;
}

function stoppedDisplayLabel(stoppedLabel: string | undefined, fallback: string): string {
  return stoppedLabel
    ?.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1) ?? fallback;
}

export function isPersistedStoppedAssistant(
  message: Message | undefined,
  options: { turnStatus?: ChatTurnRecoveryStatus | null; allowLegacySuffix?: boolean } = {},
): boolean {
  if (message?.role !== 'assistant') return false;
  if (options.turnStatus === 'cancelled' || options.turnStatus === 'stopped') return true;
  const suffix = message.content.trimEnd().split('\n\n').at(-1);
  if (!suffix) return false;
  const lines = suffix.split('\n');
  const hasStableMarker = lines.length === 2
    && lines[0] === PERSISTED_CHAT_STOP_MARKER
    && lines[1].trim().length > 0;
  if (hasStableMarker) return true;
  return options.allowLegacySuffix === true
    && LOCALES.some(candidate => suffix === getTranslations(candidate).writingStopped);
}

export function stoppedContinuationPrompt(locale: Locale): string {
  return getTranslations(locale).chatContinueAfterStop;
}

export function isPersistedStoryDeckRepairPrompt(content: string): boolean {
  const normalized = content.trim();
  return LOCALES.some(candidate => normalized === getTranslations(candidate).storyDeckCompletePrompt.trim());
}

export async function fetchChatResponse(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;

  const fallback = response.statusText || 'Failed to fetch the chat response.';
  const text = await response.text().catch(() => '');
  if (!text) throw new Error(fallback);

  let parsed: { error?: unknown; aiError?: unknown } | null = null;
  try {
    parsed = JSON.parse(text) as { error?: unknown; aiError?: unknown };
  } catch {
    parsed = null;
  }
  if (isAIErrorPayload(parsed?.aiError)) {
    throw new Error(serializeAIErrorPayload(parsed.aiError));
  }
  if (typeof parsed?.error === 'string' && parsed.error.trim()) {
    throw new Error(parsed.error);
  }

  throw new Error(text);
}

export function useNovelChatRuntime(args: NovelChatRuntimeArgs): NovelChatRuntimeResult {
  const {
    novelId,
    conversationId,
    locale,
    creativity,
    stoppedLabel,
    streamFailedLabel,
    requestFailedLabel,
    loadFailedLabel,
    autoStartLastUserTurn = false,
    onError,
    onTurnComplete,
    onTurnFinish,
    onLoadError,
  } = args;

  const scopeKey = `${novelId}:${conversationId ?? ''}`;
  const activeScopeRef = useRef(scopeKey);
  const callbacksRef = useRef({ onError, onTurnComplete, onTurnFinish, onLoadError });
  const errorCopyRef = useRef(requestFailedLabel ?? streamFailedLabel);
  const setChatMessagesRef = useRef<(messages: NovelChatUIMessage[]) => void>(() => {});
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const regenerateRef = useRef<() => Promise<void>>(async () => {});
  const reloadHistoryRef = useRef<() => Promise<void>>(async () => {});
  const autoStartedScopeRef = useRef<string | null>(null);
  const historyLoadFailedRef = useRef(false);
  const recoveryPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const recoveryActiveRef = useRef(false);
  const preserveDisconnectErrorRef = useRef(false);
  const pendingSubmittedTurnRef = useRef<string | null>(null);
  const disconnectRecoveryRef = useRef<{ messageId: string } | null>(null);
  // Last repairStoryDeck turn sent through `sendMessage`, keyed by its user
  // message id. The generic error Retry re-arms the repair body only while
  // the failed turn is still that same repair turn, so an ordinary chat
  // Retry can never be promoted into a repair (or vice versa).
  const lastRepairTurnRef = useRef<{ messageId: string; body: Record<string, unknown> } | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryKind, setRetryKind] = useState<NovelChatRetryKind>('ordinary');

  const clearRecoveryPoll = useCallback(() => {
    if (recoveryPollRef.current !== null) {
      clearTimeout(recoveryPollRef.current);
      recoveryPollRef.current = null;
    }
  }, []);

  const settleDisconnectRecovery = useCallback((
    messageId: string,
    outcome: NovelChatTurnOutcome,
  ) => {
    if (disconnectRecoveryRef.current?.messageId !== messageId) return;
    disconnectRecoveryRef.current = null;
    callbacksRef.current.onTurnFinish?.(outcome);
    if (outcome !== 'failed') callbacksRef.current.onTurnComplete?.();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recoveryRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    callbacksRef.current = { onError, onTurnComplete, onTurnFinish, onLoadError };
    errorCopyRef.current = requestFailedLabel ?? streamFailedLabel;
  });

  const transport = useMemo(
    () =>
      new AssistantChatTransport<NovelChatUIMessage>({
        api: chatEndpoint(novelId, conversationId),
        headers: () =>
          buildAIRequestHeaders(
            locale,
            'chat',
            creativity ? { creativity } : undefined,
          ),
        body: () => ({ language: locale, stoppedLabel }),
        fetch: fetchChatResponse,
      }),
    [novelId, conversationId, locale, stoppedLabel, creativity],
  );

  const chat = useChat<NovelChatUIMessage>({
    id: scopeKey,
    transport,
    onError: (error) => {
      if (isAIActionGateCancellation(error)) {
        setErrorMessage(null);
        return;
      }
      historyLoadFailedRef.current = false;
      const message = presentAIErrorMessage(
        error.message,
        getTranslations(locale),
        errorCopyRef.current,
      );
      setErrorMessage(message);
      callbacksRef.current.onError?.(message);
    },
    onFinish: async ({ isError, isDisconnect, isAbort }) => {
      // Turn-correlated outcome: the SDK fires this exactly once per turn in
      // a `finally`, with explicit flags — an aborted (Stop) turn returns to
      // `ready` without erroring, so status transitions alone cannot
      // distinguish it from success.
      if (isDisconnect) {
        preserveDisconnectErrorRef.current = true;
        const pendingMessageId = pendingSubmittedTurnRef.current;
        if (pendingMessageId) {
          disconnectRecoveryRef.current = { messageId: pendingMessageId };
        } else {
          callbacksRef.current.onTurnFinish?.('failed');
        }
        await reloadHistoryRef.current();
        return;
      }
      callbacksRef.current.onTurnFinish?.(
        isError ? 'failed' : isAbort ? 'aborted' : 'succeeded',
      );
      if (isError) return;
      historyLoadFailedRef.current = false;
      callbacksRef.current.onTurnComplete?.();
      await reloadHistoryRef.current();
      // A user Stop is retryable, not a successful terminal turn. Reload the
      // durable partial first, then keep a localized Retry callout visible;
      // `retry()` clears it before regenerating the same user turn.
      if (isAbort) {
        setErrorMessage(stoppedDisplayLabel(stoppedLabel, streamFailedLabel));
      }
    },
  });
  const { setMessages: setChatMessages, stop: stopChat, regenerate } = chat;

  useEffect(() => {
    setChatMessagesRef.current = (next) => setChatMessages(next);
    stopRef.current = stopChat;
    regenerateRef.current = regenerate;
  }, [setChatMessages, stopChat, regenerate]);

  const fetchMessages = useCallback(async () => {
    const requestScope = `${novelId}:${conversationId ?? ''}`;
    const requestId = recoveryRequestRef.current + 1;
    recoveryRequestRef.current = requestId;
    const requestedPendingTurnId = pendingSubmittedTurnRef.current;
    try {
      const res = await fetch(messagesEndpoint(
        novelId,
        conversationId,
        requestedPendingTurnId,
      ));
      if (!res.ok) throw new Error('Failed to load messages');
      const next: Message[] = await res.json();
      if (
        !mountedRef.current
        || activeScopeRef.current !== requestScope
        || recoveryRequestRef.current !== requestId
      ) return;
      const last = next.at(-1);
      const turnStatus = parseChatTurnRecoveryStatus(
        res.headers?.get?.(CHAT_TURN_STATUS_HEADER) ?? null,
      );
      const pendingTurnId = requestedPendingTurnId;
      const pendingTurnPersisted = pendingTurnId !== null
        && next.some(message => message.id === pendingTurnId);
      const pendingTurnKnown = pendingTurnId !== null
        && turnStatus !== null
        && turnStatus !== 'missing';
      const preserveDisconnectError = preserveDisconnectErrorRef.current
        && pendingTurnId !== null
        && !pendingTurnPersisted
        && !pendingTurnKnown;
      if (preserveDisconnectError) {
        // The exact pending turn is absent from both messages and chat_turns,
        // so the transport failed before the server claimed it. Keep the SDK's
        // local user message and repair metadata for an exact Retry.
        recoveryActiveRef.current = false;
        setRecovering(false);
        clearRecoveryPoll();
        preserveDisconnectErrorRef.current = false;
        historyLoadFailedRef.current = false;
        setRetryKind(
          lastRepairTurnRef.current?.messageId === pendingTurnId ? 'repair' : 'ordinary',
        );
        setErrorMessage(errorCopyRef.current);
        settleDisconnectRecovery(pendingTurnId, 'failed');
        return;
      }
      const pendingTurnAwaitingMessages = preserveDisconnectErrorRef.current
        && pendingTurnId !== null
        && !pendingTurnPersisted
        && pendingTurnKnown;
      if (pendingTurnAwaitingMessages) {
        historyLoadFailedRef.current = false;
        setMessages(next);
        clearRecoveryPoll();
        if (
          turnStatus === 'running'
          || turnStatus === 'succeeded'
          || turnStatus === 'cancelled'
          || turnStatus === 'stopped'
        ) {
          recoveryActiveRef.current = true;
          setRecovering(true);
          setErrorMessage(null);
          recoveryPollRef.current = setTimeout(() => {
            recoveryPollRef.current = null;
            if (
              mountedRef.current
              && activeScopeRef.current === requestScope
              && recoveryRequestRef.current === requestId
            ) {
              void reloadHistoryRef.current();
            }
          }, 1_000);
          return;
        }
        // A known failed/stale claim may legitimately precede persistUser.
        // Preserve the local request for regenerate, but settle recovery now.
        preserveDisconnectErrorRef.current = false;
        recoveryActiveRef.current = false;
        setRecovering(false);
        setRetryKind(
          lastRepairTurnRef.current?.messageId === pendingTurnId ? 'repair' : 'ordinary',
        );
        setErrorMessage(errorCopyRef.current);
        settleDisconnectRecovery(pendingTurnId, 'failed');
        return;
      }
      preserveDisconnectErrorRef.current = false;
      const stopped = isPersistedStoppedAssistant(last, {
        turnStatus,
        // v0.1.5 main-thread stops persisted only the localized visible suffix.
        // A cancelled receipt recovers every scope; this suffix fallback covers
        // old databases where no matching receipt is available.
        allowLegacySuffix: !conversationId,
      });
      // `succeeded + last user` is a read race: assistant persistence and the
      // receipt are atomic, but this GET may have read messages just before the
      // commit and the receipt just after it. Keep the scope busy and refetch.
      const recoveringPersistedTurn = last?.role === 'user'
        && (turnStatus === 'running' || turnStatus === 'succeeded');
      recoveryActiveRef.current = recoveringPersistedTurn;
      setRecovering(recoveringPersistedTurn);
      const shouldAutoStart = autoStartLastUserTurn
        && last?.role === 'user'
        && !recoveringPersistedTurn
        && autoStartedScopeRef.current !== requestScope;
      const retryPersistedUser = last?.role === 'user'
        && !shouldAutoStart
        && !recoveringPersistedTurn;
      const persistedRepair = last?.role === 'user' && isPersistedStoryDeckRepairPrompt(last.content);
      lastRepairTurnRef.current = persistedRepair && last?.role === 'user'
        ? { messageId: last.id, body: { repairStoryDeck: true } }
        : null;
      if (stopped) {
        setRetryKind('stopped');
      } else if (historyLoadFailedRef.current || retryPersistedUser) {
        setRetryKind(persistedRepair ? 'repair' : 'ordinary');
      } else {
        setRetryKind(current => current === 'stopped' ? 'ordinary' : current);
      }
      historyLoadFailedRef.current = false;
      if (stopped) {
        setErrorMessage(stoppedDisplayLabel(stoppedLabel, streamFailedLabel));
      } else if (retryPersistedUser) {
        setErrorMessage(requestFailedLabel ?? streamFailedLabel);
      } else {
        setErrorMessage(null);
      }
      setMessages(next);
      setChatMessagesRef.current(messagesToUIMessages(next));
      if (pendingTurnPersisted && !recoveringPersistedTurn && pendingTurnId) {
        pendingSubmittedTurnRef.current = null;
        if (turnStatus === 'succeeded' && last?.role === 'assistant') {
          settleDisconnectRecovery(pendingTurnId, 'succeeded');
        } else if (
          (turnStatus === 'cancelled' || turnStatus === 'stopped')
          && last?.role === 'assistant'
        ) {
          settleDisconnectRecovery(pendingTurnId, 'aborted');
        } else {
          settleDisconnectRecovery(pendingTurnId, 'failed');
        }
      }
      clearRecoveryPoll();
      if (recoveringPersistedTurn) {
        recoveryPollRef.current = setTimeout(() => {
          recoveryPollRef.current = null;
          if (
            mountedRef.current
            && activeScopeRef.current === requestScope
            && recoveryRequestRef.current === requestId
          ) {
            void reloadHistoryRef.current();
          }
        }, 1_000);
      }
      if (shouldAutoStart) {
        autoStartedScopeRef.current = requestScope;
        queueMicrotask(() => {
          if (
            mountedRef.current
            && activeScopeRef.current === requestScope
            && recoveryRequestRef.current === requestId
          ) {
            void regenerateRef.current().catch(error => {
              console.error('Failed to autostart chat response:', error);
            });
          }
        });
      }
    } catch (error) {
      if (
        mountedRef.current
        && activeScopeRef.current === requestScope
        && recoveryRequestRef.current === requestId
      ) {
        clearRecoveryPoll();
        const unresolvedRecovery = recoveryActiveRef.current
          || disconnectRecoveryRef.current !== null;
        recoveryActiveRef.current = unresolvedRecovery;
        setRecovering(unresolvedRecovery);
        console.error('Failed to load chat history:', error);
        historyLoadFailedRef.current = true;
        setRetryKind('history');
        setErrorMessage(loadFailedLabel ?? requestFailedLabel ?? streamFailedLabel);
        callbacksRef.current.onLoadError?.();
      }
    } finally {
      if (
        mountedRef.current
        && activeScopeRef.current === requestScope
        && recoveryRequestRef.current === requestId
      ) setLoading(false);
    }
  }, [novelId, conversationId, autoStartLastUserTurn, clearRecoveryPoll, loadFailedLabel, requestFailedLabel, settleDisconnectRecovery, stoppedLabel, streamFailedLabel]);

  useEffect(() => {
    reloadHistoryRef.current = fetchMessages;
  }, [fetchMessages]);

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    clearRecoveryPoll();
    const abandonedDisconnect = disconnectRecoveryRef.current;
    if (abandonedDisconnect) {
      settleDisconnectRecovery(abandonedDisconnect.messageId, 'failed');
    }
    let cancelled = false;
    void stopRef.current().catch(() => undefined);
    queueMicrotask(() => {
      if (cancelled) return;
      setChatMessagesRef.current([]);
      setMessages([]);
      historyLoadFailedRef.current = false;
      recoveryActiveRef.current = false;
      preserveDisconnectErrorRef.current = false;
      pendingSubmittedTurnRef.current = null;
      lastRepairTurnRef.current = null;
      setRetryKind('ordinary');
      setErrorMessage(null);
      setRecovering(false);
      setLoading(true);
      void reloadHistoryRef.current();
    });
    return () => {
      cancelled = true;
      recoveryRequestRef.current += 1;
      clearRecoveryPoll();
    };
  }, [scopeKey, clearRecoveryPoll, settleDisconnectRecovery]);

  useEffect(
    () => () => {
      clearRecoveryPoll();
      recoveryRequestRef.current += 1;
      void stopRef.current().catch(() => undefined);
    },
    [clearRecoveryPoll],
  );

  const retry = useCallback(async () => {
    setErrorMessage(null);
    if (historyLoadFailedRef.current) {
      await fetchMessages();
      return;
    }
    if (recoveryActiveRef.current) return;
    chat.clearError();
    if (retryKind === 'stopped') {
      // The stopped partial is a durable, user-visible result. Preserve it and
      // continue in a fresh turn so a failed Retry can never erase prior work
      // or disturb the original turn's tool ledger/receipt.
      lastRepairTurnRef.current = null;
      setRetryKind('ordinary');
      const text = stoppedContinuationPrompt(locale);
      const messageId = crypto.randomUUID();
      recoveryRequestRef.current += 1;
      clearRecoveryPoll();
      pendingSubmittedTurnRef.current = messageId;
      await chat.sendMessage({
        id: messageId,
        role: 'user',
        parts: [{ type: 'text', text }],
      });
      return;
    }
    // Repair-aware retry: when the failed turn was the repairStoryDeck turn
    // (matched by its user message id, so a later ordinary turn cannot
    // inherit it), the retry must carry the same repair body — otherwise the
    // regenerate would run as an ordinary model turn against a repair
    // prompt. Ordinary turns regenerate with no extra body, as before.
    const repairTurn = lastRepairTurnRef.current;
    const lastUserMessage = findLatestUserMessage(chat.messages);
    const body = repairTurn && lastUserMessage?.id === repairTurn.messageId
      ? repairTurn.body
      : undefined;
    recoveryRequestRef.current += 1;
    clearRecoveryPoll();
    pendingSubmittedTurnRef.current = lastUserMessage?.id ?? null;
    await chat.regenerate(body ? { body } : undefined);
  }, [chat, clearRecoveryPoll, fetchMessages, locale, retryKind]);

  const sendMessage = useCallback(async (text: string, body?: Record<string, unknown>) => {
    if (recoveryActiveRef.current) {
      throw new Error('The previous chat turn is still recovering.');
    }
    setErrorMessage(null);
    chat.clearError();
    const messageId = crypto.randomUUID();
    recoveryRequestRef.current += 1;
    clearRecoveryPoll();
    pendingSubmittedTurnRef.current = messageId;
    lastRepairTurnRef.current = body?.repairStoryDeck === true
      ? { messageId, body }
      : null;
    setRetryKind(body?.repairStoryDeck === true ? 'repair' : 'ordinary');
    await chat.sendMessage(
      { id: messageId, role: 'user', parts: [{ type: 'text', text }] },
      body ? { body } : undefined,
    );
  }, [chat, clearRecoveryPoll]);

  const runtime = useAISDKRuntime(chat, {
    unstable_capabilities: { copy: true },
  });

  return {
    runtime,
    status: recovering ? 'submitted' : chat.status,
    messages,
    loading,
    recovering,
    errorMessage,
    retryKind,
    retry,
    refresh: fetchMessages,
    sendMessage,
  };
}
