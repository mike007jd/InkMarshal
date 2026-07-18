'use client';

// Wave 2 commit E — UI pill rendered in place of a parsed `[[wikilink]]`.
//
// Two visual states:
//   * Resolved → small inline link-style pill that calls `onJump(resolvedId)`.
//   * Unresolved → muted "未链接草稿" pill that calls `onCreateDraft(raw)` so
//     the user can spawn a quick KnowledgeEntryForm prefilled with `title=raw`.
//
// We deliberately keep the visual very small (text-2xs / inline-block) so a
// long description peppered with wikilinks stays readable.

import { Link as LinkIcon, FilePlus2 } from 'lucide-react';

import { useLocale } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';

interface WikilinkPillProps {
  raw: string;
  resolvedId?: string;
  /** Called when a resolved pill is clicked. */
  onJump?: (entryId: string) => void;
  /** Called when an unresolved pill is clicked. */
  onCreateDraft?: (raw: string) => void;
}

export function WikilinkPill({ raw, resolvedId, onJump, onCreateDraft }: WikilinkPillProps) {
  const { t } = useLocale();
  if (resolvedId) {
    return (
      <Button
        variant="unstyled"
        size="unstyled"
        type="button"
        onClick={() => onJump?.(resolvedId)}
        className="inline-flex items-center gap-1 whitespace-normal border border-book-border bg-book-bg-secondary px-1.5 py-0.5 text-2xs font-medium text-book-ink-primary transition-colors hover:bg-book-bg-card"
        title={raw}
      >
        <LinkIcon className="h-2.5 w-2.5 text-book-gold" />
        <span>{raw}</span>
      </Button>
    );
  }
  return (
    <Button
      variant="unstyled"
      size="unstyled"
      type="button"
      onClick={() => onCreateDraft?.(raw)}
      className="inline-flex items-center gap-1 whitespace-normal border border-dashed border-book-border bg-book-bg-secondary px-1.5 py-0.5 text-2xs font-medium text-book-ink-muted transition-colors hover:text-book-ink-primary"
      title={t.wikilinkCreateDraft as string}
    >
      <FilePlus2 className="h-2.5 w-2.5" />
      <span>
        {raw}
        <span className="ml-1 italic">{t.wikilinkUnresolved as string}</span>
      </span>
    </Button>
  );
}
