'use client';

import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useLanguage } from '@/components/LanguageProvider';
// Wave 3 commit 4 — the inline "polishing on …" strip is replaced by the
// ManuscriptShell's dot badge in the desktop shell. The Editing view used to
// render `<WritingModelStatusBar operation="polish" />` at the top, but the
// dot badge sits above all manuscript surfaces and already covers polish; no
// import needed here any more.
import { ChapterLexicalEditor } from './editor/ChapterLexicalEditor';
import { placeSelectionAtOffset } from './editor/lexical-helpers';
import { EditChatbox } from './EditChatbox';
import { DiffConfirmCard } from './DiffConfirmCard';
import { SelectionToolbar } from './SelectionToolbar';
import { ChatHistory } from './ChatHistory';
import { RevertChapterButton } from './RevertChapterButton';
import { SnapshotHistoryDrawer } from './SnapshotHistoryDrawer';
import { useStorageMode } from '@/lib/use-storage';
import { useNovelCreativity } from '@/hooks/useNovelCreativity';
import { useNovelStyle } from '@/hooks/useNovelStyle';
import { useChapterDraftController } from '@/hooks/useChapterDraftController';
import { useEditorSelection } from '@/hooks/useEditorSelection';
import { useDiffConfirmation } from '@/hooks/useDiffConfirmation';
import { useManuscriptGeneration } from '@/hooks/useManuscriptGeneration';
import { useAIEditChat } from '@/hooks/useAIEditChat';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import type { ManuscriptChapter } from './ManuscriptShell';
import type { SaveState } from './SaveStatusIndicator';
import type { LexicalEditor } from 'lexical';

interface ManuscriptEditingViewProps {
  novelId: string;
  chapter: ManuscriptChapter | null;
  onChaptersChange?: () => void;
  /** Initial value for the creativity picker, persisted to novel.settings. */
  initialCreativity?: CreativityLevel | null;
  /** Surface the auto-save state to the shell (which renders the indicator).
   *  Called whenever the state machine transitions. */
  onSaveStatusChange?: (state: SaveState, lastSavedAt: number | null) => void;
  /** Whether the chapter's pre-AI baseline is available. When true the
   *  editing toolbar renders the "Revert to first draft" button. */
  hasOriginal?: boolean;
  /** Surface unsaved editor text to sibling flows such as search/export. */
  onDraftContentChange?: (chapterNumber: number, content: string, dirty: boolean, version?: number) => void;
  /** Dirty text preserved by the shell when a failed save survived a chapter switch. */
  draftContent?: string;
}

export interface ManuscriptEditingViewHandle {
  /** Move the editor caret to `offset` (plain-text, `\n`-joined-paragraph
   *  convention) and scroll the position into view. Safe to call when no
   *  chapter is active — silently no-ops. */
  jumpToOffset(offset: number): void;
}

export const ManuscriptEditingView = forwardRef<ManuscriptEditingViewHandle, ManuscriptEditingViewProps>(function ManuscriptEditingView(
  { novelId, chapter, onChaptersChange, initialCreativity = null, onSaveStatusChange, hasOriginal = false, onDraftContentChange, draftContent },
  ref,
) {
  const { t } = useLanguage();
  const { storageReady } = useStorageMode();
  const { creativity, setCreativity, syncFailed: creativitySyncFailed } = useNovelCreativity(novelId, initialCreativity);
  const { styleId, setStyleId } = useNovelStyle(novelId);

  // The shared Lexical editor handle. Owned here (set via onEditorReady) and
  // threaded into every hook that reads/writes the live editor text.
  const editorRef = useRef<LexicalEditor | null>(null);
  // Chatbox input ref — view-level DOM handle the toolbar's "AI edit" focuses.
  const chatboxRef = useRef<HTMLInputElement>(null);
  // "A generation is in flight" — shared across the toolbar continue/rewrite
  // flow and the freeform edit-chat, read by the toolbar + chatbox.
  const [isLoading, setIsLoading] = useState(false);
  const [editStreaming, setEditStreaming] = useState(false);

  // Persistence + scope identity + editor-sync seed.
  const draft = useChapterDraftController({
    novelId,
    chapter,
    draftContent,
    storageReady,
    editorRef,
    onChaptersChange,
    onDraftContentChange,
    onSaveStatusChange,
  });
  // In-editor selection + floating toolbar anchor.
  const selection = useEditorSelection({ chatboxRef });
  // Diff accept/reject lifecycle (fed by both generation and edit-chat).
  const diff = useDiffConfirmation({
    novelId,
    chapter,
    editorRef,
    applyTextThroughEditor: draft.applyTextThroughEditor,
    handleClearSelection: selection.handleClearSelection,
  });
  // Toolbar continue/rewrite — single-shot or multi-variant.
  const generation = useManuscriptGeneration({
    chapter,
    novelId,
    storageReady,
    creativity,
    styleId,
    selectedText: selection.selectedText,
    highlightRange: selection.highlightRange,
    isLoading,
    setIsLoading,
    setToolbarPos: selection.setToolbarPos,
    isCurrentEditingScope: draft.isCurrentEditingScope,
    pushGeneratedTextAsChange: diff.pushGeneratedTextAsChange,
  });
  // Freeform edit-chat (NDJSON change stream → diff cards).
  const aiChat = useAIEditChat({
    chapter,
    novelId,
    storageReady,
    creativity,
    styleId,
    selectedText: selection.selectedText,
    isCurrentEditingScope: draft.isCurrentEditingScope,
    changesRef: diff.changesRef,
    setChanges: diff.setChanges,
    handleClearSelection: selection.handleClearSelection,
    setIsLoading,
    setEditStreaming,
    getCurrentEditorContent: draft.getCurrentEditorContent,
  });

  // Reset all per-chapter state on chapter SWITCH only. Re-running on every
  // content change (e.g. after autosave reloads the chapter prop) would nuke
  // the user's selection + pending diff cards every save cycle. Flush the
  // outgoing chapter first, re-check cancellation, then repoint scope and
  // reset every AI-assist surface.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await draft.maybeFlushOnChapterSwitch(novelId, chapter);
      if (cancelled) return;
      draft.applyChapterSwitch(novelId, chapter, draftContent);
      generation.resetForChapterSwitch();
      aiChat.resetForChapterSwitch();
      diff.reset();
      selection.reset();
      setIsLoading(false);
      setEditStreaming(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: only re-run on novel/chapter identity switch, not on content / version refresh after autosave
  }, [novelId, chapter?.id, chapter?.chapterNumber]);

  // Expose imperative jump handle for the global search dialog. The Lexical
  // offset→selection tree-walk lives in lexical-helpers; here we delegate then
  // scroll the placed selection into view.
  useImperativeHandle(ref, () => ({
    jumpToOffset(offset: number) {
      const editor = editorRef.current;
      if (!editor) return;
      placeSelectionAtOffset(editor, offset);
      // Scroll the focused selection into view. Lexical renders selection
      // synchronously after `editor.update`; we read the DOM selection on the
      // next frame so the browser has time to apply it.
      requestAnimationFrame(() => {
        const sel = typeof window !== 'undefined' ? window.getSelection() : null;
        if (!sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        const el = node instanceof Element ? node : node.parentElement;
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    },
  }), []);

  if (!chapter) {
    return (
      <div className="flex-1 flex items-center justify-center text-book-ink-secondary text-sm">
        {t.selectChapterToEdit || 'Select a chapter to edit'}
      </div>
    );
  }

  const pendingChanges = diff.changes.filter(c => c.status === 'pending');

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Revision history is always available; low-frequency generation
          tuning lives beside the AI instruction where it is used. */}
      <div className="flex items-center gap-2 border-b border-book-border bg-book-bg-card/40 px-3 py-1">
        <div className="flex items-center gap-2">
          <RevertChapterButton
            novelId={novelId}
            chapterNumber={chapter.chapterNumber}
            chapterVersion={chapter.version ?? 0}
            hasOriginal={hasOriginal}
            onBeforeAction={() => draft.flushSaveRef.current()}
            getCurrentContent={draft.getCurrentEditorContent}
            onReverted={onChaptersChange}
          />
          <SnapshotHistoryDrawer
            novelId={novelId}
            chapterNumber={chapter.chapterNumber}
            chapterVersion={chapter.version ?? 0}
            onBeforeAction={() => draft.flushSaveRef.current()}
            onRestored={onChaptersChange}
          />
        </div>
      </div>
      <ChapterLexicalEditor
        key={draft.editorSync.scopeKey}
        initialContent={draft.editorSync.content}
        chapterTitle={chapter.title}
        chapterNumber={chapter.chapterNumber}
        syncVersion={draft.editorSync.version}
        onTextSelect={selection.handleTextSelect}
        onSelectionClear={selection.handleSelectionClear}
        onContentChange={draft.handleContentChange}
        onEditorReady={editor => { editorRef.current = editor; }}
      />

      {selection.toolbarPos && selection.selectedText && (
        <SelectionToolbar
          position={selection.toolbarPos}
          onAIEdit={selection.handleAIEditFromToolbar}
          onCopy={selection.handleCopy}
          onContinue={generation.handleContinue}
          onRewrite={generation.handleRewrite}
          isLoading={isLoading}
        />
      )}

      <ChatHistory messages={aiChat.chatMessages} />

      {pendingChanges.length > 0 && (
        <div className="px-3 py-2 border-t border-book-border">
          <DiffConfirmCard
            changes={diff.changes}
            onAccept={diff.handleAccept}
            onReject={diff.handleReject}
            onAcceptAll={diff.handleAcceptAll}
            onRejectAll={diff.handleRejectAll}
          />
        </div>
      )}

      <EditChatbox
        ref={chatboxRef}
        onSend={aiChat.handleSend}
        isLoading={isLoading}
        isStreaming={editStreaming}
        onStop={aiChat.handleStopEdit}
        selectedText={selection.selectedText}
        onClearSelection={selection.handleClearSelection}
        creativity={creativity}
        onCreativityChange={setCreativity}
        creativitySyncFailed={creativitySyncFailed}
        novelId={novelId}
        styleId={styleId}
        onStyleChange={setStyleId}
      />
    </div>
  );
});
