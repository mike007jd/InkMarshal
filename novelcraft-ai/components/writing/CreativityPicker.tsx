'use client';

// Three-button segmented control for the creativity knob. Kept dumb on
// purpose: it owns no state, no fetch, no localStorage. Owners (Manuscript
// editing view, EditChatbox, ChatArea) handle persistence and pass the
// current value + onChange. The shared shape lets us reuse one component
// across the writing surface and ai-chat surface without flag soup.

import { useLanguage } from '@/components/LanguageProvider';
import {
  CREATIVITY_LEVELS,
  type CreativityLevel,
} from '@/lib/ai/generation-presets';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export interface CreativityPickerProps {
  value: CreativityLevel;
  onChange: (next: CreativityLevel) => void;
  /** Compact sizing for inline chat composers (smaller pad + font). */
  size?: 'sm' | 'md';
  className?: string;
  /** Hide the leading "Creativity" label (used when space is tight). */
  hideLabel?: boolean;
  syncFailed?: boolean;
}

export function CreativityPicker({
  value,
  onChange,
  size = 'md',
  className,
  hideLabel = false,
  syncFailed = false,
}: CreativityPickerProps) {
  const { t } = useLanguage();

  const labels: Record<CreativityLevel, string> = {
    conservative: t.creativityConservative,
    balanced: t.creativityBalanced,
    wild: t.creativityWild,
  };

  const pad = size === 'sm' ? 'px-2 py-1 text-2xs' : 'px-2.5 py-1.5 text-xs';

  return (
    <div
      className={[
        'inline-flex items-center gap-2',
        className ?? '',
      ].join(' ')}
      data-testid="creativity-picker"
    >
      {!hideLabel && (
        <span className={[
          'text-book-ink-muted font-medium tracking-wide',
          size === 'sm' ? 'text-2xs' : 'text-xs',
        ].join(' ')}>
          {t.creativityLabel}
        </span>
      )}
      <ToggleGroup
        type="single"
        aria-label={t.creativityLabel}
        value={value}
        onValueChange={next => {
          if (CREATIVITY_LEVELS.includes(next as CreativityLevel)) {
            onChange(next as CreativityLevel);
          }
        }}
        className="inline-flex items-center rounded-md border border-book-border bg-book-bg-card overflow-hidden"
      >
        {CREATIVITY_LEVELS.map(level => {
          const active = level === value;
          return (
            <ToggleGroupItem
              key={level}
              value={level}
              data-testid={`creativity-${level}`}
              className={[
                pad,
                'font-medium transition-colors border-r border-book-border last:border-r-0',
                active
                  ? 'bg-book-gold/15 text-book-gold'
                  : 'text-book-ink-muted hover:text-book-ink-secondary hover:bg-book-bg-secondary',
              ].join(' ')}
            >
              {labels[level]}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {syncFailed && (
        <span className="text-2xs text-book-danger" role="status">
          {t.creativitySyncFailed}
        </span>
      )}
    </div>
  );
}
