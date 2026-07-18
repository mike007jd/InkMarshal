'use client';

import { type FC, type ReactNode } from 'react';
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import { AlertCircle, ArrowDown, Check, Copy, FileText, Paperclip, RotateCcw, Send, Square, X } from 'lucide-react';

import { MarkdownText } from '@/components/assistant-ui/markdown-text';
import {
  AssistantMarkdownFrame,
  AssistantMessageFrame,
  UserMessageFrame,
} from '@/components/assistant-ui/message-frame';
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button';
import { useLocale } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

export interface NovelThreadProps {
  /** Composer input placeholder. */
  placeholder: string;
  /** Rendered inside the viewport when the thread has no messages. */
  emptyState?: ReactNode;
  /** Note rendered under the composer (e.g. the AI disclaimer). */
  composerFooter?: ReactNode;
  errorMessage?: string | null;
  onRetry?: () => void;
  /**
   * Extra controls injected into every assistant message's action bar. The node
   * renders inside each message's context, so children may read the active
   * message via `useAuiState` (used for "extract → knowledge").
   */
  assistantActions?: ReactNode;
}

/**
 * Book-themed chat surface built on assistant-ui primitives. Visual language
 * mirrors the previous hand-rolled ChatArea (parchment, gold focus ring,
 * NovelistAvatar, ink user bubbles) so the swap to the library is seamless.
 */
export const NovelThread: FC<NovelThreadProps> = ({
  placeholder,
  emptyState,
  composerFooter,
  errorMessage,
  onRetry,
  assistantActions,
}) => {
  const { t } = useLocale();
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="relative flex flex-1 flex-col overflow-y-auto scroll-smooth px-3 py-4 sm:px-6 md:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 sm:gap-8">
          {emptyState ? (
            <AuiIf condition={(s) => s.thread.isEmpty}>{emptyState}</AuiIf>
          ) : null}

          <ThreadPrimitive.Messages>
            {() => <ThreadMessage assistantActions={assistantActions} />}
          </ThreadPrimitive.Messages>

          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex flex-col items-center gap-2">
            <ScrollToBottom />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>

      <div className="border-t border-book-border bg-book-bg-primary px-4 py-4 md:px-6">
        {errorMessage ? (
          <div className="mx-auto mb-3 flex max-w-3xl items-center gap-3 rounded-md border border-book-danger-border bg-book-danger-light px-3 py-2 text-sm text-book-danger">
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{errorMessage}</span>
            {onRetry ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onRetry}
                className="shrink-0 gap-1 text-book-danger hover:bg-book-danger-light"
              >
                <RotateCcw className="size-3.5" />
                {t.toastRetry}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Composer placeholder={placeholder} />
        {composerFooter ? (
          <div className="mx-auto mt-3 max-w-3xl text-center text-xs font-medium font-serif text-book-ink-muted">
            {composerFooter}
          </div>
        ) : null}
      </div>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC<{ assistantActions?: ReactNode }> = ({ assistantActions }) => {
  const role = useAuiState((s) => s.message.role);
  if (role === 'user') return <UserMessage />;
  return <AssistantMessage assistantActions={assistantActions} />;
};

const ScrollToBottom: FC = () => {
  const { t } = useLocale();
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip={t.chatScrollToBottom}
        side="top"
        variant="outline"
        className="size-9 rounded-full border-book-border bg-book-bg-card p-2 shadow-card disabled:invisible"
      >
        <ArrowDown className="size-4" />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const AssistantMessage: FC<{ assistantActions?: ReactNode }> = ({ assistantActions }) => {
  const { t } = useLocale();
  const isRunning = useAuiState((s) => s.message.status?.type === 'running');
  const hasRenderableContent = useAuiState((s) =>
    s.message.content.some((part) => part.type !== 'text' || part.text.trim().length > 0),
  );

  if (!isRunning && !hasRenderableContent) return null;

  return (
    <MessagePrimitive.Root
      data-role="assistant"
      className="contents"
    >
      <AssistantMessageFrame
        actions={!isRunning ? <AssistantActionBar extraActions={assistantActions} /> : null}
      >
        {isRunning && !hasRenderableContent ? (
          <div className="flex items-center gap-3">
            <Spinner className="text-book-ink-muted" />
            <span className="text-sm font-medium font-serif text-book-ink-muted">{t.thinking}</span>
          </div>
        ) : (
          <AssistantMarkdownFrame>
            <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
          </AssistantMarkdownFrame>
        )}
      </AssistantMessageFrame>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC<{ extraActions?: ReactNode }> = ({ extraActions }) => {
  const { t } = useLocale();
  return (
    <ActionBarPrimitive.Root className="ml-1 mt-1 flex items-center gap-1 text-book-ink-muted opacity-0 transition-feedback focus-within:opacity-100 group-hover:opacity-100">
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t.chatCopy} side="bottom">
          <AuiIf condition={(s) => s.message.isCopied}>
            <Check className="size-4" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <Copy className="size-4" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      {extraActions}
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-role="user"
      className="contents"
    >
      <UserMessageFrame>
        <MessagePrimitive.Attachments components={{ Attachment: MessageAttachmentPreview }} />
        <MessagePrimitive.Parts />
      </UserMessageFrame>
    </MessagePrimitive.Root>
  );
};

const Composer: FC<{ placeholder: string }> = ({ placeholder }) => {
  const { t } = useLocale();
  return (
    <ComposerPrimitive.Root className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-lg border border-book-border bg-book-bg-card p-2 shadow-sm transition-feedback focus-within:border-book-gold focus-within:ring-1 focus-within:ring-book-gold">
      <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachmentPreview }} />
      <div className="flex items-end gap-2">
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.AddAttachment asChild>
            <TooltipIconButton
              tooltip={t.chatAttachFile}
              side="top"
              variant="ghost"
              className="size-auto shrink-0 rounded-lg p-3 text-book-ink-muted hover:bg-book-bg-secondary hover:text-book-ink-primary"
            >
              <Paperclip className="size-5" />
            </TooltipIconButton>
          </ComposerPrimitive.AddAttachment>
        </AuiIf>
        <ComposerPrimitive.Input
          placeholder={placeholder}
          rows={1}
          autoFocus
          aria-label={placeholder}
          className="max-h-48 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-3 text-chat text-book-ink-primary outline-none placeholder:text-book-ink-muted"
        />
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <Button
              variant="ink"
              type="button"
              aria-label={t.conversationSendMessage}
              className="size-auto shrink-0 p-3 shadow-sm disabled:opacity-50"
            >
              <Send className="size-5" />
            </Button>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button
              variant="ink"
              type="button"
              aria-label={t.writingStop}
              className={cn(
                'size-auto shrink-0 border border-book-danger-border bg-book-danger-light p-3 shadow-sm',
                '!text-book-danger hover:bg-book-danger',
              )}
            >
              <Square className="size-5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
};

const ComposerAttachmentPreview: FC = () => {
  const { t } = useLocale();
  return (
    <AttachmentPrimitive.Root className="flex max-w-full items-center gap-2 rounded-md border border-book-border bg-book-bg-secondary/60 px-2.5 py-1.5 text-xs text-book-ink-secondary">
      <FileText className="size-3.5 shrink-0 text-book-ink-muted" />
      <span className="min-w-0 flex-1 truncate">
        <AttachmentPrimitive.Name />
      </span>
      <AttachmentPrimitive.Remove asChild>
        <TooltipIconButton
          tooltip={t.chatRemoveAttachment}
          side="top"
          variant="ghost"
          className="size-auto shrink-0 rounded p-1 text-book-ink-muted hover:bg-book-bg-card hover:text-book-danger"
        >
          <X className="size-3.5" />
        </TooltipIconButton>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

const MessageAttachmentPreview: FC = () => {
  return (
    <AttachmentPrimitive.Root className="mb-2 inline-flex max-w-full items-center gap-2 rounded-md border border-book-border bg-book-bg-secondary/70 px-2.5 py-1.5 text-xs text-book-ink-secondary">
      <FileText className="size-3.5 shrink-0 text-book-ink-muted" />
      <span className="min-w-0 truncate">
        <AttachmentPrimitive.Name />
      </span>
    </AttachmentPrimitive.Root>
  );
};
