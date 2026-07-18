'use client';

import { useLanguage } from '@/components/LanguageProvider';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';

export function EmptyChatInterviewGuide() {
  const { t } = useLanguage();

  return (
    <Empty
      data-testid="empty-chat-interview-guide"
      className="mx-auto h-full w-full max-w-2xl border-0 p-0 px-6 py-12 md:p-0 md:px-6 md:py-12"
    >
      <EmptyHeader className="max-w-xl gap-3">
        <EmptyTitle className="font-serif text-2xl font-normal tracking-normal text-book-ink-primary">
          {t.agentEmptyThreadTitle}
        </EmptyTitle>
        <EmptyDescription className="max-w-xl font-serif text-sm leading-6 text-book-ink-muted">
          {t.agentEmptyThreadPlaceholder}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
