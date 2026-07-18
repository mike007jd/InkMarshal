'use client';

import { Sparkles, Copy, PenLine, RefreshCw } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';

interface SelectionToolbarProps {
  position: { top: number; left: number };
  onAIEdit: () => void;
  onCopy: () => void;
  onContinue: () => void;
  onRewrite: () => void;
  isLoading?: boolean;
}

export function SelectionToolbar({ position, onAIEdit, onCopy, onContinue, onRewrite, isLoading }: SelectionToolbarProps) {
  const { t } = useLanguage();

  return (
    <div
      className="fixed z-50 flex items-center gap-1 rounded-lg bg-book-bg-card border border-book-border shadow-lg p-1 animate-menu-in"
      style={{ top: position.top - 44, left: position.left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Button
        variant="unstyled"
        size="unstyled"
        type="button"
        onClick={onAIEdit}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-book-gold hover:bg-book-gold/10 transition-colors"
      >
        <Sparkles className="h-3.5 w-3.5" />
        {t.aiEdit}
      </Button>

      <div className="w-px h-5 bg-book-border" />

      <Button
        variant="unstyled"
        size="unstyled"
        type="button"
        onClick={onContinue}
        disabled={isLoading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-book-ink-secondary hover:bg-book-bg-secondary transition-colors disabled:opacity-50"
      >
        <PenLine className="h-3.5 w-3.5" />
        {t.aiContinue}
      </Button>

      <div className="w-px h-5 bg-book-border" />

      <Button
        variant="unstyled"
        size="unstyled"
        type="button"
        onClick={onRewrite}
        disabled={isLoading}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-book-ink-secondary hover:bg-book-bg-secondary transition-colors disabled:opacity-50"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t.aiRewrite}
      </Button>

      <div className="w-px h-5 bg-book-border" />

      <Button
        variant="unstyled"
        size="unstyled"
        type="button"
        onClick={onCopy}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-book-ink-secondary hover:bg-book-bg-secondary transition-colors"
      >
        <Copy className="h-3.5 w-3.5" />
        {t.copyText}
      </Button>
    </div>
  );
}
