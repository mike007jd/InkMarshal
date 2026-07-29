'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { buildModelHeaders, consumeNdjsonStream } from '@/lib/streaming-client';
import { WRITING_SESSION_READ_TIMEOUT_MS } from '@/lib/writing-session';
import {
  isEffectiveTextReplacement,
  locateOriginalText,
  type ChangeItem,
} from '@/lib/diff-utils';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import type { ChatMessage } from '@/components/ChatHistory';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';
import type { EditingScope } from '@/hooks/useChapterDraftController';
import { isAIActionGateCancellation } from '@/lib/ai-action-gate';

interface UseAIEditChatArgs {
  chapter: ManuscriptChapter | null;
  novelId: string;
  storageReady: boolean;
  creativity: CreativityLevel;
  styleId: string | null;
  selectedText: string | undefined;
  isCurrentEditingScope: (scope: EditingScope) => boolean;
  /** Scratch buffer shared with the diff hook — handleSend appends streamed
   *  changes here synchronously, then publishes via setChanges. */
  changesRef: RefObject<ChangeItem[]>;
  setChanges: (changes: ChangeItem[]) => void;
  handleClearSelection: () => void;
  setIsLoading: (loading: boolean) => void;
  setEditStreaming: (streaming: boolean) => void;
  /** Reads the live editor text (falls back to the pending buffer). */
  getCurrentEditorContent: () => string;
}

/** Durable row shape returned by GET …/edit (chapter_chat_history). */
export interface DurableEditHistoryMessage {
  id: string;
  role: string;
  content: string;
  status: string;
  createdAt: number;
}

interface ActiveEditRun {
  runId: string;
  instruction: string;
  novelId: string;
  chapterId: string;
  chapterNumber: number;
}

/** Stable empty transcript so out-of-scope renders do not churn effect deps. */
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const STOP_ACK_TIMEOUT_MS = 10_000;

function tryParseEditAssistantSummary(content: string): { text: string; changesCount?: number } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { summary?: unknown; changes?: unknown };
    if (typeof parsed.summary !== 'string') return null;
    const changesCount = Array.isArray(parsed.changes)
      ? parsed.changes.filter(isEffectiveTextReplacement).length
      : undefined;
    return { text: parsed.summary, changesCount };
  } catch {
    return null;
  }
}

/**
 * Map durable edit history into UI chat messages.
 * Successful assistant JSON → human summary; cancelled stopped text unchanged.
 */
export function mapDurableEditHistory(messages: DurableEditHistoryMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    let content = message.content;
    let changesCount: number | undefined;
    if (message.role === 'assistant' && message.status !== 'cancelled') {
      const summary = tryParseEditAssistantSummary(message.content);
      if (summary) {
        content = summary.text;
        changesCount = summary.changesCount;
      }
    }
    out.push({
      id: message.id,
      role: message.role,
      content,
      timestamp: message.createdAt,
      ...(changesCount !== undefined ? { changesCount } : {}),
    });
  }
  return out;
}

/**
 * Owns the freeform "edit chat": the chat transcript, the edit-stream
 * AbortController, and the NDJSON consumer that turns the model's response into
 * pending diff changes. Streamed changes are appended to the shared changesRef
 * and published through the diff hook's setChanges.
 */
export function useAIEditChat({
  chapter,
  novelId,
  storageReady,
  creativity,
  styleId,
  selectedText,
  isCurrentEditingScope,
  changesRef,
  setChanges,
  handleClearSelection,
  setIsLoading,
  setEditStreaming,
  getCurrentEditorContent,
}: UseAIEditChatArgs) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const generationTimeoutMessage = t.generationTimedOut || 'Generation timed out — try again.';
  const stoppedLabel = t.writingStopped;

  const chapterId = chapter?.id;
  const chapterNumber = chapter?.chapterNumber;
  const activeChatScopeKey = storageReady && chapterId && chapterNumber != null && novelId
    ? `${novelId}:${chapterId}:${chapterNumber}`
    : null;
  const [chatState, setChatState] = useState<{
    scopeKey: string | null;
    messages: ChatMessage[];
  }>({ scopeKey: null, messages: [] });
  // Key the transcript to the current chapter during render. A chapter/profile
  // switch therefore hides stale messages immediately without a prop-driven
  // state reset effect.
  const chatMessages = chatState.scopeKey === activeChatScopeKey
    ? chatState.messages
    : EMPTY_CHAT_MESSAGES;
  const updateChatMessages = useCallback((
    updater: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[]),
  ) => {
    setChatState(previous => {
      const scopedMessages = previous.scopeKey === activeChatScopeKey
        ? previous.messages
        : EMPTY_CHAT_MESSAGES;
      return {
        scopeKey: activeChatScopeKey,
        messages: typeof updater === 'function' ? updater(scopedMessages) : updater,
      };
    });
  }, [activeChatScopeKey]);
  // Ref mirror so handleSend can read latest chat without listing chatMessages
  // in its deps — keeps the handleSend identity stable across appends.
  const chatMessagesRef = useRef<ChatMessage[]>(chatMessages);
  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);
  const editAbortRef = useRef<AbortController | null>(null);
  const activeEditRunRef = useRef<ActiveEditRun | null>(null);
  /** Per-run stop latch — double Stop is one mutation and one marker. */
  const stopLatchRef = useRef<Set<string>>(new Set());
  const hydrateGenRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);

  const loadDurableHistory = useCallback(async (
    requestScope: EditingScope,
    signal?: AbortSignal,
  ): Promise<ChatMessage[] | null> => {
    const gen = ++hydrateGenRef.current;
    try {
      const res = await fetch(
        `/api/novels/${requestScope.novelId}/chapters/${requestScope.chapterNumber}/edit`,
        { signal, cache: 'no-store' },
      );
      if (!res.ok) return null;
      const data = await res.json() as { messages?: DurableEditHistoryMessage[] };
      if (hydrateGenRef.current !== gen) return null;
      if (!isCurrentEditingScope(requestScope)) return null;
      return Array.isArray(data.messages) ? mapDurableEditHistory(data.messages) : [];
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      return null;
    }
  }, [isCurrentEditingScope]);

  // Chapter-scoped durable history: reload after Stop / completion survives.
  // Depend on chapter identity only — content/version refresh must not wipe
  // an in-flight or just-stopped transcript. During a slow outgoing-draft
  // flush, incoming chapter props render before the draft controller repoints
  // its active scope; skip that premature load. resetForChapterSwitch starts
  // the authoritative load immediately after applyChapterSwitch.
  useEffect(() => {
    if (!activeChatScopeKey || !chapterId || chapterNumber == null) return;
    const requestScope: EditingScope = {
      novelId,
      chapterId,
      chapterNumber,
    };
    if (!isCurrentEditingScope(requestScope)) return;

    const abort = new AbortController();
    historyAbortRef.current?.abort();
    historyAbortRef.current = abort;
    void loadDurableHistory(requestScope, abort.signal).then(messages => {
      if (messages) {
        setChatState({ scopeKey: activeChatScopeKey, messages });
      }
    }).finally(() => {
      if (historyAbortRef.current === abort) historyAbortRef.current = null;
    });

    return () => {
      abort.abort();
      if (historyAbortRef.current === abort) historyAbortRef.current = null;
    };
  }, [
    activeChatScopeKey,
    novelId,
    chapterId,
    chapterNumber,
    isCurrentEditingScope,
    loadDurableHistory,
  ]);

  const handleSend = useCallback(async (instruction: string) => {
    if (!chapter) return;
    const requestScope = {
      novelId,
      chapterId: chapter.id,
      chapterNumber: chapter.chapterNumber,
    };
    if (!storageReady) {
      toast(`${t.loading || 'Loading'}...`, 'info');
      return;
    }
    const stoppingRun = activeEditRunRef.current;
    if (stoppingRun && stopLatchRef.current.has(stoppingRun.runId)) {
      toast(`${t.loading || 'Loading'}...`, 'info');
      return;
    }
    // Cancel any in-flight edit stream without treating it as explicit Stop.
    // Invalidate pending hydrate so a late GET cannot overwrite the live
    // transcript mid-send.
    editAbortRef.current?.abort();
    hydrateGenRef.current += 1;
    const runId = crypto.randomUUID();
    const abort = new AbortController();
    editAbortRef.current = abort;
    activeEditRunRef.current = {
      runId,
      instruction,
      novelId,
      chapterId: chapter.id,
      chapterNumber: chapter.chapterNumber,
    };
    setIsLoading(true);
    setEditStreaming(true);

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: instruction,
      timestamp: Date.now(),
    };
    updateChatMessages(prev => [...prev, userMsg]);

    try {
      // Read the latest chat history from the ref so this handler doesn't
      // need to list `chatMessages` in its deps — see chatMessagesRef
      // declaration for why.
      const recentHistory = chatMessagesRef.current.slice(-5).map(m => ({
        role: m.role,
        content: m.content,
      }));
      const baseContent = getCurrentEditorContent();

      // runId is created before buildModelHeaders so a quick Stop during gate
      // / header resolution can still acknowledge via PATCH.
      const headers = await buildModelHeaders(
        'polish',
        { creativity, styleId: styleId ?? undefined },
        { signal: abort.signal },
      );
      if (abort.signal.aborted || stopLatchRef.current.has(runId)) {
        return;
      }

      const res = await fetch(`/api/novels/${novelId}/chapters/${chapter.chapterNumber}/edit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          instruction,
          selectedText: selectedText || undefined,
          fullText: baseContent,
          chatHistory: recentHistory,
          runId,
        }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Edit failed');
      }

      changesRef.current = [];
      let streamError: Error | null = null;
      await consumeNdjsonStream(res, {
        onEvent: data => {
          if (!isCurrentEditingScope(requestScope)) return;
          if (activeEditRunRef.current?.runId !== runId) return;
          if (data.type === 'change') {
            const original = data.original as string;
            const replacement = data.replacement as string;
            if (!isEffectiveTextReplacement({ original, replacement })) return;
            const location = locateOriginalText(baseContent, original);
            changesRef.current.push({
              id: (data.id as string) || `change-${changesRef.current.length}`,
              original,
              replacement,
              status: 'pending',
              location,
            });
          } else if (data.type === 'done') {
            setChanges([...changesRef.current]);
            const assistantMsg: ChatMessage = {
              id: `assistant-${Date.now()}`,
              role: 'assistant',
              content: (data.summary as string) || `${changesRef.current.length} changes`,
              timestamp: Date.now(),
              changesCount: changesRef.current.length,
            };
            updateChatMessages(prev => [...prev, assistantMsg]);
          } else if (data.type === 'error') {
            // Unified error frame key is `error` (lib/streaming-helpers).
            const detail = data.error as string | undefined;
            streamError = new Error(detail || 'Edit failed');
          }
        },
      }, {
        readTimeoutMs: WRITING_SESSION_READ_TIMEOUT_MS,
        timeoutMessage: generationTimeoutMessage,
      });
      if (streamError) throw streamError;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // Abort alone is not durable Stop — visible Stopped only after PATCH
        // confirms cancelled (handleStopEdit). Chapter switch / unmount /
        // timeout / replacement aborts leave no stopped marker.
        if (
          isCurrentEditingScope(requestScope)
          && activeEditRunRef.current?.runId === runId
        ) {
          setChanges([...changesRef.current]);
        }
      } else if (!isAIActionGateCancellation(error)) {
        if (!isCurrentEditingScope(requestScope)) return;
        toast(error instanceof Error ? error.message : 'Edit failed');
      }
    } finally {
      if (editAbortRef.current === abort) editAbortRef.current = null;
      const stopAcknowledgementPending = stopLatchRef.current.has(runId);
      const ownsActiveRun = activeEditRunRef.current?.runId === runId;
      if (ownsActiveRun && !stopAcknowledgementPending) {
        activeEditRunRef.current = null;
      }
      if (
        ownsActiveRun
        && isCurrentEditingScope(requestScope)
        && !stopAcknowledgementPending
      ) {
        setIsLoading(false);
        setEditStreaming(false);
        handleClearSelection();
      }
    }
    // chatMessages is intentionally OMITTED — handleSend reads it via
    // chatMessagesRef so the callback identity stays stable across chat
    // appends.
  }, [chapter, storageReady, creativity, styleId, novelId, selectedText, toast, handleClearSelection, t.loading, generationTimeoutMessage, isCurrentEditingScope, changesRef, setChanges, setIsLoading, setEditStreaming, getCurrentEditorContent, updateChatMessages]);

  const handleStopEdit = useCallback(() => {
    const run = activeEditRunRef.current;
    // Always abort generation immediately; only explicit Stop with an active
    // run persists through the independent acknowledgement mutation.
    editAbortRef.current?.abort();
    if (!run) return;
    if (stopLatchRef.current.has(run.runId)) return;
    stopLatchRef.current.add(run.runId);

    const requestScope: EditingScope = {
      novelId: run.novelId,
      chapterId: run.chapterId,
      chapterNumber: run.chapterNumber,
    };
    const scopeKey = `${run.novelId}:${run.chapterId}:${run.chapterNumber}`;

    void (async () => {
      const acknowledgementAbort = new AbortController();
      const acknowledgementTimeout = setTimeout(
        () => acknowledgementAbort.abort(),
        STOP_ACK_TIMEOUT_MS,
      );
      try {
        const res = await fetch(
          `/api/novels/${run.novelId}/chapters/${run.chapterNumber}/edit`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              runId: run.runId,
              instruction: run.instruction,
              stoppedLabel,
            }),
            cache: 'no-store',
            signal: acknowledgementAbort.signal,
          },
        );
        if (!res.ok) {
          throw new Error('Stop acknowledgement failed');
        }
        const data = await res.json() as { status?: string };
        if (!isCurrentEditingScope(requestScope)) return;

        if (data.status === 'cancelled') {
          // Visible Stopped means SQLite cancelled terminal is committed.
          updateChatMessages(prev => [
            ...prev,
            {
              id: `system-${run.runId}`,
              role: 'assistant',
              content: stoppedLabel,
              timestamp: Date.now(),
            },
          ]);
        } else if (data.status === 'done') {
          // Terminal done won the race — do not show Stopped; rehydrate.
          const messages = await loadDurableHistory(requestScope);
          if (messages) {
            setChatState({ scopeKey, messages });
          }
        } else {
          throw new Error('Invalid Stop acknowledgement');
        }
      } catch {
        if (isCurrentEditingScope(requestScope)) {
          toast(t.errorSaveFailed, 'error');
        }
      } finally {
        clearTimeout(acknowledgementTimeout);
        stopLatchRef.current.delete(run.runId);
        const ownsActiveRun = activeEditRunRef.current?.runId === run.runId;
        if (ownsActiveRun) {
          activeEditRunRef.current = null;
        }
        if (ownsActiveRun && isCurrentEditingScope(requestScope)) {
          setIsLoading(false);
          setEditStreaming(false);
          handleClearSelection();
        }
      }
    })();
  }, [
    stoppedLabel,
    isCurrentEditingScope,
    updateChatMessages,
    loadDurableHistory,
    toast,
    t.errorSaveFailed,
    setIsLoading,
    setEditStreaming,
    handleClearSelection,
  ]);

  // Chapter switch: abort the in-flight edit stream without explicit Stop.
  // Transcript visibility is keyed to activeChatScopeKey during render, and
  // the parent calls this only after its outgoing draft flush and
  // applyChapterSwitch. That activation point owns the incoming scope's
  // authoritative GET; the prop effect above handles initial/storage-ready
  // loads only when the draft controller already agrees with the scope.
  const resetForChapterSwitch = useCallback(() => {
    editAbortRef.current?.abort();
    editAbortRef.current = null;
    activeEditRunRef.current = null;

    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    hydrateGenRef.current += 1;
    if (!activeChatScopeKey || !chapterId || chapterNumber == null) return;
    const requestScope: EditingScope = {
      novelId,
      chapterId,
      chapterNumber,
    };
    if (!isCurrentEditingScope(requestScope)) return;

    const abort = new AbortController();
    historyAbortRef.current = abort;
    void loadDurableHistory(requestScope, abort.signal).then(messages => {
      if (messages) {
        setChatState({ scopeKey: activeChatScopeKey, messages });
      }
    }).finally(() => {
      if (historyAbortRef.current === abort) historyAbortRef.current = null;
    });
  }, [
    activeChatScopeKey,
    chapterId,
    chapterNumber,
    novelId,
    isCurrentEditingScope,
    loadDurableHistory,
  ]);

  // Abort in-flight generation on scope change / unmount without treating it
  // as explicit Stop (no stopped history). Scoped deps avoid an empty-array
  // exhaustive-deps warning while preserving abort-only cleanup.
  useEffect(() => {
    return () => {
      editAbortRef.current?.abort();
      historyAbortRef.current?.abort();
    };
  }, [activeChatScopeKey]);

  return {
    chatMessages,
    handleSend,
    handleStopEdit,
    resetForChapterSwitch,
  } as const;
}
