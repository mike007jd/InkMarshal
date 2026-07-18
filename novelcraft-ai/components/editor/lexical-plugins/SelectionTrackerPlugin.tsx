'use client';

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_LOW,
  type LexicalEditor,
} from 'lexical';
import type { HighlightRange } from '@/components/editor/types';

interface SelectionTrackerPluginProps {
  onTextSelect?: (text: string, rect: DOMRect, range: HighlightRange) => void;
  onSelectionClear?: () => void;
}

/**
 * Compute the absolute character offset of a selection point inside the root
 * Lexical tree, mirroring the `\n`-joined plain-text representation used by
 * the rest of the manuscript layer (paragraph separator = single newline).
 *
 * Lexical addresses positions via { node, offset } where offset is either
 * - the character offset inside a TextNode, or
 * - the child index inside an ElementNode (block edge).
 *
 * We walk children in document order: every TextNode contributes its length,
 * every ParagraphNode contributes a trailing `\n` between paragraphs.
 */
function offsetFromSelectionPoint(editor: LexicalEditor, point: { key: string; offset: number; type: 'text' | 'element' }): number {
  let totalOffset = 0;
  let found = false;

  editor.getEditorState().read(() => {
    const root = $getRoot();
    const paragraphs = root.getChildren();
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      if (para.getKey() === point.key) {
        // Element-anchored point: offset is a child index; we have to count
        // characters up to that child.
        if (point.type === 'element') {
          const children = para.getType() === 'paragraph' && 'getChildren' in para
            ? (para as unknown as { getChildren(): Array<{ getTextContent(): string }> }).getChildren()
            : [];
          for (let j = 0; j < point.offset && j < children.length; j++) {
            totalOffset += children[j].getTextContent().length;
          }
        }
        // (no text-anchored case here — element key matches mean it is a block edge)
        found = true;
        return;
      }
      // Walk this paragraph's text children, looking for a text-anchored hit.
      const children = 'getChildren' in para
        ? (para as unknown as { getChildren(): Array<{ getKey(): string; getTextContent(): string }> }).getChildren()
        : [];
      let textWalked = 0;
      for (const child of children) {
        if (child.getKey() === point.key) {
          totalOffset += textWalked + point.offset;
          found = true;
          return;
        }
        textWalked += child.getTextContent().length;
      }
      // Move past this paragraph.
      totalOffset += para.getTextContent().length;
      // Paragraph separator (single `\n` between consecutive paragraphs).
      if (i < paragraphs.length - 1) totalOffset += 1;
    }
  });

  return found ? totalOffset : -1;
}

export function SelectionTrackerPlugin({ onTextSelect, onSelectionClear }: SelectionTrackerPluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          onSelectionClear?.();
          return false;
        }

        // Browser selection gives us the bounding rect; lexical gives us the
        // anchor/focus nodes for offset math.
        const native = typeof window !== 'undefined' ? window.getSelection() : null;
        const text = selection.getTextContent();
        if (!text.trim() || !native || native.rangeCount === 0) {
          onSelectionClear?.();
          return false;
        }
        const domRange = native.getRangeAt(0);
        const rect = domRange.getBoundingClientRect();

        const anchorOffset = offsetFromSelectionPoint(editor, {
          key: selection.anchor.key,
          offset: selection.anchor.offset,
          type: selection.anchor.type,
        });
        const focusOffset = offsetFromSelectionPoint(editor, {
          key: selection.focus.key,
          offset: selection.focus.offset,
          type: selection.focus.type,
        });
        if (anchorOffset < 0 || focusOffset < 0) return false;

        const start = Math.min(anchorOffset, focusOffset);
        const end = Math.max(anchorOffset, focusOffset);
        onTextSelect?.(text, rect, { start, end });
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, onTextSelect, onSelectionClear]);

  return null;
}
