'use client';

import { useCallback, useState, type RefObject } from 'react';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import type { HighlightRange } from '@/components/editor/types';

interface UseEditorSelectionArgs {
  /** The chatbox input ref, owned by the view, so the toolbar's "AI edit"
   *  affordance can focus it. */
  chatboxRef: RefObject<HTMLInputElement | null>;
}

/**
 * Owns the in-editor text selection surfaced by the floating SelectionToolbar:
 * the selected text, its highlight range (for pinpointing rewrites), and the
 * toolbar anchor position.
 */
export function useEditorSelection({ chatboxRef }: UseEditorSelectionArgs) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [selectedText, setSelectedText] = useState<string | undefined>();
  const [highlightRange, setHighlightRange] = useState<HighlightRange | null>(null);
  const [toolbarPos, setToolbarPos] = useState<{ top: number; left: number } | null>(null);

  const handleTextSelect = useCallback((text: string, rect: DOMRect, range: HighlightRange) => {
    setSelectedText(text);
    setHighlightRange(range);
    setToolbarPos({ top: rect.top, left: rect.left + rect.width / 2 - 120 });
  }, []);

  const handleSelectionClear = useCallback(() => {
    setToolbarPos(null);
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedText(undefined);
    setHighlightRange(null);
    setToolbarPos(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleAIEditFromToolbar = useCallback(() => {
    setToolbarPos(null);
    window.getSelection()?.removeAllRanges();
    setTimeout(() => chatboxRef.current?.focus(), 0);
  }, [chatboxRef]);

  const handleCopy = useCallback(() => {
    if (selectedText) {
      navigator.clipboard.writeText(selectedText);
      toast(t.copySuccess || 'Copied');
    }
    setToolbarPos(null);
  }, [selectedText, toast, t]);

  // Clear selection state on chapter switch. Unlike handleClearSelection this
  // does NOT touch the DOM selection — the chapter swap reseeds the editor.
  const reset = useCallback(() => {
    setSelectedText(undefined);
    setHighlightRange(null);
    setToolbarPos(null);
  }, []);

  return {
    selectedText,
    highlightRange,
    toolbarPos,
    setToolbarPos,
    handleTextSelect,
    handleSelectionClear,
    handleClearSelection,
    handleAIEditFromToolbar,
    handleCopy,
    reset,
  } as const;
}
