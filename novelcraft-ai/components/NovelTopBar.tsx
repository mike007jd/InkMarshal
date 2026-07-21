'use client';

import { useEffect, useRef } from 'react';
import { BookOpenText, ListChecks, MessageSquare, Pencil } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import type { NovelStage } from '@/lib/novel-stages';
import type { NovelView } from '@/lib/novel-workspace-view';

interface NovelTopBarProps {
  novel: { title?: string; genre?: string; stage?: NovelStage } | null;
  editingTitle: boolean;
  titleDraft: string;
  setTitleDraft: (v: string) => void;
  setEditingTitle: (v: boolean) => void;
  handleTitleSave: () => void;
  view: NovelView;
  setView: (view: NovelView) => void;
  assistantActive?: boolean;
  manuscriptActive?: boolean;
}

export function NovelTopBar({
  novel,
  editingTitle,
  titleDraft,
  setTitleDraft,
  setEditingTitle,
  handleTitleSave,
  view,
  setView,
  assistantActive = false,
  manuscriptActive = false,
}: NovelTopBarProps) {
  const { t } = useLanguage();
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Mode tabs live in the top bar now (the old left rail + mobile bar were
  // dropped): one toolbar row reuses the previously-empty header space and
  // hands the manuscript/chat column ~144px of reclaimed width.
  const modeItems: ReadonlyArray<{ view: NovelView; label: string; Icon: typeof MessageSquare }> = [
    { view: 'agent', label: t.agentMode, Icon: MessageSquare },
    { view: 'story-deck', label: t.storyDeckMode, Icon: ListChecks },
    { view: 'read-edit', label: t.readEditMode, Icon: BookOpenText },
  ];

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  return (
    <div className="border-b border-book-border bg-book-bg-primary shrink-0 z-10">
      <div className="h-12 flex items-center gap-3 px-3 lg:px-5">
        <div className="flex min-w-0 items-center gap-2">
          {editingTitle ? (
            <Input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleTitleSave();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              placeholder={t.titlePlaceholder}
              className="min-w-0 max-w-[240px] px-1 py-0.5 font-serif text-base tracking-tight text-book-ink-primary lg:text-lg"
            />
          ) : (
            <Button
              type="button"
              variant="unstyled"
              size="unstyled"
              onClick={() => { setTitleDraft(novel?.title || ''); setEditingTitle(true); }}
              className="group flex min-w-0 items-center gap-2 cursor-pointer"
              title={t.editTitle}
            >
              <h1 className="truncate text-left font-serif text-base tracking-tight text-book-ink-primary lg:text-lg">
                {novel?.title || t.untitledNovel}
              </h1>
              <Pencil className="w-3.5 h-3.5 text-book-ink-muted opacity-0 group-hover:opacity-100 transition-feedback shrink-0" />
            </Button>
          )}
          {novel?.genre && !editingTitle && (
            <span className="hidden max-w-[9rem] truncate text-xs font-serif italic text-book-ink-muted md:inline-block">{novel.genre}</span>
          )}
        </div>

        <nav
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-book-bg-secondary p-1"
          aria-label={t.novelModeNav}
        >
          {modeItems.map(({ view: itemView, label, Icon }) => {
            const active = view === itemView;
            const busy = itemView === 'agent'
              ? assistantActive
              : itemView === 'read-edit' && manuscriptActive;
            return (
              <Button
                key={itemView}
                type="button"
                variant="unstyled"
                size="unstyled"
                onClick={() => setView(itemView)}
                title={label}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex items-center gap-1.5 rounded px-2.5 py-1 text-sm font-medium transition-feedback',
                  active
                    ? 'bg-book-bg-card text-book-ink-primary shadow-sm'
                    : 'text-book-ink-muted hover:bg-book-bg-card/60 hover:text-book-ink-primary',
                ].join(' ')}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="hidden whitespace-nowrap sm:inline">{label}</span>
                {busy ? (
                  <span role="status" aria-label={t.activityActive.replace('{label}', label)}>
                    <Spinner size="sm" className="shrink-0 text-book-gold" />
                  </span>
                ) : null}
              </Button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
