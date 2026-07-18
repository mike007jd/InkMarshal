'use client';

import { useState, useCallback, forwardRef } from 'react';
import { Send, X, Pin, SlidersHorizontal } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { StopStreamingButton } from '@/components/ui/StopStreamingButton';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CreativityPicker } from './writing/CreativityPicker';
import { StylePicker } from './writing/StylePicker';
import type { CreativityLevel } from '@/lib/ai/generation-presets';

interface EditChatboxProps {
  onSend: (instruction: string) => void;
  isLoading: boolean;
  /** True while the AI Edit response is streaming back. Send button becomes Stop. */
  isStreaming?: boolean;
  /** Abort the in-flight edit stream. Called when the Send-turned-Stop is clicked. */
  onStop?: () => void;
  selectedText?: string;
  onClearSelection?: () => void;
  /** Optional creativity picker — when both are supplied a small segmented
   *  control is rendered next to the selected-text badge so the user can
   *  re-pin the level for the next send without scrolling to the toolbar. */
  creativity?: CreativityLevel;
  onCreativityChange?: (next: CreativityLevel) => void;
  creativitySyncFailed?: boolean;
  /** Wave 4 commit F: optional style picker. Renders inline next to the
   *  creativity picker when `novelId` is supplied. */
  novelId?: string;
  styleId?: string | null;
  onStyleChange?: (next: string | null) => void;
}

export const EditChatbox = forwardRef<HTMLInputElement, EditChatboxProps>(
  function EditChatbox({
    onSend, isLoading, isStreaming, onStop, selectedText, onClearSelection,
    creativity, onCreativityChange, creativitySyncFailed,
    novelId, styleId, onStyleChange,
  }, ref) {
    const { t } = useLanguage();
    const [input, setInput] = useState('');

    const handleSend = useCallback(() => {
      const text = input.trim();
      if (!text || isLoading) return;
      onSend(text);
      setInput('');
    }, [input, isLoading, onSend]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    }, [handleSend]);

    const hasGenerationOptions = Boolean(
      (creativity && onCreativityChange)
      || (novelId && onStyleChange),
    );

    return (
      <div className="border-t border-book-border bg-book-bg-card p-3">
        {selectedText && (
          <div className="mb-2 flex items-center">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-book-gold/30 bg-book-gold/10 px-2.5 py-1 text-xs text-book-gold">
              <Pin className="h-3 w-3" />
              {t.selectedNChars.replace('{n}', String(selectedText.length))}
              <Button
                variant="unstyled"
                size="unstyled"
                type="button"
                onClick={onClearSelection}
                className="ml-1 hover:text-book-ink-primary"
                aria-label={t.clearTextSelection}
              >
                <X className="h-3 w-3" />
              </Button>
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Input
            variant="boxed"
            ref={ref}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t.editInstruction}
            disabled={isLoading}
            className="flex-1 min-w-0 px-3 py-2 text-sm font-serif bg-book-bg-secondary rounded-lg placeholder:text-book-ink-muted focus:border-book-gold disabled:opacity-50"
          />
          {hasGenerationOptions && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t.aiRewriteOptions}
                  title={t.aiRewriteOptions}
                  className="shrink-0"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto max-w-[min(28rem,calc(100vw-2rem))] border-book-border bg-book-bg-card p-3">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
                  {t.aiRewriteOptions}
                </div>
                <div className="flex flex-col items-start gap-3">
              {novelId && onStyleChange && (
                <StylePicker novelId={novelId} selectedStyleId={styleId ?? null} onSelect={onStyleChange} />
              )}
              {creativity && onCreativityChange && (
                <CreativityPicker
                  value={creativity}
                  onChange={onCreativityChange}
                  size="sm"
                  syncFailed={creativitySyncFailed}
                />
              )}
                </div>
              </PopoverContent>
            </Popover>
          )}
          {isStreaming && onStop ? (
            <StopStreamingButton
              onStop={onStop}
              label={t.writingStop}
              iconSize="md"
            />
          ) : (
            <Button
              variant="unstyled"
              size="unstyled"
              type="button"
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className="shrink-0 inline-flex items-center gap-1.5 bg-book-gold/10 border border-book-gold/40 px-4 py-2 text-xs font-medium text-book-gold transition hover:bg-book-gold/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isLoading ? <Spinner size="sm" /> : <Send className="h-3.5 w-3.5" />}
              {t.sendEdit}
            </Button>
          )}
        </div>
      </div>
    );
  }
);
