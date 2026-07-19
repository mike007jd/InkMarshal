'use client';

import { useCallback, useRef, useState, type RefObject } from 'react';
import type { LexicalEditor } from 'lexical';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { applyChanges, locateOriginalText, type ChangeItem } from '@/lib/diff-utils';
import { readEditorPlainText } from '@/components/editor/lexical-helpers';
import type { HighlightRange } from '@/components/editor/types';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';
import { requestManuscriptFlush } from '@/lib/desktop-shell-bus';

interface UseDiffConfirmationArgs {
  novelId: string;
  chapter: ManuscriptChapter | null;
  editorRef: RefObject<LexicalEditor | null>;
  /** Writes accepted text back through the editor (joins undo history). */
  applyTextThroughEditor: (newContent: string) => void;
  /** Clears the editor selection once a generated change is staged. */
  handleClearSelection: () => void;
}

/**
 * Owns the diff accept/reject lifecycle: the pending `changes` array (mirrored
 * in `changesRef` so streaming producers can append synchronously), the
 * apply-once guard, and the conversion of generated prose into a ChangeItem.
 * Both the single/multi-variant generation path and the freeform edit-chat
 * path feed changes in here; accepted edits are written through the editor.
 */
export function useDiffConfirmation({
  novelId,
  chapter,
  editorRef,
  applyTextThroughEditor,
  handleClearSelection,
}: UseDiffConfirmationArgs) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const changesRef = useRef<ChangeItem[]>([]);
  const applyingRef = useRef(false);

  /**
   * Build a ChangeItem from generated text + the current operation context,
   * then push it through the DiffConfirmCard accept/reject flow. Shared
   * between the single-variant fast path and the variant-picked text path.
   *
   * For 'rewrite': the change.original is the user's selection, replacement
   * is the new text, location is `highlightRange` (we know exactly where).
   * For 'continue': no selection — synthesize a sentinel ChangeItem with
   * empty original and a location at end-of-text so applyChanges appends.
   */
  const pushGeneratedTextAsChange = useCallback((args: {
    mode: 'continue' | 'rewrite';
    generated: string;
    originalSelection: string;
    highlightRange: HighlightRange | null;
  }) => {
    if (!chapter) return;
    const editor = editorRef.current;
    const baseContent = editor ? readEditorPlainText(editor) : chapter.content;
    let item: ChangeItem;
    if (args.mode === 'rewrite') {
      const original = args.originalSelection;
      const location = args.highlightRange
        ? { start: args.highlightRange.start, end: args.highlightRange.start + original.length }
        : locateOriginalText(baseContent, original);
      item = {
        id: `rewrite-${Date.now()}`,
        original,
        replacement: args.generated,
        status: 'pending',
        location,
      };
    } else {
      // continue: append-after-cursor. The "selection" was used as the
      // before-context; we append AFTER the selection in the chapter.
      const endIdx = args.highlightRange
        ? args.highlightRange.start + args.originalSelection.length
        : baseContent.length;
      item = {
        id: `continue-${Date.now()}`,
        original: args.originalSelection,
        replacement: `\n\n${args.generated}`,
        status: 'pending',
        location: { start: Math.max(0, endIdx - args.originalSelection.length), end: endIdx },
        insertAfterOriginal: true,
      };
    }
    changesRef.current = [item];
    setChanges([item]);
    handleClearSelection();
  }, [chapter, editorRef, handleClearSelection]);

  const applyAllAccepted = useCallback(async (finalChanges: ChangeItem[]) => {
    if (applyingRef.current || !chapter) return;
    const accepted = finalChanges.filter(c => c.status === 'accepted' && c.location !== null);
    if (accepted.length === 0) return;
    applyingRef.current = true;
    try {
      const saveOutcome = await requestManuscriptFlush();
      if (!saveOutcome.ok) throw new Error(t.editorSaveError);
      const snapshotResponse = await fetch(
        `/api/novels/${novelId}/chapters/${chapter.chapterNumber}/snapshots`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: t.aiRecoverySnapshotLabel }),
        },
      );
      if (!snapshotResponse.ok) throw new Error(t.aiRecoverySnapshotFailed);

      const editor = editorRef.current;
      const baseContent = editor ? readEditorPlainText(editor) : chapter.content;
      const { text: newContent, skipped } = applyChanges(baseContent, accepted);
      applyTextThroughEditor(newContent);
      if (skipped > 0) {
        // Some accepted edits overlapped each other (or could no longer be
        // located) and were not written — tell the writer instead of letting
        // the diff card close as if everything applied.
        toast(t.diffOverlapSkipped.replace('{n}', String(skipped)), 'error');
      }
    } catch (error) {
      const retryable = finalChanges.map(change =>
        change.status === 'accepted' ? { ...change, status: 'pending' as const } : change,
      );
      changesRef.current = retryable;
      setChanges(retryable);
      toast(error instanceof Error ? error.message : t.aiRecoverySnapshotFailed, 'error');
    } finally {
      applyingRef.current = false;
    }
  }, [applyTextThroughEditor, chapter, editorRef, novelId, toast, t]);

  const handleChangeDecision = useCallback((id: string, status: 'accepted' | 'rejected') => {
    const updated = changesRef.current.map(c => c.id === id ? { ...c, status } : c);
    changesRef.current = updated;
    setChanges(updated);
    if (updated.every(c => c.status !== 'pending')) void applyAllAccepted(updated);
  }, [applyAllAccepted]);

  const handleAccept = useCallback((id: string) => handleChangeDecision(id, 'accepted'), [handleChangeDecision]);
  const handleReject = useCallback((id: string) => handleChangeDecision(id, 'rejected'), [handleChangeDecision]);

  const handleAcceptAll = useCallback(() => {
    const updated = changesRef.current.map(c =>
      c.status === 'pending'
        ? { ...c, status: c.location ? 'accepted' as const : 'rejected' as const }
        : c
    );
    changesRef.current = updated;
    setChanges(updated);
    void applyAllAccepted(updated);
  }, [applyAllAccepted]);

  const handleRejectAll = useCallback(() => {
    const updated = changesRef.current.map(c =>
      c.status === 'pending' ? { ...c, status: 'rejected' as const } : c,
    );
    changesRef.current = updated;
    setChanges(updated);
  }, []);

  // Drop staged changes on chapter switch (matches the original reset, which
  // clears the `changes` state only — changesRef is a scratch buffer that the
  // next producer overwrites).
  const reset = useCallback(() => {
    changesRef.current = [];
    setChanges([]);
  }, []);

  return {
    changes,
    changesRef,
    setChanges,
    pushGeneratedTextAsChange,
    handleAccept,
    handleReject,
    handleAcceptAll,
    handleRejectAll,
    reset,
  } as const;
}
