'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ChatStatus } from 'ai';
// useRouter is intentionally not imported. Mode switches update the current
// history entry in place, while sidebar links own novel-to-novel navigation.
import {
  ArrowLeft,
  Check,
  ChevronDown,
  FileText,
  Globe,
  ListChecks,
  MessageSquare,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChatArea } from '@/components/ChatArea';
import { ConversationList } from '@/components/conversations/ConversationList';
import { ConversationThread } from '@/components/conversations/ConversationThread';
import { KnowledgePanel } from '@/components/knowledge/KnowledgePanel';
import { ManuscriptShell } from '@/components/ManuscriptShell';
import { NovelTopBar } from '@/components/NovelTopBar';
import { StageBar } from '@/components/StageBar';
import { ProposalReviewPanel } from '@/components/ProposalReviewPanel';
import { useCapabilityBinding } from '@/components/WritingModelStatusBar';
import {
  buildNovelViewHref,
  parseViewParam,
  type NovelView,
} from '@/lib/novel-workspace-view';
import {
  rememberNovelWorkspaceView,
  rememberNovelWorkspaceViewAfterHydration,
} from '@/lib/novel-workspace-preferences';
import { UnificationPanel } from '@/components/UnificationPanel';
import type { Novel, UnificationReport } from '@/lib/db-types';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { createConversation } from '@/app/actions/conversations';
import { parseDownloadFilename, saveBlob } from '@/lib/download';
import {
  STAGES_THAT_SHOW_UNIFICATION_PANEL,
  STAGES_THAT_CAN_START_WRITING,
  isInStages,
} from '@/lib/novel-stages';
import { useNovel } from '@/lib/use-storage';
import { useManuscriptSession } from '@/lib/use-manuscript-session';
import { resolveManuscriptShellMode } from '@/lib/manuscript-mode';
import { requestManuscriptFlush } from '@/lib/desktop-shell-bus';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import type { KnowledgeFilterTab } from '@/lib/knowledge-workspace';

interface NovelWorkspaceProps {
  novelId: string;
  initialView?: NovelView;
}

const PRE_WRITING_STAGES = new Set<Novel['stage']>([
  'discovery_interview',
  'ready_for_greenlight',
]);

type RequiredDeckType = 'character' | 'world' | 'outline';
type DeckCounts = Record<RequiredDeckType, number>;

const EMPTY_DECK_COUNTS: DeckCounts = { character: 0, world: 0, outline: 0 };

function hasUnlockedConversationThreads(stage: Novel['stage'] | null | undefined): boolean {
  return Boolean(stage && !PRE_WRITING_STAGES.has(stage));
}

/**
 * NovelWorkspace — the per-novel main pane (W3-1).
 *
 * Owns the three-mode IA. The shell sidebar (sibling) handles novel switching,
 * which is why this component must NOT re-fetch on mount unless `novelId`
 * actually changed — switching books should feel like a tab swap, not a
 * full page load.
 *
 * Internally, manuscript-tab logic is hosted via the {@link useManuscriptSession}
 * hook so the legacy `/novel/[id]/manuscript` redirect still gets the full
 * writing + resume + batch-done lifecycle without dragging that body into
 * another route.
 */
export function NovelWorkspace({ novelId, initialView = 'agent' }: NovelWorkspaceProps) {
  const searchParams = useSearchParams();
  const { t } = useLanguage();
  const { toast } = useToast();

  const { novel, refresh: refreshNovel, update: updateNovel } = useNovel(novelId);
  const activeNovelIdRef = useRef(novelId);
  const bundleAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    activeNovelIdRef.current = novelId;
    bundleAbortRef.current?.abort();
    bundleAbortRef.current = null;
  }, [novelId]);

  // Initial view: query string wins (deep links / redirects from the legacy
  // manuscript route), then the explicit prop.
  const viewFromUrl = useMemo(
    () => parseViewParam(searchParams?.get('view') ?? null),
    [searchParams],
  );
  const chapterFromUrl = useMemo(() => {
    const raw = searchParams?.get('chapter');
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [searchParams]);
  const startInEditing = searchParams?.get('edit') === '1';
  const searchOffsetFromUrl = useMemo(() => {
    const raw = searchParams?.get('offset');
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }, [searchParams]);
  const [view, setView] = useState<NovelView>(() => {
    return viewFromUrl ?? initialView;
  });
  const [storyDeckTab, setStoryDeckTab] = useState<KnowledgeFilterTab>('character');
  const [assistantStatus, setAssistantStatus] = useState<ChatStatus>('ready');
  const [deckRefreshToken, setDeckRefreshToken] = useState(0);
  const [deckCounts, setDeckCounts] = useState<DeckCounts>(EMPTY_DECK_COUNTS);
  const [deckLoading, setDeckLoading] = useState(true);
  const [proposalAdjustRequest, setProposalAdjustRequest] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function loadDeckCounts() {
      setDeckLoading(true);
      try {
        const response = await fetch(`/api/novels/${novelId}/knowledge`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Failed to load Story Deck (HTTP ${response.status})`);
        const entries = await response.json() as Array<{ type?: string }>;
        const next: DeckCounts = { ...EMPTY_DECK_COUNTS };
        for (const entry of entries) {
          if (entry.type === 'character' || entry.type === 'world' || entry.type === 'outline') {
            next[entry.type] += 1;
          }
        }
        setDeckCounts(next);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('Failed to refresh Story Deck coverage:', error);
        }
      } finally {
        if (!controller.signal.aborted) setDeckLoading(false);
      }
    }
    void loadDeckCounts();
    return () => controller.abort();
  }, [deckRefreshToken, novelId]);

  const selectView = useCallback((nextView: NovelView) => {
    setView(nextView);
    rememberNovelWorkspaceView(novelId, nextView);
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const nextHref = buildNovelViewHref(
      window.location.pathname,
      window.location.search,
      nextView,
      window.location.hash,
    );
    if (nextHref !== currentHref) {
      window.history.replaceState(null, '', nextHref);
    }
  }, [novelId]);

  // Persist the resolved entry mode as well as explicit tab clicks. This makes
  // creation routes and deep links establish the next sidebar re-entry mode.
  useEffect(() => {
    return rememberNovelWorkspaceViewAfterHydration(novelId, viewFromUrl ?? initialView);
  }, [initialView, novelId, viewFromUrl]);

  // When the URL ?view= changes (deep link or an external navigation), reflect
  // it in local state. Tab clicks replace the current URL rather than adding a
  // history entry, so the address is durable without making Back noisy.
  useEffect(() => {
    if (!viewFromUrl) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setView(current => (current === viewFromUrl ? current : viewFromUrl));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [viewFromUrl]);

  // Conversations tab
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setActiveConvId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [novelId]);

  const handleCreateConversation = useCallback(async (topic: string, title: string) => {
    try {
      const result = await createConversation(novelId, { topic, title, parentMessageId: null });
      setActiveConvId(result.id);
    } catch (error) {
      console.error('Failed to create conversation:', error);
      toast(error instanceof Error ? error.message : t.errorSubmitFailed, 'error');
      throw error;
    }
  }, [novelId, t.errorSubmitFailed, toast]);

  // Editable title
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleSavingRef = useRef(false);
  const handleTitleSave = async () => {
    if (titleSavingRef.current) return;
    titleSavingRef.current = true;
    const trimmed = titleDraft.trim();
    try {
      if (trimmed && trimmed !== novel?.title) {
        const updated = await updateNovel({ title: trimmed });
        if (!updated) {
          toast(t.errorUpdateNovel, 'error', {
            action: { label: t.toastRetry, onClick: () => { void handleTitleSave(); } },
          });
          return;
        }
      }
      setEditingTitle(false);
    } finally {
      titleSavingRef.current = false;
    }
  };

  // Manuscript session — the writing lifecycle previously hosted by
  // /novel/[id]/manuscript. We honour ?autostart=1 here so the legacy
  // redirect (now → /novel/[id]?view=read-edit&autostart=1) keeps working.
  const autostart = (searchParams?.get('autostart') ?? '') === '1';
  const manuscript = useManuscriptSession({ novelId, autostart });
  const fetchManuscriptNovel = manuscript.fetchNovel;
  const fetchManuscriptChapters = manuscript.fetchChapters;

  const handleAgentTurnComplete = useCallback(() => {
    setDeckRefreshToken(current => current + 1);
    void Promise.allSettled([
      refreshNovel(),
      fetchManuscriptNovel(),
    ]);
  }, [fetchManuscriptNovel, refreshNovel]);

  useEffect(() => {
    const refreshOnFocus = () => {
      setDeckRefreshToken(current => current + 1);
      void Promise.allSettled([
        refreshNovel(),
        fetchManuscriptNovel(),
        fetchManuscriptChapters(),
      ]);
    };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [fetchManuscriptChapters, fetchManuscriptNovel, refreshNovel]);

  const handleStartWriting = useCallback(() => {
    selectView('read-edit');
    void manuscript.startWriting();
  }, [manuscript, selectView]);

  const handleCompleteStoryDeck = useCallback(() => {
    setProposalAdjustRequest(current => current + 1);
    selectView('agent');
  }, [selectView]);

  const handleDownloadBundle = useCallback(async () => {
    const requestNovelId = novelId;
    const controller = new AbortController();
    bundleAbortRef.current?.abort();
    bundleAbortRef.current = controller;
    try {
      const saveOutcome = await requestManuscriptFlush();
      if (!saveOutcome.ok) {
        const where = saveOutcome.chapterNumber
          ? ` (Ch.${saveOutcome.chapterNumber}${saveOutcome.title ? ` — ${saveOutcome.title}` : ''})`
          : '';
        throw new Error(`${t.editorSaveError}${where}`);
      }
      const res = await fetch(`/api/novels/${requestNovelId}/export-bundle`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as {
          code?: string; error?: string; sizeMiB?: number; maxMiB?: number;
        };
        // Map the route's stable code to a localized message so a zh writer who
        // hits ⌘E too early doesn't get a raw English string.
        const localized =
          data.code === 'NO_CHAPTERS' ? t.bundleNoChapters
          : data.code === 'CJK_NOT_SUPPORTED' ? t.bundlePdfFontUnsupported
          : data.code === 'BUNDLE_TOO_LARGE'
            ? t.bundleTooLarge
                .replace('{size}', String(data.sizeMiB ?? '?'))
                .replace('{max}', String(data.maxMiB ?? '?'))
          : (data.error || t.bundleDownloadFailed);
        throw new Error(localized);
      }
      const bundle = await res.blob();
      if (activeNovelIdRef.current !== requestNovelId) return;
      const filename = parseDownloadFilename(
        res.headers.get('content-disposition'),
        `${novel?.title || 'novel'}-bundle.zip`,
      );
      const { notifyExportSaved } = await import('@/lib/export-client');
      const savedPath = await saveBlob(bundle, filename);
      notifyExportSaved(savedPath, toast, t);
      // Feed the north-star "effective advance" signal only on a real save
      // (desktop returns the path; a cancelled dialog returns null).
      if (typeof savedPath === 'string') {
        const { recordExportActivity } = await import('@/app/actions/activity');
        void recordExportActivity(novelId, 'bundle');
      }
    } catch (error) {
      if (controller.signal.aborted || activeNovelIdRef.current !== requestNovelId) return;
      console.error('Bundle download failed:', error);
      toast(error instanceof Error ? error.message : t.bundleDownloadFailed);
    } finally {
      if (bundleAbortRef.current === controller) bundleAbortRef.current = null;
    }
  }, [novelId, novel, t, toast]);

  // Wave 3 commit 4 — wire the File → Export Bundle menu (⌘E) to the per-
  // novel bundle download. NovelWorkspace is the owner of the active novel
  // id so it's the right consumer; the DesktopShell broadcasts the event
  // because it doesn't know which novel is active.
  useEffect(() => {
    const handler = () => { void handleDownloadBundle(); };
    window.addEventListener('inkmarshal:export-bundle', handler);
    return () => window.removeEventListener('inkmarshal:export-bundle', handler);
  }, [handleDownloadBundle]);

  // Bridge the View menu + hotkeys to the active mode. DesktopShell's
  // handleMenuAction calls setNovelView(view) → window `inkmarshal://menu`
  // CustomEvent; NovelWorkspace owns `view` so it is the consumer.
  useEffect(() => {
    const handler = (event: Event) => {
      const next = (event as CustomEvent<{ view?: string }>).detail?.view;
      const parsed = parseViewParam(next);
      if (parsed) selectView(parsed);
    };
    window.addEventListener('inkmarshal://menu', handler);
    return () => window.removeEventListener('inkmarshal://menu', handler);
  }, [selectView]);

  // Source of truth for stage: prefer the manuscript copy when it is hydrated
  // (it absorbs streaming patches), otherwise fall back to the title-edit copy.
  const liveNovel = manuscript.novel ?? novel;
  const conversationThreadsUnlocked = hasUnlockedConversationThreads(liveNovel?.stage);

  // The W4-D unification banner on Read/Edit depends on stage.
  const showUnification = !!liveNovel && isInStages(liveNovel.stage, STAGES_THAT_SHOW_UNIFICATION_PANEL);
  const deckComplete = deckCounts.character > 0 && deckCounts.world > 0 && deckCounts.outline > 0;

  return (
    <div className="flex h-full min-h-0 flex-col book-texture-parchment">
      <NovelTopBar
        novel={liveNovel ? { title: liveNovel.title, genre: liveNovel.genre, stage: liveNovel.stage } : null}
        editingTitle={editingTitle}
        titleDraft={titleDraft}
        setTitleDraft={setTitleDraft}
        setEditingTitle={setEditingTitle}
        handleTitleSave={handleTitleSave}
        view={view}
        setView={selectView}
        assistantActive={assistantStatus === 'submitted' || assistantStatus === 'streaming'}
        manuscriptActive={manuscript.isStreaming}
      />

      <StageBar
        stage={liveNovel?.stage}
        progress={liveNovel?.progress ?? 0}
        onApprove={handleStartWriting}
        storyDeckComplete={deckComplete}
        onCompleteDeck={handleCompleteStoryDeck}
        onReviewDeck={() => selectView('story-deck')}
        onDownloadBundle={handleDownloadBundle}
        isStreaming={manuscript.isStreaming}
        onPauseWriting={manuscript.pauseWriting}
        approveDisabled={deckLoading}
        labels={{
          stepStoryReady: t.stageStoryReady,
          stepApproval: t.stageApproval,
          reviewDeck: t.storyDeckReviewAction,
        }}
        className="z-[9] shrink-0 border-x-0 border-t-0 shadow-none"
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* flex flex-col min-h-0: keep the height chain unbroken down to the
            manuscript reader's `absolute inset-0` scroller. Without a flex
            container here, ManuscriptPaneBody's flex-1 had no parent to stretch
            against and the continuous reader collapsed to zero height at narrow
            widths (blank prose area). */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className={view === 'agent' ? 'flex min-h-0 flex-1' : 'hidden'} aria-hidden={view !== 'agent'}>
            <AgentMode
              key={novelId}
              novelId={novelId}
              novel={liveNovel}
              deckCounts={deckCounts}
              deckLoading={deckLoading}
              conversationThreadsUnlocked={conversationThreadsUnlocked}
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
            <StoryDeckMode
              novelId={novelId}
              tab={storyDeckTab}
              onTabChange={setStoryDeckTab}
              refreshToken={deckRefreshToken}
              coverageCounts={deckCounts}
              onReturnToAssistant={handleCompleteStoryDeck}
            />
          )}

          {view === 'read-edit' && (
            <ManuscriptPaneBody
              novelId={novelId}
              manuscript={manuscript}
              showUnification={showUnification}
              showBlueprintQuickJump={false}
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

function AgentMode({
  novelId,
  novel,
  deckCounts,
  deckLoading,
  conversationThreadsUnlocked,
  activeConvId,
  setActiveConvId,
  onCreateConversation,
  onUpdate,
  onStatusChange,
  chatStatus,
  onStartWriting,
  onReviewDeck,
  onCompleteDeck,
  proposalAdjustRequest,
  initialCreativity,
}: {
  novelId: string;
  novel: Novel | null | undefined;
  deckCounts: DeckCounts;
  deckLoading: boolean;
  conversationThreadsUnlocked: boolean;
  activeConvId: string | null;
  setActiveConvId: (id: string | null) => void;
  onCreateConversation: (topic: string, title: string) => void | Promise<void>;
  onUpdate: () => void;
  onStatusChange: (status: ChatStatus) => void;
  chatStatus: ChatStatus;
  onStartWriting: () => void;
  onReviewDeck: () => void;
  onCompleteDeck: () => void;
  proposalAdjustRequest: number;
  initialCreativity?: CreativityLevel | null;
}) {
  const { t } = useLanguage();
  const showConversationList = conversationThreadsUnlocked;
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);
  const [adjustingProposalLocally, setAdjustingProposalLocally] = useState(false);
  const [acknowledgedAdjustRequest, setAcknowledgedAdjustRequest] = useState(proposalAdjustRequest);
  const proposalReview = novel?.stage === 'ready_for_greenlight';
  const adjustingProposal = adjustingProposalLocally
    || proposalAdjustRequest !== acknowledgedAdjustRequest;

  const handleChatStatusChange = useCallback((nextStatus: ChatStatus) => {
    onStatusChange(nextStatus);
    if (proposalReview && nextStatus === 'ready') {
      setAdjustingProposalLocally(false);
      setAcknowledgedAdjustRequest(proposalAdjustRequest);
    }
  }, [onStatusChange, proposalAdjustRequest, proposalReview]);

  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1024px)');
    const closeOnWide = () => {
      if (wide.matches) setMobileThreadsOpen(false);
    };
    closeOnWide();
    wide.addEventListener('change', closeOnWide);
    return () => wide.removeEventListener('change', closeOnWide);
  }, []);

  return (
    <div className="flex h-full w-full min-h-0 flex-1 flex-col overflow-hidden bg-book-bg-primary lg:flex-row">
      {showConversationList && (
        <div className="hidden min-h-0 w-72 flex-col border-r border-book-border bg-book-bg-primary/80 lg:flex">
          <Button
            type="button"
            variant="unstyled"
            size="unstyled"
            onClick={() => setActiveConvId(null)}
            className={`flex items-center gap-2 border-b border-book-border px-3 py-2 text-left text-sm font-semibold transition-feedback ${
              activeConvId === null
                ? 'bg-book-bg-card text-book-ink-primary'
                : 'text-book-ink-secondary hover:bg-book-bg-card/60 hover:text-book-ink-primary'
            }`}
          >
            <MessageSquare className="h-4 w-4 shrink-0 text-book-gold" />
            <span className="truncate">{t.agentMainThread}</span>
          </Button>
          <div className="min-h-0 flex-1">
            <ConversationList
              novelId={novelId}
              activeConvId={activeConvId}
              onSelectConversation={setActiveConvId}
              onCreateConversation={onCreateConversation}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {showConversationList && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-book-border px-3 py-2 lg:hidden">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMobileThreadsOpen(true)}
              className="gap-2"
            >
              <MessageSquare className="h-4 w-4" />
              {t.agentThreads}
            </Button>
            {activeConvId && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setActiveConvId(null)}
                className="gap-2 text-book-ink-secondary"
              >
                <ArrowLeft className="h-4 w-4" />
                {t.agentMainThread}
              </Button>
            )}
          </div>
        )}
        {showConversationList && activeConvId ? (
          <div className="min-h-0 flex-1">
            <ConversationThread novelId={novelId} conversationId={activeConvId} />
          </div>
        ) : null}
        <div className={showConversationList && activeConvId ? 'hidden' : 'flex min-h-0 flex-1'}>
          <ChatArea
            novelId={novelId}
            onUpdate={onUpdate}
            onStatusChange={handleChatStatusChange}
            initialCreativity={initialCreativity ?? null}
            composerCollapsed={proposalReview && !adjustingProposal}
            autoSubmitRequest={proposalAdjustRequest}
            autoSubmitText={t.storyDeckCompletePrompt}
            completionContent={proposalReview && !adjustingProposal && novel ? (
              <ProposalReviewPanel
                novel={novel}
                counts={deckCounts}
                coverageLoading={deckLoading}
                onApprove={onStartWriting}
                onReviewDeck={onReviewDeck}
                onAdjustProposal={() => setAdjustingProposalLocally(true)}
                onCompleteDeck={onCompleteDeck}
                busy={chatStatus === 'submitted' || chatStatus === 'streaming'}
              />
            ) : null}
          />
        </div>
      </div>

      {showConversationList && (
        <Sheet open={mobileThreadsOpen} onOpenChange={setMobileThreadsOpen}>
          <SheetContent aria-describedby={undefined} side="left" className="flex w-[20rem] max-w-[88vw] flex-col gap-0 border-book-border bg-book-bg-primary p-0 lg:hidden">
            <SheetHeader className="border-b border-book-border px-4 py-4 text-left">
              <SheetTitle className="font-serif text-lg text-book-ink-primary">
                {t.agentThreads}
              </SheetTitle>
            </SheetHeader>
            <Button
              type="button"
              variant="unstyled"
              size="unstyled"
              onClick={() => {
                setActiveConvId(null);
                setMobileThreadsOpen(false);
              }}
              className={`flex items-center gap-2 border-b border-book-border px-4 py-3 text-left text-sm font-semibold transition-feedback ${
                activeConvId === null
                  ? 'bg-book-bg-card text-book-ink-primary'
                  : 'text-book-ink-secondary hover:bg-book-bg-card/60 hover:text-book-ink-primary'
              }`}
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-book-gold" />
              <span className="truncate">{t.agentMainThread}</span>
            </Button>
            <div className="min-h-0 flex-1">
              <ConversationList
                novelId={novelId}
                activeConvId={activeConvId}
                onSelectConversation={(id) => {
                  setActiveConvId(id);
                  setMobileThreadsOpen(false);
                }}
                onCreateConversation={async (topic, title) => {
                  await onCreateConversation(topic, title);
                  setMobileThreadsOpen(false);
                }}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function StoryDeckMode({
  novelId,
  tab,
  onTabChange,
  refreshToken,
  coverageCounts,
  onReturnToAssistant,
}: {
  novelId: string;
  tab: KnowledgeFilterTab;
  onTabChange: (tab: KnowledgeFilterTab) => void;
  refreshToken: number;
  coverageCounts: DeckCounts;
  onReturnToAssistant: () => void;
}) {
  const { t } = useLanguage();
  const tabs: ReadonlyArray<{
    key: KnowledgeFilterTab;
    label: string;
    Icon: typeof Users;
  }> = [
    { key: 'character', label: t.storyDeckCharacters, Icon: Users },
    { key: 'world', label: t.storyDeckWorld, Icon: Globe },
    { key: 'outline', label: t.storyDeckOutline, Icon: FileText },
  ];
  return (
    <section className="flex h-full min-h-0 flex-col bg-book-bg-primary">
      <div className="border-b border-book-border px-5 py-4">
        <div className="font-serif text-xl font-semibold text-book-ink-primary">
          {t.storyDeckTitle}
        </div>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-book-ink-muted">
          {t.storyDeckSubtitle}
        </p>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as KnowledgeFilterTab)}
        className="border-b border-book-border bg-book-bg-secondary/60 p-2 sm:max-w-xl"
      >
        <TabsList className="grid w-full grid-cols-3 gap-1 border-0">
          {tabs.map(({ key, label, Icon }) => (
            <TabsTrigger
              key={key}
              value={key}
              className="flex items-center justify-center gap-1.5 rounded-md border-0 px-2 py-1.5 text-xs font-medium data-[state=active]:border-b-transparent data-[state=active]:bg-book-bg-card data-[state=active]:text-book-ink-primary data-[state=active]:shadow-sm"
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="truncate">{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="min-h-0 flex-1">
        <KnowledgePanel
          novelId={novelId}
          controlledFilter={tab}
          variant="deck"
          refreshToken={refreshToken}
          coverageCounts={coverageCounts}
          onReturnToAssistant={onReturnToAssistant}
          returnToAssistantLabel={t.storyDeckReturnAssistant}
        />
      </div>
    </section>
  );
}

/**
 * Manuscript view body — pulled out so the JSX in `NovelWorkspace` stays
 * narrow. Maps the session hook's state to the existing ManuscriptShell +
 * blueprint / unification panels.
 */
function ManuscriptPaneBody({
  novelId,
  manuscript,
  showUnification,
  showBlueprintQuickJump,
  onJumpToOutline,
  requestedChapter,
  startInEditing,
  requestedOffset,
}: {
  novelId: string;
  manuscript: ReturnType<typeof useManuscriptSession>;
  showUnification: boolean;
  showBlueprintQuickJump: boolean;
  onJumpToOutline: () => void;
  requestedChapter?: number | null;
  startInEditing?: boolean;
  requestedOffset?: number | null;
}) {
  const { t } = useLanguage();
  const [retryingLoad, setRetryingLoad] = useState(false);
  const planningBinding = useCapabilityBinding('outline');
  const draftingBinding = useCapabilityBinding('chapter');
  const {
    novel,
    chapters,
    isLoading,
    isStreaming,
    didRequestAutostart,
    liveChapter,
    resumePromptVisible,
    resumeCountdown,
    batchDone,
    fetchChapters,
    fetchNovel,
    startWriting,
    pauseWriting,
    cancelResume,
    dismissBatchDone,
  } = manuscript;

  if (isLoading && !novel) {
    return (
      <div className="flex flex-1 items-center justify-center font-serif text-xl text-book-ink-secondary">
        {t.loading || 'Loading'}
      </div>
    );
  }
  if (!novel) {
    const retryLoad = async () => {
      if (retryingLoad) return;
      setRetryingLoad(true);
      try {
        await Promise.allSettled([fetchNovel(), fetchChapters()]);
      } finally {
        setRetryingLoad(false);
      }
    };
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="font-serif text-base text-book-ink-secondary">{t.errorLoadManuscript}</p>
        <Button
          type="button"
          variant="outline"
          disabled={retryingLoad}
          onClick={() => void retryLoad()}
        >
          {retryingLoad ? (t.loading || 'Loading') : t.toastRetry}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-book-bg-secondary">
      <ManuscriptToolbar
        showBlueprintQuickJump={showBlueprintQuickJump}
        onJumpToOutline={onJumpToOutline}
        showUnification={showUnification}
        novelId={novelId}
        report={novel.unificationReport ?? null}
        onApplied={fetchChapters}
        onComplete={fetchNovel}
      />

      {batchDone && (
        <ManuscriptNoticeRow
          title={t.writingBatchDone.replace('{chapter}', String(batchDone.completedChapter))}
          subtext={t.writingBatchRemaining.replace('{remaining}', String(batchDone.remaining))}
          secondaryLabel={t.writingEditBlueprint}
          onSecondary={() => { dismissBatchDone(); onJumpToOutline(); }}
          primaryLabel={t.writingNextChapter}
          onPrimary={() => { dismissBatchDone(); void startWriting({ chapters: 1 }); }}
        />
      )}

      {resumePromptVisible && !batchDone && (
        <ManuscriptNoticeRow
          title={t.resumeWritingTitle}
          subtext={resumeCountdown !== null
            ? t.resumeWritingDesc.replace('{seconds}', String(resumeCountdown))
            : t.resumeWritingPause}
          secondaryLabel={t.resumeWritingCancel}
          onSecondary={cancelResume}
          primaryLabel={resumeCountdown !== null ? t.resumeWritingNow : t.writingNextChapter}
          onPrimary={() => { cancelResume(); void startWriting({ chapters: 1 }); }}
        />
      )}

      <ManuscriptShell
        novelId={novelId}
        title={novel.title || t.untitledNovel}
        genre={novel.genre}
        storySummary={novel.storySummary}
        characterSummary={novel.characterSummary}
        arcSummary={novel.arcSummary}
        progress={novel.progress}
        mode={resolveManuscriptShellMode({
          didRequestAutostart,
          isStreaming,
          liveChapter,
          batchDone,
          resumePromptVisible,
        })}
        chapters={chapters}
        liveChapter={liveChapter}
        onChaptersChange={fetchChapters}
        initialCreativity={novel.settings?.creativity ?? null}
        requestedChapter={requestedChapter}
        startInEditing={startInEditing}
        requestedOffset={requestedOffset}
        canContinueWriting={novel.progress < 100 && isInStages(novel.stage, STAGES_THAT_CAN_START_WRITING)}
        writingRunState={{
          ...manuscript.writingRunState,
          modelLabel: (() => {
            const resolved = manuscript.writingRunState.phase === 'preparing'
              || manuscript.writingRunState.phase === 'planning'
              ? planningBinding.resolved
              : draftingBinding.resolved;
            return resolved.binding && resolved.conn
              ? `${resolved.conn.label} · ${resolved.binding.modelId}`
              : t.writingPreviewModelPending;
          })(),
        }}
        writingRunControls={{
          onPause: isStreaming ? pauseWriting : undefined,
          onResume: () => { void startWriting({ chapters: 1 }); },
          onRetry: () => { void startWriting({ chapters: 1 }); },
        }}
      />
    </div>
  );
}

/**
 * One thin manuscript notice row (writing-batch-done / resume-writing prompt).
 * Both prompts used to render as tall `rounded-2xl p-3` two-line cards (~70px
 * each) stacked above the manuscript; on a 720-tall viewport that pushed the
 * prose past the halfway line. This collapses each to a single ~36px bar —
 * title + inline muted subtext, actions right — reclaiming the height for the
 * content these prompts sit on top of, while keeping both CTAs one tap away.
 */
function ManuscriptNoticeRow({
  title,
  subtext,
  secondaryLabel,
  onSecondary,
  primaryLabel,
  onPrimary,
}: {
  title: string;
  subtext: string;
  secondaryLabel: string;
  onSecondary: () => void;
  primaryLabel: string;
  onPrimary: () => void;
}) {
  return (
    <div className="mx-4 my-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-book-border bg-book-bg-card/80 px-4 py-1.5 shadow-sm backdrop-blur md:mx-6">
      <div className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
        <span className="shrink-0 font-medium text-book-ink-primary">{title}</span>
        <span className="truncate text-xs text-book-ink-secondary">{subtext}</span>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="unstyled"
          size="unstyled"
          onClick={onSecondary}
          className="border border-book-border bg-book-bg-secondary px-3 py-1 text-xs font-medium text-book-ink-secondary transition-feedback hover:bg-book-bg-card"
        >
          {secondaryLabel}
        </Button>
        <Button
          variant="accent"
          type="button"
          onClick={onPrimary}
          className="h-auto px-3 py-1 text-xs font-semibold"
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Single thin tools row for the manuscript view. Merges the Chapter-Blueprint
 * quick-jump and the whole-book consistency check into ONE row. The consistency
 * tool opens as a RIGHT-DOCKED, NON-MODAL floating panel (not an inline
 * Collapsible) — so reviewing continuity edits never pushes the manuscript
 * down, and the reader stays visible/scrollable on the left while the user
 * applies edits one by one. It renders via the design-system Sheet in
 * non-modal mode (modal={false} + showOverlay={false}): portaled and fixed to
 * the right edge with no backdrop, and outside-clicks are ignored so reading
 * the manuscript can't dismiss it — closed only via X / Esc / the pill.
 */
function ManuscriptToolbar({
  showBlueprintQuickJump,
  onJumpToOutline,
  showUnification,
  novelId,
  report,
  onApplied,
  onComplete,
}: {
  showBlueprintQuickJump: boolean;
  onJumpToOutline: () => void;
  showUnification: boolean;
  novelId: string;
  report: UnificationReport | null;
  onApplied?: () => void;
  onComplete?: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  // The pill triggers the sheet via external state (not SheetTrigger) so it can
  // toggle. That means Radix won't restore focus to it on close, so we hold a
  // ref and re-focus it in onCloseAutoFocus — otherwise keyboard/SR users land
  // on <body> and lose their place after Esc / X.
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const pendingCount = useMemo(
    () => (report?.edits ?? []).filter(e => !e.applied && !e.skipped).length,
    [report],
  );

  if (!showBlueprintQuickJump && !showUnification) return null;

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 pb-1 md:px-6">
        {showBlueprintQuickJump && (
          <Button
            type="button"
            variant="unstyled"
            size="unstyled"
            onClick={onJumpToOutline}
            title={t.outlineGoToTabHint}
            className="inline-flex items-center gap-1.5 border border-book-border bg-book-bg-card/70 px-3.5 py-1.5 text-sm font-medium text-book-ink-secondary shadow-sm backdrop-blur transition-feedback hover:bg-book-bg-card"
          >
            {t.blueprintTitle}
          </Button>
        )}
        {showUnification && (
          <Button
            ref={pillRef}
            type="button"
            variant="unstyled"
            size="unstyled"
            onClick={() => setOpen(o => !o)}
            aria-expanded={open}
            aria-controls={panelId}
            className="inline-flex items-center gap-1.5 border border-book-border bg-book-bg-card/70 px-3.5 py-1.5 text-sm font-medium text-book-ink-secondary shadow-sm backdrop-blur transition-feedback hover:bg-book-bg-card"
          >
            <ListChecks className="h-4 w-4 shrink-0 text-book-gold" aria-hidden="true" />
            <span>{t.unificationTitle}</span>
            {pendingCount > 0 ? (
              <Badge variant="writing">{t.unificationPendingCount.replace('{count}', String(pendingCount))}</Badge>
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0 text-book-success" aria-hidden="true" />
            )}
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-book-ink-muted transition-toggle ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </Button>
        )}
      </div>
      {showUnification && (
        // Non-modal right sheet: floats over the right of the reader without a
        // backdrop and without trapping focus, so the manuscript stays readable
        // and scrollable while the user applies continuity edits one by one.
        // Outside clicks are ignored (only X / Esc / the pill close it) to avoid
        // accidentally dismissing it while reading.
        <Sheet open={open} onOpenChange={setOpen} modal={false}>
          <SheetContent
            id={panelId}
            aria-describedby={undefined}
            side="right"
            showOverlay={false}
            className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
            onInteractOutside={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => { e.preventDefault(); pillRef.current?.focus(); }}
          >
            <SheetHeader className="shrink-0 border-b border-book-border">
              <SheetTitle className="flex items-center gap-1.5 font-serif text-base text-book-ink-primary">
                <ListChecks className="h-4 w-4 shrink-0 text-book-gold" aria-hidden="true" />
                <span>{t.unificationTitle}</span>
                {pendingCount > 0 && (
                  <Badge variant="writing">{t.unificationPendingCount.replace('{count}', String(pendingCount))}</Badge>
                )}
              </SheetTitle>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">
              <UnificationPanel
                novelId={novelId}
                initialReport={report}
                onApplied={onApplied}
                onComplete={onComplete}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
