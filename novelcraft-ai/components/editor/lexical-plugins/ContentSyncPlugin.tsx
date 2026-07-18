'use client';

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical';

interface ContentSyncPluginProps {
  /**
   * Initial plain-text content (with `\n`-separated paragraphs). Whenever this
   * value changes (e.g. user switched to a different chapter, AI Continue
   * appended text outside the editor), the editor state is replaced.
   *
   * Pass an empty string to clear the editor.
   */
  content: string;
  /**
   * Bumped by the parent whenever it wants to force a re-sync even if
   * `content` is identical (e.g. discard-changes flow).
   */
  syncVersion?: number;
}

/**
 * Bridge plain-text → Lexical paragraph nodes when the parent provides a new
 * authoritative content string. Importantly this runs only when the *input*
 * `content` changes — typing inside the editor does NOT loop back here
 * because the parent reads via `OnChangePlugin`, not by re-passing the result.
 */
export function ContentSyncPlugin({ content, syncVersion = 0 }: ContentSyncPluginProps) {
  const [editor] = useLexicalComposerContext();
  const lastSyncRef = useRef<string | null>(null);
  const lastVersionRef = useRef<number>(-1);

  useEffect(() => {
    if (lastSyncRef.current === content && lastVersionRef.current === syncVersion) return;
    lastSyncRef.current = content;
    lastVersionRef.current = syncVersion;

    // History intentionally skipped — initial loads / external swaps shouldn't
    // create an undo step (`Cmd+Z` past load == no-op).
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const lines = (content ?? '').split('\n');
        for (const line of lines) {
          const para = $createParagraphNode();
          if (line.length > 0) para.append($createTextNode(line));
          root.append(para);
        }
      },
      { tag: 'history-merge' },
    );
  }, [content, editor, syncVersion]);

  return null;
}
