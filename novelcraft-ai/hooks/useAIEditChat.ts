'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { buildModelHeaders, consumeNdjsonStream } from '@/lib/streaming-client';
import { WRITING_SESSION_READ_TIMEOUT_MS } from '@/lib/writing-session';
import { locateOriginalText, type ChangeItem } from '@/lib/diff-utils';
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

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  // Ref mirror so handleSend can read latest chat without listing chatMessages
  // in its deps — keeps the handleSend identity stable across appends.
  const chatMessagesRef = useRef<ChatMessage[]>(chatMessages);
  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);
  const editAbortRef = useRef<AbortController | null>(null);

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
    // Cancel any in-flight edit stream.
    editAbortRef.current?.abort();
    const abort = new AbortController();
    editAbortRef.current = abort;
    setIsLoading(true);
    setEditStreaming(true);

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: instruction,
      timestamp: Date.now(),
    };
    setChatMessages(prev => [...prev, userMsg]);

    try {
      // Read the latest chat history from the ref so this handler doesn't
      // need to list `chatMessages` in its deps — see chatMessagesRef
      // declaration for why.
      const recentHistory = chatMessagesRef.current.slice(-5).map(m => ({
        role: m.role,
        content: m.content,
      }));
      const baseContent = getCurrentEditorContent();

      const res = await fetch(`/api/novels/${novelId}/chapters/${chapter.chapterNumber}/edit`, {
        method: 'POST',
        headers: await buildModelHeaders(
          'polish',
          { creativity, styleId: styleId ?? undefined },
          { signal: abort.signal },
        ),
        body: JSON.stringify({
          instruction,
          selectedText: selectedText || undefined,
          fullText: baseContent,
          chatHistory: recentHistory,
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
          if (data.type === 'change') {
            const original = data.original as string;
            const location = locateOriginalText(baseContent, original);
            changesRef.current.push({
              id: (data.id as string) || `change-${changesRef.current.length}`,
              original,
              replacement: data.replacement as string,
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
            setChatMessages(prev => [...prev, assistantMsg]);
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
        // Stopped by the user — already pushed the stop notice in handleStopEdit.
        if (isCurrentEditingScope(requestScope)) setChanges([...changesRef.current]);
      } else if (!isAIActionGateCancellation(error)) {
        if (!isCurrentEditingScope(requestScope)) return;
        toast(error instanceof Error ? error.message : 'Edit failed');
      }
    } finally {
      if (editAbortRef.current === abort) editAbortRef.current = null;
      if (isCurrentEditingScope(requestScope)) {
        setIsLoading(false);
        setEditStreaming(false);
        handleClearSelection();
      }
    }
    // chatMessages is intentionally OMITTED — handleSend reads it via
    // chatMessagesRef so the callback identity stays stable across chat
    // appends.
  }, [chapter, storageReady, creativity, styleId, novelId, selectedText, toast, handleClearSelection, t.loading, generationTimeoutMessage, isCurrentEditingScope, changesRef, setChanges, setIsLoading, setEditStreaming, getCurrentEditorContent]);

  const handleStopEdit = useCallback(() => {
    editAbortRef.current?.abort();
    setChatMessages(prev => [
      ...prev,
      {
        id: `system-${Date.now()}`,
        role: 'assistant',
        content: t.writingStopped,
        timestamp: Date.now(),
      },
    ]);
  }, [t.writingStopped]);

  // Chapter switch: abort the in-flight edit stream and clear the transcript.
  const resetForChapterSwitch = useCallback(() => {
    editAbortRef.current?.abort();
    editAbortRef.current = null;
    setChatMessages([]);
  }, []);

  // Abort the in-flight edit stream when the view unmounts.
  useEffect(() => () => {
    editAbortRef.current?.abort();
  }, []);

  return {
    chatMessages,
    handleSend,
    handleStopEdit,
    resetForChapterSwitch,
  } as const;
}
