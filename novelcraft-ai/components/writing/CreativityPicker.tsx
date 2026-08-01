'use client';

// Three-button segmented control for the creativity knob. Kept dumb on
// purpose regarding persistence: it owns no fetch and no localStorage. Owners
// (Manuscript editing view, EditChatbox, ChatArea) handle persistence and pass
// the current value + onChange. When the active capability binding points at a
// curated model with fixed sampling (metadata.requestCompat.temperature), the
// ineffective controls are replaced by an automatic-optimization notice.

import { useEffect, useState } from 'react';

import { useLanguage } from '@/components/LanguageProvider';
import {
  CREATIVITY_LEVELS,
  type CreativityLevel,
} from '@/lib/ai/generation-presets';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  getBindingForRole,
  getConnection,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import type { CapabilityRole } from '@/lib/model-supply/types';
import { modelUsesFixedSampling } from '@/lib/providers';

export interface CreativityPickerProps {
  value: CreativityLevel;
  onChange: (next: CreativityLevel) => void;
  /** Compact sizing for inline chat composers (smaller pad + font). */
  size?: 'sm' | 'md';
  className?: string;
  /** Hide the leading "Creativity" label (used when space is tight). */
  hideLabel?: boolean;
  syncFailed?: boolean;
  /**
   * Capability role whose bound model drives fixed-sampling detection.
   * Defaults to `draft` (chat). Pass `rewrite` for polish surfaces.
   */
  role?: CapabilityRole;
}

function bindingUsesFixedSampling(role: CapabilityRole): boolean {
  const binding = getBindingForRole(role);
  if (!binding) return false;
  const connection = getConnection(binding.connectionId);
  if (!connection) return false;
  return modelUsesFixedSampling(connection.baseUrl, binding.modelId);
}

export function CreativityPicker({
  value,
  onChange,
  size = 'md',
  className,
  hideLabel = false,
  syncFailed = false,
  role = 'draft',
}: CreativityPickerProps) {
  const { t } = useLanguage();
  const [fixedSampling, setFixedSampling] = useState(() => bindingUsesFixedSampling(role));

  useEffect(() => {
    const recompute = () => setFixedSampling(bindingUsesFixedSampling(role));
    recompute();
    return subscribeConnectionsStore(recompute);
  }, [role]);

  const labels: Record<CreativityLevel, string> = {
    conservative: t.creativityConservative,
    balanced: t.creativityBalanced,
    wild: t.creativityWild,
  };

  const pad = size === 'sm' ? 'px-2 py-1 text-2xs' : 'px-2.5 py-1.5 text-xs';

  if (fixedSampling) {
    return (
      <div
        className={[
          'inline-flex items-center gap-2',
          className ?? '',
        ].join(' ')}
        data-testid="creativity-picker-automatic"
      >
        {!hideLabel && (
          <span className={[
            'text-book-ink-muted font-medium tracking-wide',
            size === 'sm' ? 'text-2xs' : 'text-xs',
          ].join(' ')}>
            {t.creativityLabel}
          </span>
        )}
        <span
          className={[
            pad,
            'rounded-md border border-book-border bg-book-bg-card text-book-ink-secondary font-medium',
          ].join(' ')}
          title={t.creativityAutomaticHint}
        >
          {t.creativityAutomatic}
        </span>
        {syncFailed && (
          <span className="text-2xs text-book-danger" role="status">
            {t.creativitySyncFailed}
          </span>
        )}
      </div>
    );
  }

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
