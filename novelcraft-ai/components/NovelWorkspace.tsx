'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatStatus } from 'ai';

import { createConversation } from '@/app/actions/conversations';
import { useLanguage } from '@/components/LanguageProvider';
import { AgentWorkspacePane } from '@/components/novel-workspace/AgentWorkspacePane';
import { ManuscriptWorkspacePane } from '@/components/novel-workspace/ManuscriptWorkspacePane';
import { StoryDeckWorkspacePane } from '@/components/novel-workspace/StoryDeckWorkspacePane';
import { useNovelBundleExport } from '@/components/novel-workspace/useNovelBundleExport';
import { useNovelWorkspaceNavigation } from '@/components/novel-workspace/useNovelWorkspaceNavigation';
import { useStoryDeckCoverage } from '@/components/novel-workspace/useStoryDeckCoverage';
import { NovelTopBar } from '@/components/NovelTopBar';
import { StageBar } from '@/components/StageBar';
import { useToast } from '@/components/Toast';
import type { KnowledgeFilterTab } from '@/lib/knowledge-workspace';
import {
  isPostInterviewStage,
  type NovelView,
} from '@/lib/novel-workspace-view';
import {
  STAGES_THAT_SHOW_UNIFICATION_PANEL,
  isInStages,
} from '@/lib/novel-stages';
import { useManuscriptSession } from '@/lib/use-manuscript-session';
import { useNovel } from '@/lib/use-storage';

interface NovelWorkspaceProps {
  novelId: string;
  initialView?: NovelView;
}

/**
 * Coordinates the three workspace modes. Mode-local interaction and async
 * ownership live in the pane hooks/components so this boundary only composes
 * novel, Story Deck, assistant, and manuscript state.
 */
export function NovelWorkspace({
  novelId,
  initialView = 'agent',
}: NovelWorkspaceProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { novel, refresh: refreshNovel, update: updateNovel } = useNovel(novelId);
  const {
    view,
    selectView,
    chapterFromUrl,
    startInEditing,
    searchOffsetFromUrl,
    autostart,
  } = useNovelWorkspaceNavigation(novelId, initialView);
  const {
    counts: deckCounts,
    complete: deckComplete,
    loading: deckLoading,
    panelRefreshToken,
    refreshCoverage,
    refreshAll: refreshDeck,
  } = useStoryDeckCoverage(novelId);
  const manuscript = useManuscriptSession({ novelId, autostart });
  const liveNovel = manuscript.novel ?? novel;
  const downloadBundle = useNovelBundleExport(novelId, liveNovel?.title);

  const [storyDeckTab, setStoryDeckTab] =
    useState<KnowledgeFilterTab>('character');
  const [assistantStatus, setAssistantStatus] =
    useState<ChatStatus>('ready');
  const [proposalAdjustRequest, setProposalAdjustRequest] = useState(0);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleSavingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setActiveConvId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [novelId]);

  const handleCreateConversation = useCallback(async (
    topic: string,
    title: string,
  ) => {
    try {
      const result = await createConversation(novelId, {
        topic,
        title,
        parentMessageId: null,
      });
      setActiveConvId(result.id);
    } catch (error) {
      console.error('Failed to create conversation:', error);
      toast(error instanceof Error ? error.message : t.errorSubmitFailed, 'error');
      throw error;
    }
  }, [novelId, t.errorSubmitFailed, toast]);

  const patchNovelLocal = manuscript.patchNovelLocal;

  const handleTitleSave = async () => {
    if (titleSavingRef.current) return;
    titleSavingRef.current = true;
    const trimmed = titleDraft.trim();
    try {
      if (trimmed && trimmed !== novel?.title) {
        const updated = await updateNovel({ title: trimmed });
        if (!updated) {
          toast(t.errorUpdateNovel, 'error', {
            action: {
              label: t.toastRetry,
              onClick: () => {
                void handleTitleSave();
              },
            },
          });
          return;
        }
        // liveNovel prefers the manuscript session copy; converge it immediately
        // so Enter/blur cannot flash the stale pre-PATCH title.
        patchNovelLocal({
          title: updated.title,
          genre: updated.genre,
          targetWords: updated.targetWords,
          updatedAt: updated.updatedAt,
        });
      }
      setEditingTitle(false);
    } finally {
      titleSavingRef.current = false;
    }
  };

  const fetchManuscriptNovel = manuscript.fetchNovel;
  const fetchManuscriptChapters = manuscript.fetchChapters;
  const startManuscriptWriting = manuscript.startWriting;

  const handleAgentTurnComplete = useCallback(() => {
    refreshDeck();
    void Promise.allSettled([
      refreshNovel(),
      fetchManuscriptNovel(),
    ]);
  }, [fetchManuscriptNovel, refreshDeck, refreshNovel]);

  useEffect(() => {
    const refreshOnFocus = () => {
      refreshDeck();
      void Promise.allSettled([
        refreshNovel(),
        fetchManuscriptNovel(),
        fetchManuscriptChapters(),
      ]);
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [
    fetchManuscriptChapters,
    fetchManuscriptNovel,
    refreshDeck,
    refreshNovel,
  ]);

  const handleStartWriting = useCallback(() => {
    selectView('read-edit');
    void startManuscriptWriting();
  }, [selectView, startManuscriptWriting]);

  const handleCompleteStoryDeck = useCallback(() => {
    setProposalAdjustRequest(current => current + 1);
    selectView('agent');
  }, [selectView]);

  const showUnification = !!liveNovel
    && isInStages(liveNovel.stage, STAGES_THAT_SHOW_UNIFICATION_PANEL);

  return (
    <div className="flex h-full min-h-0 flex-col book-texture-parchment">
      <NovelTopBar
        novel={liveNovel ? {
          title: liveNovel.title,
          genre: liveNovel.genre,
          stage: liveNovel.stage,
        } : null}
        editingTitle={editingTitle}
        titleDraft={titleDraft}
        setTitleDraft={setTitleDraft}
        setEditingTitle={setEditingTitle}
        handleTitleSave={handleTitleSave}
        view={view}
        setView={selectView}
        assistantActive={
          assistantStatus === 'submitted' || assistantStatus === 'streaming'
        }
        manuscriptActive={manuscript.isStreaming}
      />

      <StageBar
        stage={liveNovel?.stage}
        progress={liveNovel?.progress ?? 0}
        onApprove={handleStartWriting}
        storyDeckComplete={deckComplete}
        onCompleteDeck={handleCompleteStoryDeck}
        onReviewDeck={() => selectView('story-deck')}
        onDownloadBundle={downloadBundle}
        isStreaming={manuscript.isStreaming}
        approveDisabled={deckLoading}
        labels={{
          stepStoryReady: t.stageStoryReady,
          stepApproval: t.stageApproval,
          reviewDeck: t.storyDeckReviewAction,
        }}
        className="z-[9] shrink-0 border-x-0 border-t-0 shadow-none"
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
            className={view === 'agent' ? 'flex min-h-0 flex-1' : 'hidden'}
            aria-hidden={view !== 'agent'}
          >
            <AgentWorkspacePane
              key={novelId}
              novelId={novelId}
              novel={liveNovel}
              deckCounts={deckCounts}
              deckLoading={deckLoading}
              conversationThreadsUnlocked={isPostInterviewStage(liveNovel?.stage)}
              activeConvId={activeConvId}
              setActiveConvId={setActiveConvId}
              onCreateConversation={handleCreateConversation}
              onUpdate={handleAgentTurnComplete}
              onStatusChange={setAssistantStatus}
              chatStatus={assistantStatus}
              onStartWriting={handleStartWriting}
              onReviewDeck={() => selectView('story-deck')}
              onCompleteDeck={handleCompleteStoryDeck}
              proposalAdjustRequest={proposalAdjustRequest}
              initialCreativity={liveNovel?.settings?.creativity ?? null}
            />
          </div>

          {view === 'story-deck' && (
            <StoryDeckWorkspacePane
              novelId={novelId}
              tab={storyDeckTab}
              onTabChange={setStoryDeckTab}
              refreshToken={panelRefreshToken}
              coverageCounts={deckCounts}
              onReturnToAssistant={handleCompleteStoryDeck}
              onEntriesMutated={refreshCoverage}
            />
          )}

          {view === 'read-edit' && (
            <ManuscriptWorkspacePane
              novelId={novelId}
              manuscript={manuscript}
              showUnification={showUnification}
              onJumpToOutline={() => {
                setStoryDeckTab('outline');
                selectView('story-deck');
              }}
              requestedChapter={chapterFromUrl}
              startInEditing={startInEditing}
              requestedOffset={searchOffsetFromUrl}
            />
          )}
        </div>
      </div>
    </div>
  );
}
