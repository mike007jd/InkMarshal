'use client';

import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  $createRangeSelection,
  $setSelection,
  type LexicalEditor,
} from 'lexical';

/**
 * Replace the entire editor content with `text`, splitting on `\n` into
 * ParagraphNodes. The update IS recorded in history so the user can `Cmd+Z`
 * back to the prior state (which is what we want when AI Continue / Rewrite
 * / Accept-diff mutates the document).
 */
export function replaceEditorText(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const lines = (text ?? '').split('\n');
    for (const line of lines) {
      const para = $createParagraphNode();
      if (line.length > 0) para.append($createTextNode(line));
      root.append(para);
    }
  });
}

/**
 * Read the editor's current plain-text content using the single-`\n`
 * paragraph-separator convention (matches `content.split('\n')` elsewhere).
 */
export function readEditorPlainText(editor: LexicalEditor): string {
  let out = '';
  editor.getEditorState().read(() => {
    const root = $getRoot();
    out = root.getChildren().map(p => p.getTextContent()).join('\n');
  });
  return out;
}

/**
 * Move the editor caret to `offset` (plain-text, single-`\n`-joined-paragraph
 * convention) inside a recorded `editor.update`. Walks paragraphs → text
 * children to resolve the offset; clamps to end-of-document when the offset is
 * past the end. Used by the manuscript search "jump to match" handle.
 */
export function placeSelectionAtOffset(editor: LexicalEditor, offset: number): void {
  editor.update(() => {
    const root = $getRoot();
    const paragraphs = root.getChildren();
    let walked = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      const textLength = para.getTextContent().length;
      // Paragraph i covers chars [walked, walked + textLength]; the
      // separator newline lives at walked + textLength (between paras).
      if (offset <= walked + textLength) {
        const localOffset = Math.max(0, offset - walked);
        // Find the text child + local offset
        const children = 'getChildren' in para
          ? (para as unknown as { getChildren(): Array<{ getKey(): string; getTextContent(): string; getType(): string }> }).getChildren()
          : [];
        let cumulative = 0;
        let placed = false;
        for (const child of children) {
          const len = child.getTextContent().length;
          if (localOffset <= cumulative + len && child.getType() === 'text') {
            const selection = $createRangeSelection();
            const key = child.getKey();
            const inChild = localOffset - cumulative;
            selection.anchor.set(key, inChild, 'text');
            selection.focus.set(key, inChild, 'text');
            $setSelection(selection);
            placed = true;
            break;
          }
          cumulative += len;
        }
        if (!placed) {
          // Empty paragraph (no text children) — anchor at element start
          const selection = $createRangeSelection();
          selection.anchor.set(para.getKey(), 0, 'element');
          selection.focus.set(para.getKey(), 0, 'element');
          $setSelection(selection);
        }
        return;
      }
      walked += textLength + 1; // paragraph separator
    }
    // Offset past document end — collapse at end of last paragraph.
    const last = paragraphs[paragraphs.length - 1];
    if (last) {
      const selection = $createRangeSelection();
      const text = last.getTextContent();
      const lastChildren = 'getChildren' in last
        ? (last as unknown as { getChildren(): Array<{ getKey(): string; getType(): string; getTextContent(): string }> }).getChildren()
        : [];
      const lastTextChild = [...lastChildren].reverse().find(c => c.getType() === 'text');
      if (lastTextChild) {
        selection.anchor.set(lastTextChild.getKey(), lastTextChild.getTextContent().length, 'text');
        selection.focus.set(lastTextChild.getKey(), lastTextChild.getTextContent().length, 'text');
      } else {
        selection.anchor.set(last.getKey(), text.length, 'element');
        selection.focus.set(last.getKey(), text.length, 'element');
      }
      $setSelection(selection);
    }
  });
}
