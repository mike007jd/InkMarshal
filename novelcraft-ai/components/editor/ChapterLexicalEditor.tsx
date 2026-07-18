'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { type LexicalEditor } from 'lexical';

import { useLanguage } from '@/components/LanguageProvider';
import { SelectionTrackerPlugin } from './lexical-plugins/SelectionTrackerPlugin';
import { ContentSyncPlugin } from './lexical-plugins/ContentSyncPlugin';
import { PlainTextEmitterPlugin } from './lexical-plugins/PlainTextEmitterPlugin';
import type { HighlightRange } from '@/components/editor/types';

export interface ChapterLexicalEditorProps {
  initialContent: string;
  chapterTitle: string;
  chapterNumber: number;
  /** Bump this when the parent wants to overwrite editor content even if
   *  `initialContent` is identical (e.g. after a discard / chapter reload). */
  syncVersion?: number;
  onTextSelect?: (text: string, rect: DOMRect, range: HighlightRange) => void;
  onSelectionClear?: () => void;
  /** Fires (debounced upstream) whenever the user types/pastes/deletes. */
  onContentChange?: (content: string) => void;
  /** Captures the LexicalEditor instance so the parent can drive
   *  `editor.update(...)` for AI-applied changes (so they go through
   *  history + can be undone with Cmd+Z). */
  onEditorReady?: (editor: LexicalEditor) => void;
  readOnly?: boolean;
}

const EDITOR_THEME = {
  paragraph: 'manuscript-paragraph',
  // The composer is configured with `nodes: []`, so only PlainText paragraphs
  // exist — no TextFormatNode means no bold/italic/underline runs to style.
  // Theme entries for those formats would be dead code.
};

export function ChapterLexicalEditor({
  initialContent,
  chapterTitle,
  chapterNumber,
  syncVersion = 0,
  onTextSelect,
  onSelectionClear,
  onContentChange,
  onEditorReady,
  readOnly = false,
}: ChapterLexicalEditorProps) {
  const { t } = useLanguage();
  const [, setEditorMounted] = useState(0);
  // Per-mount instance to avoid leaking state across novel/chapter pages.
  const initialConfig = useMemo(
    () => ({
      namespace: `chapter-${chapterNumber}`,
      theme: EDITOR_THEME,
      editable: !readOnly,
      onError: (error: Error) => {
        // Editor errors are recoverable — surface in console but don't crash
        // the manuscript shell.
        console.error('[ChapterLexicalEditor]', error);
      },
      // Plain paragraphs only — no rich text node registrations.
      nodes: [],
    }),
    // We deliberately bind `chapterNumber` so switching chapters remounts the
    // composer, which resets the undo stack as spec'd. `readOnly` flips between
    // editing and writing-live modes — also a hard remount.
    [chapterNumber, readOnly],
  );

  const handleEditorRef = useCallback(
    (editor: LexicalEditor) => {
      onEditorReady?.(editor);
      setEditorMounted(v => v + 1);
    },
    [onEditorReady],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <ChapterEditorBody
        chapterNumber={chapterNumber}
        chapterTitle={chapterTitle}
        initialContent={initialContent}
        syncVersion={syncVersion}
        onTextSelect={onTextSelect}
        onSelectionClear={onSelectionClear}
        onContentChange={onContentChange}
        handleEditorRef={handleEditorRef}
        readOnly={readOnly}
        manuscriptChapterLabel={t.manuscriptChapter}
      />
    </LexicalComposer>
  );
}

interface BodyProps {
  chapterNumber: number;
  chapterTitle: string;
  initialContent: string;
  syncVersion: number;
  onTextSelect?: (text: string, rect: DOMRect, range: HighlightRange) => void;
  onSelectionClear?: () => void;
  onContentChange?: (content: string) => void;
  handleEditorRef: (editor: LexicalEditor) => void;
  readOnly: boolean;
  manuscriptChapterLabel: string;
}

function ChapterEditorBody({
  chapterNumber,
  chapterTitle,
  initialContent,
  syncVersion,
  onTextSelect,
  onSelectionClear,
  onContentChange,
  handleEditorRef,
  readOnly,
  manuscriptChapterLabel,
}: BodyProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll to top when chapter changes so the user lands on the title.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [chapterNumber]);

  return (
    <div
      ref={scrollRef}
      className="manuscript-prose flex-1 overflow-y-auto px-8 py-6 font-serif text-book-ink-secondary"
    >
      {/* Cap the editable measure (max-w-2xl, centered) to match the reading
          view. Without it, long-form editing — the core task — ran edge-to-edge
          on wide desktops, far past a comfortable reading width. */}
      <div className="mx-auto w-full max-w-2xl">
      <div className="mb-6 border-b border-book-border pb-4">
        <div className="text-xs-tight font-semibold uppercase tracking-display text-book-gold">
          {manuscriptChapterLabel.replace('{num}', String(chapterNumber).padStart(2, '0'))}
        </div>
        <h3 className="mt-3 font-serif text-chapter-title text-book-ink-primary">
          {chapterTitle}
        </h3>
      </div>

      <div className="relative">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="manuscript-prose outline-none whitespace-pre-wrap font-serif text-book-ink-secondary [&_p:empty]:h-[1em]"
              aria-label={`Chapter ${chapterNumber} editor`}
              spellCheck
              data-testid="chapter-lexical-editable"
              data-readonly={readOnly ? 'true' : 'false'}
            />
          }
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ContentSyncPlugin content={initialContent} syncVersion={syncVersion} />
        <PlainTextEmitterPlugin
          onContentChange={onContentChange}
          editorRef={handleEditorRef}
        />
        {!readOnly && (
          <SelectionTrackerPlugin
            onTextSelect={onTextSelect}
            onSelectionClear={onSelectionClear}
          />
        )}
      </div>
      </div>
    </div>
  );
}
