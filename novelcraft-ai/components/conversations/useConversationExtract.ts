'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeEntryPrefill } from '@/components/knowledge/KnowledgeEntryForm';
import type { ExtractedEntry } from '@/lib/ai/conversation-extract';

export interface UseConversationExtractArgs {
  novelId: string;
  conversationId: string;
  locale: string;
  /** Surface an extract failure (the component shows a toast). */
  onError: () => void;
  /** Fired when the model was unavailable but a stub was returned. */
  onModelUnavailable?: () => void;
  /** Fired when the extractor degraded to a manual prefill after model failure. */
  onDegraded?: () => void;
}

export interface UseConversationExtractResult {
  /** Message id currently being extracted (drives the per-message spinner). */
  extractingFor: string | null;
  /** Prefill for the knowledge form once extraction succeeds; null when closed. */
  prefill: KnowledgeEntryPrefill | null;
  openExtractDialog: (messageId: string) => Promise<void>;
  clearPrefill: () => void;
}

/**
 * The "extract assistant message → knowledge form" flow, pulled out of
 * ConversationThread so its concurrency guard is unit-testable. Each extract is
 * bound to the current scope (`novelId:conversationId`) AND a per-call sequence
 * number; a response is applied only if neither the scope changed nor a newer
 * extract superseded it. Without that guard a slow extract from an old message/
 * conversation would pop a stale prefill over whatever the user switched to.
 */
export function useConversationExtract(args: UseConversationExtractArgs): UseConversationExtractResult {
  const { novelId, conversationId, locale, onError, onModelUnavailable, onDegraded } = args;
  const [extractingFor, setExtractingFor] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<KnowledgeEntryPrefill | null>(null);

  const activeScopeRef = useRef(`${novelId}:${conversationId}`);
  const extractRequestSeqRef = useRef(0);

  // Keep mutable callbacks fresh without rebuilding the long-lived closure.
  const callbacksRef = useRef({ onError, onModelUnavailable, onDegraded });
  useEffect(() => {
    callbacksRef.current = { onError, onModelUnavailable, onDegraded };
  });

  // Reset on scope change and invalidate any outstanding extract. The refs flip
  // synchronously so an in-flight extract is dropped immediately; the state
  // resets are deferred to a microtask (setState-in-effect would cascade).
  useEffect(() => {
    activeScopeRef.current = `${novelId}:${conversationId}`;
    extractRequestSeqRef.current += 1;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setExtractingFor(null);
      setPrefill(null);
    });
    return () => {
      cancelled = true;
    };
  }, [novelId, conversationId]);

  const openExtractDialog = useCallback(async (messageId: string) => {
    const requestScope = `${novelId}:${conversationId}`;
    const requestSeq = ++extractRequestSeqRef.current;
    const isActiveExtract = () =>
      activeScopeRef.current === requestScope && extractRequestSeqRef.current === requestSeq;
    setExtractingFor(messageId);
    try {
      const res = await fetch(
        `/api/novels/${novelId}/conversations/${conversationId}/messages/${messageId}/extract`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-locale': locale },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        if (isActiveExtract()) callbacksRef.current.onError();
        return;
      }
      const data = (await res.json()) as ExtractedEntry & { _modelUnavailable?: boolean; _degraded?: boolean };
      if (!isActiveExtract()) return;
      const next: KnowledgeEntryPrefill = {
        type: data.type,
        title: data.title,
        summary: data.summary,
        data: data.data,
        suggestedWikilinks: data.suggestedWikilinks,
        suggestedRelations: data.suggestedRelations,
      };
      // Surface the summary as pre-filled prose in the per-type body field.
      if (data.summary && next.data) {
        if (data.type === 'character' || data.type === 'world' || data.type === 'timeline') {
          next.data = { ...next.data, description: data.summary };
        } else if (data.type === 'outline') {
          next.data = { ...next.data, synopsis: data.summary };
        }
      }
      if (data._modelUnavailable) callbacksRef.current.onModelUnavailable?.();
      if (data._degraded) callbacksRef.current.onDegraded?.();
      setPrefill(next);
    } catch (err) {
      if (isActiveExtract()) {
        console.error('extract failed', err);
        callbacksRef.current.onError();
      }
    } finally {
      if (isActiveExtract()) setExtractingFor(null);
    }
  }, [novelId, conversationId, locale]);

  const clearPrefill = useCallback(() => setPrefill(null), []);

  return { extractingFor, prefill, openExtractDialog, clearPrefill };
}
