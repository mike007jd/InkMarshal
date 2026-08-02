'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ChatStatus } from 'ai';
import { ArrowLeft, MessageSquare } from 'lucide-react';

import { ChatArea } from '@/components/ChatArea';
import { ConversationList } from '@/components/conversations/ConversationList';
import { ConversationThread } from '@/components/conversations/ConversationThread';
import { useLanguage } from '@/components/LanguageProvider';
import type { DeckCounts, StoryDeckRepairPhase } from '@/components/novel-workspace/types';
import { ProposalReviewPanel } from '@/components/ProposalReviewPanel';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import type { Novel } from '@/lib/db-types';

export function AgentWorkspacePane({
  novelId,
  novel,
  deckCounts,
  deckLoading,
  activeConvId,
  setActiveConvId,
  onCreateConversation,
  onUpdate,
  onStatusChange,
  chatStatus,
  onStartWriting,
  onReviewDeck,
  onCompleteDeck,
  storyDeckRepairRequest,
  repairPhase,
  onRepairPhaseChange,
  initialCreativity,
}: {
  novelId: string;
  novel: Novel | null | undefined;
  deckCounts: DeckCounts;
  deckLoading: boolean;
  activeConvId: string | null;
  setActiveConvId: (id: string | null) => void;
  onCreateConversation: (topic: string, title: string) => void | Promise<void>;
  onUpdate: () => void;
  onStatusChange: (status: ChatStatus) => void;
  chatStatus: ChatStatus;
  onStartWriting: () => void;
  onReviewDeck: () => void;
  onCompleteDeck: () => void;
  storyDeckRepairRequest: number;
  repairPhase: StoryDeckRepairPhase;
  onRepairPhaseChange: (phase: 'running' | 'succeeded' | 'failed') => void;
  initialCreativity?: CreativityLevel | null;
}) {
  const { t } = useLanguage();
  const showConversationList = true;
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false);
  // Manual proposal adjustment only. The repair lifecycle (queued → running
  // → failed) deliberately does NOT touch this flag: the ProposalReviewPanel
  // owns the recovery UI and must stay mounted and visible while a repair is
  // in flight, separate from the user choosing to adjust the proposal by
  // hand (which reveals the bare chat until the next turn settles).
  const [adjustingProposalLocally, setAdjustingProposalLocally] = useState(false);
  const proposalReview = novel?.stage === 'ready_for_greenlight';
  const adjustingProposal = adjustingProposalLocally;

  const handleChatStatusChange = useCallback((nextStatus: ChatStatus) => {
    onStatusChange(nextStatus);
    if (proposalReview && nextStatus === 'ready') {
      setAdjustingProposalLocally(false);
    }
  }, [onStatusChange, proposalReview]);

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
            <ConversationThread
              key={`${novelId}:${activeConvId}`}
              novelId={novelId}
              conversationId={activeConvId}
            />
          </div>
        ) : null}
        <div className={showConversationList && activeConvId ? 'hidden' : 'flex min-h-0 flex-1'}>
          <ChatArea
            novelId={novelId}
            onUpdate={onUpdate}
            onStatusChange={handleChatStatusChange}
            initialCreativity={initialCreativity ?? null}
            autoSubmitRequest={storyDeckRepairRequest}
            autoSubmitText={t.storyDeckCompletePrompt}
            onRepairPhaseChange={onRepairPhaseChange}
            completionContent={proposalReview && !adjustingProposal && novel ? (
              <ProposalReviewPanel
                novel={novel}
                counts={deckCounts}
                coverageLoading={deckLoading}
                onApprove={onStartWriting}
                onReviewDeck={onReviewDeck}
                onAdjustProposal={() => setAdjustingProposalLocally(true)}
                onCompleteDeck={onCompleteDeck}
                repairPhase={repairPhase}
                busy={chatStatus === 'submitted' || chatStatus === 'streaming'}
              />
            ) : null}
          />
        </div>
      </div>

      {showConversationList && (
        <Sheet open={mobileThreadsOpen} onOpenChange={setMobileThreadsOpen}>
          <SheetContent
            aria-describedby={undefined}
            side="left"
            className="flex w-[20rem] max-w-[88vw] flex-col gap-0 border-book-border bg-book-bg-primary p-0 lg:hidden"
          >
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
