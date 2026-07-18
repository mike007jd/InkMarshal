'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { buildModelHeaders, consumeNdjsonStream, type AIRequestOperation } from '@/lib/streaming-client';
import { WRITING_SESSION_READ_TIMEOUT_MS } from '@/lib/writing-session';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import type { HighlightRange } from '@/components/editor/types';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';
import type { EditingScope } from '@/hooks/useChapterDraftController';
import { isAIActionGateCancellation } from '@/lib/ai-action-gate';

interface UseManuscriptGenerationArgs {
  chapter: ManuscriptChapter | null;
  novelId: string;
  storageReady: boolean;
  creativity: CreativityLevel;
  styleId: string | null;
  selectedText: string | undefined;
  highlightRange: HighlightRange | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  setToolbarPos: (pos: { top: number; left: number } | null) => void;
  isCurrentEditingScope: (scope: EditingScope) => boolean;
  pushGeneratedTextAsChange: (args: {
    mode: 'continue' | 'rewrite';
    generated: string;
    originalSelection: string;
    highlightRange: HighlightRange | null;
  }) => void;
}

/**
 * Owns the toolbar "Continue" / "Rewrite" generation flows and streams the
 * result into a DiffConfirmCard. One abort controller prevents a chapter switch
 * or unmount from applying a stale response.
 */
export function useManuscriptGeneration({
  chapter,
  novelId,
  storageReady,
  creativity,
  styleId,
  selectedText,
  highlightRange,
  isLoading,
  setIsLoading,
  setToolbarPos,
  isCurrentEditingScope,
  pushGeneratedTextAsChange,
}: UseManuscriptGenerationArgs) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const generationTimeoutMessage = t.generationTimedOut || 'Generation timed out — try again.';

  const singleTextAbortRef = useRef<AbortController | null>(null);

  // Stream helper for continue/rewrite APIs.
  const streamResponse = useCallback(async (
    url: string,
    body: Record<string, unknown>,
    operation: AIRequestOperation,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (!storageReady) {
      throw new Error(t.loading || 'Loading');
    }
    // Forward the user-pinned creativity level and style entry id via the
    // `x-im-*` headers.
    const headers = await buildModelHeaders(operation, {
      creativity,
      styleId: styleId ?? undefined,
    }, { signal });
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || 'Request failed');
    }
    // /continue and /rewrite routes emit NDJSON frames per
    // lib/streaming-helpers (chunk/done/error). A `done` frame can carry a
    // non-clean finishReason ('length' = cut off at the output cap, 'error' =
    // provider failed after partial output) which we surface as a warning so the
    // writer doesn't accept truncated prose as a finished result. An in-stream
    // `error` frame (provider failed mid-stream after a 200) used to throw out
    // of onEvent, discarding any preceding text the user could still salvage —
    // for a long generation that failed at 90% that was unrecoverable data loss.
    // Keep the partial result and flag it incomplete so the writer decides
    // whether to accept the partial.
    let result = '';
    let incomplete = false;
    await consumeNdjsonStream(res, {
      onEvent: data => {
        const type = data.type as string | undefined;
        if (type === 'chunk') {
          result += (data.text as string) ?? '';
        } else if (type === 'done') {
          const reason = data.finishReason as string | undefined;
          if (reason === 'length' || reason === 'error') incomplete = true;
        } else if (type === 'error') {
          // Keep the partial result; flag incomplete so the writer reviews
          // before accepting. Throwing here would discard already-streamed text.
          incomplete = true;
        }
      },
    }, {
      // Don't let a stalled stream (provider hung after the 200) keep the editor
      // spinner stuck forever; the catch turns the timeout into a retry toast.
      readTimeoutMs: WRITING_SESSION_READ_TIMEOUT_MS,
      timeoutMessage: generationTimeoutMessage,
    });
    if (incomplete) {
      toast(t.generationIncomplete || 'The generation may be incomplete — review before accepting.', 'info');
    }
    return result;
  }, [storageReady, creativity, styleId, toast, t, generationTimeoutMessage]);

  const handleContinueRef = useRef<() => void>(() => {});
  const handleContinue = useCallback(async () => {
    if (!chapter || !selectedText || isLoading) return;
    const requestScope = {
      novelId,
      chapterId: chapter.id,
      chapterNumber: chapter.chapterNumber,
    };
    setIsLoading(true);
    setToolbarPos(null);
    singleTextAbortRef.current?.abort();
    const singleTextAbort = new AbortController();
    singleTextAbortRef.current = singleTextAbort;
    try {
      const url = `/api/novels/${novelId}/chapters/${chapter.chapterNumber}/continue`;
      const text = await streamResponse(url, { contextBefore: selectedText }, 'chapter', singleTextAbort.signal);
      if (!isCurrentEditingScope(requestScope)) return;
      pushGeneratedTextAsChange({
        mode: 'continue',
        generated: text,
        originalSelection: selectedText,
        highlightRange,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (isAIActionGateCancellation(error)) return;
      if (!isCurrentEditingScope(requestScope)) return;
      // Surface the model-supply layer's actionable message (bind a model,
      // restart the runtime, re-enter a key) instead of a generic 'failed' that
      // makes the Retry button a dead end.
      toast(error instanceof Error && error.message ? error.message : (t.continueFailed || 'Continue failed'), 'error', {
        action: { label: t.toastRetry, onClick: () => handleContinueRef.current() },
      });
    } finally {
      if (singleTextAbortRef.current === singleTextAbort) singleTextAbortRef.current = null;
      if (isCurrentEditingScope(requestScope)) setIsLoading(false);
    }
  }, [chapter, selectedText, highlightRange, isLoading, novelId, streamResponse, pushGeneratedTextAsChange, toast, t, isCurrentEditingScope, setIsLoading, setToolbarPos]);
  useEffect(() => { handleContinueRef.current = handleContinue; }, [handleContinue]);

  const handleRewriteRef = useRef<() => void>(() => {});
  const handleRewrite = useCallback(async () => {
    if (!chapter || !selectedText || isLoading) return;
    const requestScope = {
      novelId,
      chapterId: chapter.id,
      chapterNumber: chapter.chapterNumber,
    };
    setIsLoading(true);
    setToolbarPos(null);
    singleTextAbortRef.current?.abort();
    const singleTextAbort = new AbortController();
    singleTextAbortRef.current = singleTextAbort;
    try {
      const url = `/api/novels/${novelId}/chapters/${chapter.chapterNumber}/rewrite`;
      const text = await streamResponse(url, {
        selectedText,
        instruction: t.rewriteDefaultPrompt || 'Rewrite this passage while preserving the original meaning',
      }, 'polish', singleTextAbort.signal);
      if (!isCurrentEditingScope(requestScope)) return;
      pushGeneratedTextAsChange({
        mode: 'rewrite',
        generated: text,
        originalSelection: selectedText,
        highlightRange,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (isAIActionGateCancellation(error)) return;
      if (!isCurrentEditingScope(requestScope)) return;
      // Surface the model-supply layer's actionable message instead of a generic
      // 'failed' that makes the Retry button a dead end.
      toast(error instanceof Error && error.message ? error.message : (t.rewriteFailed || 'Rewrite failed'), 'error', {
        action: { label: t.toastRetry, onClick: () => handleRewriteRef.current() },
      });
    } finally {
      if (singleTextAbortRef.current === singleTextAbort) singleTextAbortRef.current = null;
      if (isCurrentEditingScope(requestScope)) setIsLoading(false);
    }
  }, [chapter, selectedText, highlightRange, isLoading, novelId, streamResponse, pushGeneratedTextAsChange, toast, t, isCurrentEditingScope, setIsLoading, setToolbarPos]);
  useEffect(() => { handleRewriteRef.current = handleRewrite; }, [handleRewrite]);

  // Chapter switch invalidates the current request so late frames cannot apply
  // to the next chapter.
  const resetForChapterSwitch = useCallback(() => {
    singleTextAbortRef.current?.abort();
    singleTextAbortRef.current = null;
  }, []);

  // Abort in-flight streams when the view unmounts.
  useEffect(() => () => {
    singleTextAbortRef.current?.abort();
  }, []);

  return {
    handleContinue,
    handleRewrite,
    resetForChapterSwitch,
  } as const;
}
