'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import type { ChatStatus } from 'ai';
import { useLanguage } from '@/components/LanguageProvider';
import { joinLocalizedDisplayList } from '@/lib/i18n';
import { EmptyChatInterviewGuide } from '@/components/EmptyChatInterviewGuide';
import { useToast } from '@/components/Toast';
import { NovelThread } from '@/components/assistant-ui/thread';
import {
  stoppedPersistenceLabel,
  useNovelChatRuntime,
} from '@/components/assistant-ui/useNovelChatRuntime';
import { CreativityPicker } from '@/components/writing/CreativityPicker';
import { ChatModelPicker } from '@/components/writing/ChatModelPicker';
import { useNovelCreativity } from '@/hooks/useNovelCreativity';
import type { CreativityLevel } from '@/lib/ai/generation-presets';

export function ChatArea({
  novelId,
  onUpdate,
  initialCreativity = null,
  onStatusChange,
  completionContent,
  autoSubmitRequest = 0,
  autoSubmitText,
  onRepairPhaseChange,
}: {
  novelId: string;
  onUpdate: () => void;
  initialCreativity?: CreativityLevel | null;
  onStatusChange?: (status: ChatStatus) => void;
  completionContent?: ReactNode;
  autoSubmitRequest?: number;
  autoSubmitText?: string;
  /** Lifecycle of the auto-submitted Story Deck repair turn. `running` fires
   *  once the request is consumed and sent; `succeeded`/`failed` fire when
   *  that same turn settles. An aborted (Stop) turn settles as `failed` —
   *  never `succeeded`. No other turn reports through this callback. */
  onRepairPhaseChange?: (phase: 'running' | 'succeeded' | 'failed') => void;
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
          joinLocalizedDisplayList(receipt.storyEntries.map(entry => entry.title), locale),
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
  }, [locale, novelId, onUpdate, t, toast]);

  const submittedRequestRef = useRef(0);
  const [modelSelectionPending, setModelSelectionPending] = useState(false);
  // Repair-turn lifecycle. `repairInFlightRef` becomes true the moment the
  // auto-submit is consumed; the turn then settles exclusively through the
  // AI SDK finish outcome (onTurnFinish) or a pre-send rejection — never
  // through status transitions, because an aborted (Stop) turn returns to
  // `ready` exactly like a successful one.
  const repairInFlightRef = useRef(false);
  const { runtime, status, loading, recovering, refresh, errorMessage, retryKind, retry, sendMessage } = useNovelChatRuntime({
    novelId,
    locale,
    creativity,
    stoppedLabel: stoppedPersistenceLabel(locale),
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
    onTurnFinish: (outcome) => {
      if (!repairInFlightRef.current) return;
      repairInFlightRef.current = false;
      onRepairPhaseChange?.(outcome === 'succeeded' ? 'succeeded' : 'failed');
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
  useEffect(() => {
    if (
      autoSubmitRequest <= 0
      || autoSubmitRequest === submittedRequestRef.current
      || !autoSubmitText
      || loading
      // `error` is an idle state here: sendMessage clears it before the new
      // turn, so a failed repair can be retried by the next request.
      || (status !== 'ready' && status !== 'error')
      || modelSelectionPending
    ) return;
    submittedRequestRef.current = autoSubmitRequest;
    repairInFlightRef.current = true;
    onRepairPhaseChange?.('running');
    // A rejection here means the turn never reached the server (no finish
    // outcome will follow), so the send itself is the settle signal.
    void sendMessage(autoSubmitText, { repairStoryDeck: true }).catch(() => {
      if (!repairInFlightRef.current) return;
      repairInFlightRef.current = false;
      onRepairPhaseChange?.('failed');
    });
  }, [
    autoSubmitRequest,
    autoSubmitText,
    loading,
    modelSelectionPending,
    onRepairPhaseChange,
    sendMessage,
    status,
  ]);

  const handleRetry = useCallback(() => {
    const retriesRepair = retryKind === 'repair';
    if (
      retriesRepair
      && (repairInFlightRef.current || status === 'submitted' || status === 'streaming')
    ) {
      return;
    }
    if (retriesRepair) {
      repairInFlightRef.current = true;
      onRepairPhaseChange?.('running');
    }
    void retry().catch(() => {
      if (!retriesRepair || !repairInFlightRef.current) return;
      repairInFlightRef.current = false;
      onRepairPhaseChange?.('failed');
    });
  }, [onRepairPhaseChange, retry, retryKind, status]);

  return (
    <div className="flex-1 flex flex-col h-full book-texture-parchment relative overflow-hidden">
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
            composerControls={<ChatModelPicker onSavingChange={setModelSelectionPending} />}
            composerSendDisabled={modelSelectionPending || recovering}
            errorMessage={errorMessage}
            onRetry={handleRetry}
            completionContent={completionContent}
          />
        </AssistantRuntimeProvider>
      </div>
    </div>
  );
}
