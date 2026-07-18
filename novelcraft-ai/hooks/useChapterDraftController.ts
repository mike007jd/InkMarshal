'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { LexicalEditor } from 'lexical';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { useSaveStatus } from '@/hooks/useSaveStatus';
import { replaceEditorText, readEditorPlainText } from '@/components/editor/lexical-helpers';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';
import type { SaveState } from '@/components/SaveStatusIndicator';
import { SAVE_NOW_EVENT, type SaveNowEventDetail } from '@/lib/desktop-shell-bus';
import { performKeepaliveChapterSave } from '@/hooks/keepalive-chapter-save';

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
  // True while a debounced/explicit flushSave PATCH is awaiting the server.
  // The close-path (beforeunload keepalive) reads this to avoid racing an
  // in-flight write for the same dirty buffer — see the beforeunload effect.
  const flushInFlightRef = useRef(false);
  // True while a beforeunload keepalive PATCH is in flight, so the unmount
  // cleanup doesn't fire a second writer for the same dirty buffer. Unlike the
  // old optimistic isDirtyRef clear, this does not lose the buffer if the
  // keepalive PATCH fails — isDirtyRef is only cleared on PATCH success.
  const beforeUnloadClaimedRef = useRef(false);
  const flushSave = useCallback(async (): Promise<boolean> => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (!isDirtyRef.current) return true;
    const targetNovelId = activeNovelIdRef.current;
    const chapterNumber = activeChapterNumberRef.current;
    if (chapterNumber == null) return true;
    const content = pendingContentRef.current;
    const expectedVersion = versionRef.current;
    saveMarkSaving();
    flushInFlightRef.current = true;
    let result: 'ok' | 'conflict' | 'fail';
    try {
      result = await persistChapter(targetNovelId, content, chapterNumber, expectedVersion);
    } finally {
      flushInFlightRef.current = false;
    }
    if (result === 'ok') {
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

  // Cmd+S / macOS menu "Save" bridge. Wave 3 commit 4 wires the menu event
  // to `window.dispatchEvent(new CustomEvent('inkmarshal:save-now'))`; we
  // listen pre-emptively so the menu can land independently. Surface the
  // chapter identity when the flush fails so callers (export, snapshot)
  // can show which chapter still has unsaved work.
  useEffect(() => {
    const saveNow = (event: Event) => {
      const chapterRef = chapter;
      const detail = (event as CustomEvent<SaveNowEventDetail>).detail;
      const promise = flushSaveRef.current().then(async ok => {
        if (!ok || !detail?.createRecoveryPoint || !chapterRef) {
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
    window.addEventListener(SAVE_NOW_EVENT, saveNow);
    return () => window.removeEventListener(SAVE_NOW_EVENT, saveNow);
  }, [chapter, novelId, t.snapshotCreateFailed, toast]);

  // Best-effort flush on unmount / window close. There are two possible
  // close-path writers — the `beforeunload` keepalive PATCH and the unmount
  // cleanup's `flushSave()` — and in a Tauri window close BOTH can fire. We
  // make this a single writer to avoid the un-coordinated double PATCH that,
  // under optimistic-concurrency (`version`), would land out of order and
  // either 409 silently or clobber. The first path to claim the dirty buffer
  // flips `isDirtyRef` to false so the other no-ops. (Stream aborts on unmount
  // are owned by the AI-assist hooks' own cleanups.)
  useEffect(() => {
    const beforeUnload = () => {
      if (!isDirtyRef.current || activeChapterNumberRef.current == null) return;
      // A normal debounced/explicit flush is already mid-flight for this same
      // buffer — let it complete rather than racing it with a second write.
      if (flushInFlightRef.current) return;
      // Claim the write so the unmount cleanup below won't also fire a second
      // writer for the same dirty buffer. NOTE: we do NOT clear isDirtyRef here
      // — beforeunload can fire for non-close reasons (history navigation,
      // webview re-parenting) where the page stays alive. Clearing it optimistically
      // meant a failed keepalive PATCH permanently lost the dirty buffer with no
      // retry. Instead we mark the claim and only clear isDirtyRef once the
      // keepalive PATCH actually succeeds; on failure the debounced autosave can
      // still retry (the claim is released so the unmount path can take over too).
      beforeUnloadClaimedRef.current = true;
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      // keepalive lets the browser deliver this PATCH even after the tab is
      // being unloaded. The dirty buffer is cleared ONLY on a 2xx response —
      // a 409 (version conflict) or 5xx must keep the buffer so the debounced
      // autosave / unmount flush can retry instead of silently dropping edits.
      // (fetch resolves for any HTTP status; see performKeepaliveChapterSave.)
      void performKeepaliveChapterSave(
        fetch,
        `/api/novels/${activeNovelIdRef.current}/chapters/${activeChapterNumberRef.current}`,
        JSON.stringify({ content: pendingContentRef.current, version: versionRef.current }),
        () => {
          isDirtyRef.current = false;
        },
        () => {
          beforeUnloadClaimedRef.current = false;
        },
      );
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      // Flush on view unmount too — but only if no close-path writer already
      // claimed the dirty buffer. flushSave is the richer writer
      // (version/conflict handling, indicator) so it's the preferred path when
      // the view simply unmounts without a window close.
      if (isDirtyRef.current && !beforeUnloadClaimedRef.current && activeChapterNumberRef.current != null) {
        // fire-and-forget
        flushSave();
      }
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [flushSave, novelId]);

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
