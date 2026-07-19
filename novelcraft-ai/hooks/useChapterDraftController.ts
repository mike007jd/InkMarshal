'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { LexicalEditor } from 'lexical';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { useSaveStatus } from '@/hooks/useSaveStatus';
import { replaceEditorText, readEditorPlainText } from '@/components/editor/lexical-helpers';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';
import type { SaveState } from '@/components/SaveStatusIndicator';
import { MANUSCRIPT_FLUSH_EVENT, type ManuscriptFlushEventDetail } from '@/lib/desktop-shell-bus';

const AUTO_SAVE_DEBOUNCE_MS = 500;

/** Identity of the chapter currently being edited — guards async flows from
 *  mutating state that belongs to a chapter the user already switched away from. */
export interface EditingScope {
  novelId: string;
  chapterId: string | null;
  chapterNumber: number | null;
}

interface UseChapterDraftControllerArgs {
  novelId: string;
  chapter: ManuscriptChapter | null;
  /** Dirty text preserved by the shell when a failed save survived a switch. */
  draftContent?: string;
  storageReady: boolean;
  /** Shared Lexical editor handle, owned by the view (set via onEditorReady). */
  editorRef: RefObject<LexicalEditor | null>;
  onChaptersChange?: () => void;
  onDraftContentChange?: (chapterNumber: number, content: string, dirty: boolean, version?: number) => void;
  onSaveStatusChange?: (state: SaveState, lastSavedAt: number | null) => void;
}

/**
 * Owns the chapter text buffer, optimistic-concurrency persistence (debounced
 * autosave + explicit flush + 409 conflict handling), the per-chapter scope
 * identity, and the editor-sync seed. The view composes this with the AI-assist
 * hooks; cross-cutting orchestration (chapter switch, unmount) lives in the view
 * but is expressed through the operations this hook returns.
 */
export function useChapterDraftController({
  novelId,
  chapter,
  draftContent,
  storageReady,
  editorRef,
  onChaptersChange,
  onDraftContentChange,
  onSaveStatusChange,
}: UseChapterDraftControllerArgs) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const {
    state: saveState,
    lastSavedAt,
    markSaving: saveMarkSaving,
    markSaved: saveMarkSaved,
    markFailed: saveMarkFailed,
    reset: saveReset,
  } = useSaveStatus();

  // Propagate state changes to the shell. Keep the callback ref stable via
  // a passthrough so we don't churn deps for every render.
  const onSaveStatusChangeRef = useRef(onSaveStatusChange);
  useEffect(() => { onSaveStatusChangeRef.current = onSaveStatusChange; }, [onSaveStatusChange]);
  // Skip pushing identical tuples up to the shell. Autosave can re-run the
  // state machine through the same (state, lastSavedAt) on consecutive cycles
  // (e.g. two "saved" transitions with the same timestamp); without this guard
  // each one fires the parent's two setStates → a redundant shell + editor
  // re-render cascade during typing.
  const lastPushedStatusRef = useRef<{ state: SaveState; at: number | null } | null>(null);
  useEffect(() => {
    const last = lastPushedStatusRef.current;
    if (last && last.state === saveState && last.at === lastSavedAt) return;
    lastPushedStatusRef.current = { state: saveState, at: lastSavedAt };
    onSaveStatusChangeRef.current?.(saveState, lastSavedAt);
  }, [saveState, lastSavedAt]);

  const versionRef = useRef<number>(chapter?.version ?? 0);
  const pendingContentRef = useRef<string>(chapter?.content ?? '');
  const isDirtyRef = useRef<boolean>(false);
  // Monotonic editor revision. A save may resolve after the writer has typed
  // more text; only the revision captured by that request is then durable.
  const editRevisionRef = useRef(0);
  const [editorSync, setEditorSync] = useState(() => ({
    scopeKey: `${novelId}:${chapter?.id ?? 'none'}`,
    content: draftContent ?? chapter?.content ?? '',
    version: chapter?.version ?? 0,
  }));
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Surface the load id so AbortController-style flush flows can pin to the
  // right chapter when racing with a chapter switch.
  const activeNovelIdRef = useRef(novelId);
  const activeChapterIdRef = useRef<string | null>(chapter?.id ?? null);
  const activeChapterNumberRef = useRef<number | null>(chapter?.chapterNumber ?? null);
  const isCurrentEditingScope = useCallback((scope: EditingScope) => (
    activeNovelIdRef.current === scope.novelId
    && activeChapterIdRef.current === scope.chapterId
    && activeChapterNumberRef.current === scope.chapterNumber
  ), []);

  const persistChapter = useCallback(async (
    targetNovelId: string,
    newContent: string,
    chapterNumber: number,
    expectedVersion: number,
  ): Promise<'ok' | 'conflict' | 'fail'> => {
    if (!storageReady) return 'fail';
    try {
      const res = await fetch(`/api/novels/${targetNovelId}/chapters/${chapterNumber}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent, version: expectedVersion }),
      });
      if (res.status === 409) return 'conflict';
      if (!res.ok) return 'fail';
      const data = await res.json();
      if (typeof data.version === 'number') versionRef.current = data.version;
      return 'ok';
    } catch {
      return 'fail';
    }
  }, [storageReady]);

  // Memoize the latest flushSave so the failed-toast retry action and the
  // SaveStatusIndicator's onRetry can re-call it without closing over a stale
  // reference. We keep the impl inside useCallback to keep deps clean for the
  // chapter-switch + unmount effects below.
  const flushSaveRef = useRef<() => Promise<boolean>>(async () => true);
  // All callers share one drain promise. This prevents Cmd+S, autosave, chapter
  // switches, and unmount from issuing overlapping optimistic-version PATCHes.
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);
  const flushSave = useCallback((): Promise<boolean> => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (flushPromiseRef.current) return flushPromiseRef.current;

    const drain = async (): Promise<boolean> => {
      while (isDirtyRef.current) {
        const targetNovelId = activeNovelIdRef.current;
        const chapterNumber = activeChapterNumberRef.current;
        if (chapterNumber == null) return true;
        const content = pendingContentRef.current;
        const expectedVersion = versionRef.current;
        const revision = editRevisionRef.current;
        saveMarkSaving();
        const result = await persistChapter(targetNovelId, content, chapterNumber, expectedVersion);
        if (result === 'ok') {
          // A newer edit landed while this request was in flight. The response
          // advances the optimistic base version, but it must not clear that
          // newer dirty buffer; loop immediately and persist the latest text.
          if (revision !== editRevisionRef.current) continue;
          isDirtyRef.current = false;
          onDraftContentChange?.(chapterNumber, content, false);
          if (targetNovelId === novelId) onChaptersChange?.();
          saveMarkSaved();
          return true;
        }
        if (result === 'conflict') {
          // Keep the local dirty buffer as the user's source of truth. A refetch
          // here would push the newer DB text into ContentSyncPlugin and overwrite
          // the unsaved editor contents.
          toast(t.versionConflict, 'error', {
            action: { label: t.toastRetry, onClick: () => { flushSaveRef.current(); } },
          });
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          saveMarkFailed(() => { flushSaveRef.current(); });
          return false;
        }
        // Hard failure — surface in indicator + toast with retry action.
        saveMarkFailed(() => { flushSaveRef.current(); });
        toast(t.editorSaveError, 'error', {
          action: { label: t.toastRetry, onClick: () => { flushSaveRef.current(); } },
        });
        return false;
      }
      return true;
    };

    const promise = drain();
    flushPromiseRef.current = promise;
    void promise.finally(() => {
      if (flushPromiseRef.current === promise) flushPromiseRef.current = null;
    });
    return promise;
  }, [novelId, onChaptersChange, onDraftContentChange, persistChapter, saveMarkSaving, saveMarkSaved, saveMarkFailed, t.editorSaveError, t.toastRetry, t.versionConflict, toast]);
  useEffect(() => { flushSaveRef.current = flushSave; }, [flushSave]);

  // Track content/version refreshes (autosave round-trip, external refetch)
  // without clobbering UI state. Updates the refs that flushSave reads from.
  useEffect(() => {
    if (novelId === activeNovelIdRef.current && chapter?.chapterNumber === activeChapterNumberRef.current) {
      if (isDirtyRef.current) return;
      versionRef.current = chapter?.version ?? 0;
      pendingContentRef.current = chapter?.content ?? '';
      setEditorSync({
        scopeKey: `${novelId}:${chapter?.id ?? 'none'}`,
        content: chapter?.content ?? '',
        version: chapter?.version ?? 0,
      });
    }
  }, [novelId, chapter?.id, chapter?.version, chapter?.content, chapter?.chapterNumber]);

  // Cmd+S / macOS menu "Save" bridge. Surface the
  // chapter identity when the flush fails so callers (export, snapshot)
  // can show which chapter still has unsaved work.
  useEffect(() => {
    const saveNow = (event: Event) => {
      const chapterRef = chapter;
      const detail = (event as CustomEvent<ManuscriptFlushEventDetail>).detail;
      const promise = flushSaveRef.current().then(async ok => {
        if (!ok || !detail?.createSnapshot || !chapterRef) {
          return {
            ok,
            chapterNumber: chapterRef?.chapterNumber,
            title: chapterRef?.title,
          };
        }
        try {
          const response = await fetch(
            `/api/novels/${novelId}/chapters/${chapterRef.chapterNumber}/snapshots`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            },
          );
          if (!response.ok) throw new Error('Snapshot request failed');
          return { ok: true, chapterNumber: chapterRef.chapterNumber, title: chapterRef.title };
        } catch {
          toast(t.snapshotCreateFailed, 'error');
          return { ok: false, chapterNumber: chapterRef.chapterNumber, title: chapterRef.title };
        }
      });
      detail?.waitUntil?.(promise);
    };
    window.addEventListener(MANUSCRIPT_FLUSH_EVENT, saveNow);
    return () => window.removeEventListener(MANUSCRIPT_FLUSH_EVENT, saveNow);
  }, [chapter, novelId, t.snapshotCreateFailed, toast]);

  // Closing the window is not a save command. The shell's recovery store owns
  // unload durability; this hook only cancels its pending autosave timer so it
  // cannot start a chapter PATCH while the webview is being torn down.
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, []);

  const scheduleSave = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  const handleContentChange = useCallback((content: string) => {
    pendingContentRef.current = content;
    isDirtyRef.current = true;
    editRevisionRef.current += 1;
    const chapterNumber = activeChapterNumberRef.current;
    if (chapterNumber != null) onDraftContentChange?.(chapterNumber, content, true, versionRef.current);
    scheduleSave();
  }, [onDraftContentChange, scheduleSave]);

  // Apply AI-produced text via the editor (so it joins history → Cmd+Z works).
  const applyTextThroughEditor = useCallback((newContent: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    replaceEditorText(editor, newContent);
    pendingContentRef.current = newContent;
    isDirtyRef.current = true;
    // Don't wait the full debounce — AI changes should land on disk promptly.
    flushSave();
  }, [editorRef, flushSave]);

  const getCurrentEditorContent = useCallback(() => {
    const editor = editorRef.current;
    return editor ? readEditorPlainText(editor) : pendingContentRef.current;
  }, [editorRef]);

  // Flush the OUTGOING chapter's dirty buffer before the scope refs are
  // repointed. Reads the still-current active* refs so it persists the chapter
  // the user is leaving. Caller (the view's chapter-switch effect) awaits this,
  // re-checks its `cancelled` flag, then calls applyChapterSwitch.
  const maybeFlushOnChapterSwitch = useCallback(async (nextNovelId: string, nextChapter: ManuscriptChapter | null) => {
    const nextChapterNumber = nextChapter?.chapterNumber ?? null;
    const nextChapterId = nextChapter?.id ?? null;
    const scopeChanged =
      activeNovelIdRef.current !== nextNovelId
      || activeChapterIdRef.current !== nextChapterId
      || activeChapterNumberRef.current !== nextChapterNumber;
    if (isDirtyRef.current && activeChapterNumberRef.current !== null && scopeChanged) {
      await flushSave();
    }
  }, [flushSave]);

  // Repoint the scope refs to the incoming chapter and reseed the editor. When
  // a preserved draft is being restored (draftContent !== undefined) the buffer
  // starts dirty and the save indicator shows "failed" so the user can retry;
  // otherwise the indicator resets to idle.
  const applyChapterSwitch = useCallback((
    nextNovelId: string,
    nextChapter: ManuscriptChapter | null,
    nextDraftContent: string | undefined,
  ) => {
    const nextChapterNumber = nextChapter?.chapterNumber ?? null;
    const nextChapterId = nextChapter?.id ?? null;
    activeNovelIdRef.current = nextNovelId;
    activeChapterIdRef.current = nextChapterId;
    activeChapterNumberRef.current = nextChapterNumber;
    versionRef.current = nextChapter?.version ?? 0;
    pendingContentRef.current = nextDraftContent ?? nextChapter?.content ?? '';
    const restoringDraft = nextDraftContent !== undefined;
    isDirtyRef.current = restoringDraft;
    setEditorSync({
      scopeKey: `${nextNovelId}:${nextChapterId ?? 'none'}`,
      content: nextDraftContent ?? nextChapter?.content ?? '',
      version: nextChapter?.version ?? 0,
    });
    if (restoringDraft) {
      saveMarkFailed(() => { flushSaveRef.current(); });
    } else {
      saveReset();
    }
  }, [saveMarkFailed, saveReset]);

  return {
    editorSync,
    isCurrentEditingScope,
    flushSave,
    flushSaveRef,
    handleContentChange,
    applyTextThroughEditor,
    getCurrentEditorContent,
    maybeFlushOnChapterSwitch,
    applyChapterSwitch,
  } as const;
}
