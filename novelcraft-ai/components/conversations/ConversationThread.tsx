'use client';

import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { GitFork, ListPlus, X } from 'lucide-react';
import { AssistantRuntimeProvider, useAuiState } from '@assistant-ui/react';
import { FeatherIcon } from '@/components/Icons';
import { NovelThread } from '@/components/assistant-ui/thread';
import { useNovelChatRuntime } from '@/components/assistant-ui/useNovelChatRuntime';
import { useConversationExtract } from '@/components/conversations/useConversationExtract';
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button';
import type { Conversation } from '@/lib/types/conversation';
import { useLocale } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { KnowledgeEntryForm } from '@/components/knowledge/KnowledgeEntryForm';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '@/components/ui/empty';
import { WritingModelStatusBar } from '@/components/WritingModelStatusBar';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
/* ── Props ── */
interface ConversationThreadProps {
  novelId: string;
  conversationId: string;
}

/**
 * Per-assistant-message "extract → knowledge" action, injected into the
 * assistant-ui action bar. Renders inside a message's context, so it reads the
 * active message id directly. Streaming / locally-stopped placeholders (ids
 * prefixed `streaming-`) have no server row yet, so they're skipped.
 */
const ExtractKnowledgeAction: FC<{
  extractingId: string | null;
  onExtract: (messageId: string) => void;
  label: string;
}> = ({ extractingId, onExtract, label }) => {
  const messageId = useAuiState((s) => s.message.id);
  if (!messageId || messageId.startsWith('streaming-')) return null;
  const busy = extractingId === messageId;
  return (
    <TooltipIconButton
      tooltip={label}
      side="bottom"
      disabled={busy}
      onClick={() => onExtract(messageId)}
      data-testid={`extract-as-knowledge-${messageId}`}
    >
      {busy ? <Spinner /> : <ListPlus className="size-4" />}
    </TooltipIconButton>
  );
};

export function ConversationThread({ novelId, conversationId }: ConversationThreadProps) {
  const { t, locale } = useLocale();
  const { toast } = useToast();
  const [conversation, setConversation] = useState<Conversation | null>(null);

  const activeScopeRef = useRef(`${novelId}:${conversationId}`);

  const { extractingFor, prefill: extractPrefill, openExtractDialog, clearPrefill } = useConversationExtract({
    novelId,
    conversationId,
    locale,
    onError: () => toast(t.extractFailed as string, 'error'),
    onModelUnavailable: () => toast(t.extractFailed as string, 'info'),
    onDegraded: () => toast(t.extractDegraded as string, 'info'),
  });

  const { runtime, loading, errorMessage, retry } = useNovelChatRuntime({
    novelId,
    conversationId,
    locale,
    streamFailedLabel: t.errorSendFailed,
    requestFailedLabel: t.errorSendFailed,
    loadFailedLabel: t.errorLoadMessages,
    // A mid-stream failure used to vanish into console.error, leaving the
    // spinner gone with no reply and no error. Surface it as a toast.
    onError: (message) => toast(message || t.errorSendFailed, 'error'),
    onLoadError: () => toast(t.errorLoadMessages, 'error'),
  });

  useEffect(() => {
    activeScopeRef.current = `${novelId}:${conversationId}`;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setConversation(null);
    });
    return () => {
      cancelled = true;
    };
  }, [novelId, conversationId]);

  /* ── Fetch conversation metadata (fork indicator) ── */
  const fetchConversation = useCallback(async () => {
    const requestScope = `${novelId}:${conversationId}`;
    try {
      const res = await fetch(`/api/novels/${novelId}/conversations/${conversationId}`);
      if (!res.ok) return;
      const conv: Conversation = await res.json();
      if (activeScopeRef.current === requestScope) setConversation(conv);
    } catch {
      // silently ignore
    }
  }, [novelId, conversationId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      fetchConversation();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchConversation]);

  const handleCloseExtract = clearPrefill;
  const handleExtractSaved = () => {
    clearPrefill();
    toast(t.extractDialogTitle as string, 'success');
  };

  // Loading stays its own state (spinner, no copy) — only the genuinely-empty
  // thread renders the Empty primitive.
  const emptyState = loading ? (
    <div className="flex items-center justify-center py-12">
      <Spinner size="lg" className="text-book-ink-muted" />
    </div>
  ) : (
    <Empty className="border-0 p-0 py-12 md:p-0 md:py-12">
      <EmptyHeader>
        <EmptyMedia>
          <FeatherIcon className="h-8 w-8 text-book-ink-muted" />
        </EmptyMedia>
        <EmptyDescription className="text-sm text-book-ink-muted">
          {t.conversationStartHint}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );

  return (
    <div className="flex flex-col h-full">
      <WritingModelStatusBar operation="chat" />

      {/* Fork indicator */}
      {conversation?.parentMessageId && (
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-book-border bg-book-bg-secondary">
          <GitFork className="w-3.5 h-3.5 text-book-ink-muted" />
          <span className="text-xs text-book-ink-muted">
            {t.conversationForkedFrom}{' '}
            <code className="text-2xs bg-book-bg-card px-1 py-0.5 rounded">
              {conversation.parentMessageId.slice(0, 8)}...
            </code>
          </span>
        </div>
      )}

      {/* Conversation thread */}
      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <NovelThread
            placeholder={t.conversationInputPlaceholder}
            emptyState={emptyState}
            errorMessage={errorMessage}
            onRetry={() => void retry()}
            assistantActions={
              <ExtractKnowledgeAction
                extractingId={extractingFor}
                onExtract={(id) => void openExtractDialog(id)}
                label={t.extractAsKnowledge as string}
              />
            }
          />
        </AssistantRuntimeProvider>
      </div>

      <Sheet
        open={Boolean(extractPrefill)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) handleCloseExtract();
        }}
      >
        {extractPrefill && (
          <SheetContent
            side="right"
            showCloseButton={false}
            aria-describedby={undefined}
            className="w-full gap-0 overflow-hidden border-book-border bg-book-bg-primary p-0 text-book-ink-primary sm:max-w-xl"
          >
            <SheetHeader className="flex-row items-center justify-between gap-4 border-b border-book-border px-5 py-3 text-left">
              <SheetTitle className="font-serif text-base font-semibold text-book-ink-primary">
                {t.extractDialogTitle as string}
              </SheetTitle>
              <SheetClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t.searchClose as string}
                >
                  <X data-icon="inline-start" aria-hidden />
                </Button>
              </SheetClose>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1 overflow-x-hidden">
              <div className="p-5">
                <KnowledgeEntryForm
                  novelId={novelId}
                  initialPrefill={extractPrefill}
                  onClose={handleCloseExtract}
                  onSaved={handleExtractSaved}
                />
              </div>
            </ScrollArea>
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}
