'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import type { ChatStatus } from 'ai';
import { useLanguage } from '@/components/LanguageProvider';
import { EmptyChatInterviewGuide } from '@/components/EmptyChatInterviewGuide';
import { WritingModelStatusBar } from '@/components/WritingModelStatusBar';
import { useToast } from '@/components/Toast';
import { NovelThread } from '@/components/assistant-ui/thread';
import { useNovelChatRuntime } from '@/components/assistant-ui/useNovelChatRuntime';
import { CreativityPicker } from '@/components/writing/CreativityPicker';
import { useNovelCreativity } from '@/hooks/useNovelCreativity';
import type { CreativityLevel } from '@/lib/ai/generation-presets';

export function ChatArea({
  novelId,
  onUpdate,
  initialCreativity = null,
  onStatusChange,
  composerCollapsed = false,
  completionContent,
  autoSubmitRequest = 0,
  autoSubmitText,
}: {
  novelId: string;
  onUpdate: () => void;
  initialCreativity?: CreativityLevel | null;
  onStatusChange?: (status: ChatStatus) => void;
  composerCollapsed?: boolean;
  completionContent?: ReactNode;
  autoSubmitRequest?: number;
  autoSubmitText?: string;
}) {
  const { t, locale } = useLanguage();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  // Per-novel creativity. The server value wins first paint, then local edits
  // persist through the shared hook.
  const { creativity, setCreativity, syncFailed: creativitySyncFailed } = useNovelCreativity(novelId, initialCreativity);

  // Keep a stable handle to the runtime's refresh for the load-error retry
  // toast (defined before the runtime exists).
  const refreshRef = useRef<() => void>(() => {});

  const revealBrainstormReceipt = useCallback(async () => {
    try {
      const response = await fetch(`/api/novels/${novelId}/brainstorm-receipt`, { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json() as {
        receipt: null | {
          id: string;
          profileFields: string[];
          storyEntries: Array<{ title: string }>;
          undoExpiresAt: number;
        };
      };
      const receipt = payload.receipt;
      if (!receipt) return;

      const savedItems: string[] = [];
      if (receipt.profileFields.length > 0) savedItems.push(t.brainstormReceiptProfile);
      if (receipt.storyEntries.length > 0) {
        savedItems.push(t.brainstormReceiptStoryDeck.replace(
          '{titles}',
          receipt.storyEntries.map(entry => entry.title).join(', '),
        ));
      }
      if (savedItems.length === 0) return;

      const undo = async () => {
        try {
          const undoResponse = await fetch(`/api/novels/${novelId}/brainstorm-receipt/undo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ receiptId: receipt.id }),
          });
          if (!undoResponse.ok) throw new Error('undo_failed');
          onUpdate();
          toast(t.brainstormReceiptUndone, 'success');
        } catch {
          toast(t.brainstormReceiptUndoFailed, 'error');
        }
      };
      toast(
        t.brainstormReceiptSaved.replace('{items}', savedItems.join(' · ')),
        'success',
        {
          action: { label: t.brainstormReceiptUndo, onClick: () => void undo() },
          durationMs: Math.max(1_000, receipt.undoExpiresAt - Date.now()),
        },
      );
    } catch {
      // A receipt is additive UX. Chat remains successful even if its
      // presentation endpoint is briefly unavailable.
    }
  }, [novelId, onUpdate, t, toast]);

  const { runtime, status, loading, refresh, errorMessage, retry, sendMessage } = useNovelChatRuntime({
    novelId,
    locale,
    creativity,
    stoppedLabel: t.writingStopped,
    streamFailedLabel: t.errorSendFailed,
    loadFailedLabel: t.errorLoadMessages,
    autoStartLastUserTurn: searchParams.get('autostart') === '1',
    onError: (message) => {
      toast(message || t.errorSendFailed);
      void revealBrainstormReceipt();
    },
    onTurnComplete: () => {
      onUpdate();
      void revealBrainstormReceipt();
    },
    onLoadError: () =>
      toast(t.errorLoadMessages, 'error', {
        action: { label: t.toastRetry, onClick: () => refreshRef.current() },
      }),
  });
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);
  const submittedRequestRef = useRef(0);
  useEffect(() => {
    if (
      autoSubmitRequest <= 0
      || autoSubmitRequest === submittedRequestRef.current
      || !autoSubmitText
      || loading
      || status !== 'ready'
    ) return;
    submittedRequestRef.current = autoSubmitRequest;
    void sendMessage(autoSubmitText, { repairStoryDeck: true });
  }, [autoSubmitRequest, autoSubmitText, loading, sendMessage, status]);

  return (
    <div className="flex-1 flex flex-col h-full book-texture-parchment relative overflow-hidden">
      <WritingModelStatusBar operation="chat" />
      {/* Creativity picker — chat-level slider rather than per-message so it
          stays visible while scrolling history. */}
      <div className="flex items-center justify-end gap-3 border-b border-book-border bg-book-bg-card/40 px-3 py-1">
        <CreativityPicker value={creativity} onChange={setCreativity} size="sm" syncFailed={creativitySyncFailed} />
      </div>

      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <NovelThread
            placeholder={t.typeMessage}
            emptyState={<EmptyChatInterviewGuide />}
            composerFooter={t.aiWarning}
            errorMessage={errorMessage}
            onRetry={() => void retry()}
            hideComposer={composerCollapsed}
            completionContent={completionContent}
          />
        </AssistantRuntimeProvider>
      </div>
    </div>
  );
}
