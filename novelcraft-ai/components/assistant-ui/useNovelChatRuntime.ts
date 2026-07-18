'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { AssistantChatTransport, useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import type { AssistantRuntime } from '@assistant-ui/react';
import type { Message } from '@/lib/db-types';
import {
  messagesToUIMessages,
  type NovelChatUIMessage,
} from '@/lib/chat-ui-message';
import { buildAIRequestHeaders } from '@/lib/streaming-client';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import { getTranslations, type Locale } from '@/lib/i18n';
import { isAIActionGateCancellation } from '@/lib/ai-action-gate';
import {
  isAIErrorPayload,
  presentAIErrorMessage,
  serializeAIErrorPayload,
} from '@/lib/ai-error';

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
  onLoadError?: () => void;
}

export interface NovelChatRuntimeResult {
  runtime: AssistantRuntime;
  messages: Message[];
  loading: boolean;
  errorMessage: string | null;
  retry: () => Promise<void>;
  refresh: () => Promise<void>;
}

function messagesEndpoint(novelId: string, conversationId?: string): string {
  return conversationId
    ? `/api/novels/${novelId}/conversations/${conversationId}/messages`
    : `/api/novels/${novelId}/messages`;
}

function chatEndpoint(novelId: string, conversationId?: string): string {
  return conversationId
    ? `/api/novels/${novelId}/conversations/${conversationId}/chat`
    : `/api/novels/${novelId}/messages`;
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
    onLoadError,
  } = args;

  const scopeKey = `${novelId}:${conversationId ?? ''}`;
  const activeScopeRef = useRef(scopeKey);
  const callbacksRef = useRef({ onError, onTurnComplete, onLoadError });
  const errorCopyRef = useRef(requestFailedLabel ?? streamFailedLabel);
  const setChatMessagesRef = useRef<(messages: NovelChatUIMessage[]) => void>(() => {});
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const regenerateRef = useRef<() => Promise<void>>(async () => {});
  const reloadHistoryRef = useRef<() => Promise<void>>(async () => {});
  const autoStartedScopeRef = useRef<string | null>(null);
  const historyLoadFailedRef = useRef(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    callbacksRef.current = { onError, onTurnComplete, onLoadError };
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
    onFinish: async ({ isError }) => {
      if (isError) return;
      historyLoadFailedRef.current = false;
      setErrorMessage(null);
      callbacksRef.current.onTurnComplete?.();
      await reloadHistoryRef.current();
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
    try {
      const res = await fetch(messagesEndpoint(novelId, conversationId));
      if (!res.ok) throw new Error('Failed to load messages');
      const next: Message[] = await res.json();
      if (activeScopeRef.current !== requestScope) return;
      historyLoadFailedRef.current = false;
      setErrorMessage(null);
      setMessages(next);
      setChatMessagesRef.current(messagesToUIMessages(next));
      const last = next.at(-1);
      if (
        autoStartLastUserTurn
        && last?.role === 'user'
        && autoStartedScopeRef.current !== requestScope
      ) {
        autoStartedScopeRef.current = requestScope;
        queueMicrotask(() => {
          if (activeScopeRef.current === requestScope) {
            void regenerateRef.current().catch(error => {
              console.error('Failed to autostart chat response:', error);
            });
          }
        });
      }
    } catch (error) {
      if (activeScopeRef.current === requestScope) {
        console.error('Failed to load chat history:', error);
        historyLoadFailedRef.current = true;
        setErrorMessage(loadFailedLabel ?? requestFailedLabel ?? streamFailedLabel);
        callbacksRef.current.onLoadError?.();
      }
    } finally {
      if (activeScopeRef.current === requestScope) setLoading(false);
    }
  }, [novelId, conversationId, autoStartLastUserTurn, loadFailedLabel, requestFailedLabel, streamFailedLabel]);

  useEffect(() => {
    reloadHistoryRef.current = fetchMessages;
  }, [fetchMessages]);

  useEffect(() => {
    activeScopeRef.current = scopeKey;
    let cancelled = false;
    void stopRef.current().catch(() => undefined);
    queueMicrotask(() => {
      if (cancelled) return;
      setChatMessagesRef.current([]);
      setMessages([]);
      historyLoadFailedRef.current = false;
      setErrorMessage(null);
      setLoading(true);
      void fetchMessages();
    });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, fetchMessages]);

  useEffect(
    () => () => {
      void stopRef.current().catch(() => undefined);
    },
    [],
  );

  const retry = useCallback(async () => {
    setErrorMessage(null);
    if (historyLoadFailedRef.current) {
      await fetchMessages();
      return;
    }
    chat.clearError();
    await chat.regenerate();
  }, [chat, fetchMessages]);

  const runtime = useAISDKRuntime(chat, {
    unstable_capabilities: { copy: true },
  });

  return { runtime, messages, loading, errorMessage, retry, refresh: fetchMessages };
}
