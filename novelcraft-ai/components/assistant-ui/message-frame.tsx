'use client';

import { type ReactNode } from 'react';
import { User } from 'lucide-react';

import { NovelistAvatar } from '@/components/NovelistAvatar';
import { cn } from '@/lib/utils';

interface AssistantMessageFrameProps {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function AssistantMessageFrame({
  children,
  actions,
  className,
  contentClassName,
}: AssistantMessageFrameProps) {
  return (
    <div className={cn('group flex gap-2 sm:gap-4', className)}>
      <div className="mt-1 flex size-8 shrink-0 items-center justify-center">
        <NovelistAvatar className="size-8" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            'book-ink-border rounded-lg rounded-tl-sm border border-book-border bg-book-bg-card px-4 py-3 text-chat text-book-ink-primary shadow-sm sm:px-6 sm:py-5',
            contentClassName,
          )}
        >
          {children}
        </div>
        {actions}
      </div>
    </div>
  );
}

interface AssistantMarkdownFrameProps {
  children: ReactNode;
}

export function AssistantMarkdownFrame({ children }: AssistantMarkdownFrameProps) {
  return (
    <div className="markdown-body prose prose-zinc max-w-none prose-headings:font-serif prose-p:font-serif prose-p:text-prose-ui prose-p:leading-loose prose-strong:font-sans prose-pre:bg-zinc-800 prose-pre:text-zinc-100">
      {children}
    </div>
  );
}

interface UserMessageFrameProps {
  children: ReactNode;
}

export function UserMessageFrame({ children }: UserMessageFrameProps) {
  return (
    <div className="flex flex-row-reverse gap-2 sm:gap-4">
      <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-book-bg-secondary text-book-ink-secondary">
        <User className="size-4" />
      </div>
      <div className="max-w-[80%] whitespace-pre-wrap rounded-lg rounded-tr-sm bg-book-ink-primary px-4 py-3 font-sans text-chat text-book-bg-primary shadow-sm sm:px-6 sm:py-5">
        {children}
      </div>
    </div>
  );
}
