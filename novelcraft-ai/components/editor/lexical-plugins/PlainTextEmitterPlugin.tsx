'use client';

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, type LexicalEditor } from 'lexical';

interface PlainTextEmitterPluginProps {
  /** Called whenever editor content changes due to user input. */
  onContentChange?: (content: string) => void;
  editorRef?: (editor: LexicalEditor) => void;
}

/**
 * Serialise the editor root to plain text using single-`\n` paragraph
 * separators (matches the rest of the app's `content.split('\n')` convention).
 * Lexical's built-in `$getRoot().getTextContent()` joins with `\n\n`, which
 * would silently double every paragraph break on save.
 */
export function PlainTextEmitterPlugin({ onContentChange, editorRef }: PlainTextEmitterPluginProps) {
  const [editor] = useLexicalComposerContext();
  const lastEmittedRef = useRef<string | null>(null);

  useEffect(() => {
    editorRef?.(editor);
  }, [editor, editorRef]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
      // Ignore history-merge updates (initial load / external content swap):
      // we don't want to mark dirty / trigger autosave for those.
      if (tags.has('history-merge') || tags.has('historic')) return;
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

      editorState.read(() => {
        const root = $getRoot();
        const text = root.getChildren()
          .map(p => p.getTextContent())
          .join('\n');
        if (text === lastEmittedRef.current) return;
        lastEmittedRef.current = text;
        onContentChange?.(text);
      });
    });
  }, [editor, onContentChange]);

  return null;
}
