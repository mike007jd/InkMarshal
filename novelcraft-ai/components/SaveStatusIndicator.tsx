'use client';

import { useMemo } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/** Four states for the manuscript auto-save pipeline.
 *  - `idle`   : nothing to show (initial / clean)
 *  - `saving` : a debounced flush is in-flight
 *  - `saved`  : the last flush succeeded; surface lastSavedAt
 *  - `failed` : the last flush hit a network / server error; show retry CTA */
export type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

interface SaveStatusIndicatorProps {
  state: SaveState;
  /** Timestamp (epoch ms) of the most recent successful save. Required when
   *  `state === 'saved'`; ignored otherwise. */
  lastSavedAt?: number | null;
  /** Invoked when the user clicks "retry" while in the `failed` state. */
  onRetry?: () => void;
  /** Compact density override — used by the mobile top bar where space is
   *  tight. Default = `comfortable`. */
  density?: 'comfortable' | 'compact';
  className?: string;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  // Locale-formatted HH:MM, no seconds. Browser locale is fine — the i18n
  // string just embeds it via `{time}`.
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Visual save-state pip + label. `idle` collapses to null so the host
 *  layout doesn't reserve dead space. */
export function SaveStatusIndicator({
  state,
  lastSavedAt,
  onRetry,
  density = 'comfortable',
  className = '',
}: SaveStatusIndicatorProps) {
  const { t } = useLanguage();

  const savedLabel = useMemo(() => {
    if (state !== 'saved' || !lastSavedAt) return '';
    return t.saveStateSaved.replace('{time}', formatTime(lastSavedAt));
  }, [state, lastSavedAt, t.saveStateSaved]);

  if (state === 'idle') return null;

  const sizeClass = density === 'compact' ? 'text-2xs' : 'text-xs';
  const iconSize = density === 'compact' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const gap = density === 'compact' ? 'gap-1' : 'gap-1.5';

  if (state === 'saving') {
    return (
      <div
        className={`flex items-center ${gap} text-book-ink-muted ${sizeClass} ${className}`}
        role="status"
        aria-live="polite"
      >
        <Spinner size={density === 'compact' ? 'sm' : 'md'} />
        <span>{t.saveStateSaving}</span>
      </div>
    );
  }

  if (state === 'saved') {
    return (
      <div
        className={`flex items-center ${gap} text-book-ink-muted ${sizeClass} ${className}`}
        role="status"
        aria-live="polite"
      >
        <Check className={`${iconSize} text-book-success`} />
        <span>{savedLabel}</span>
      </div>
    );
  }

  // state === 'failed'
  return (
    <div
      className={`flex items-center ${gap} text-book-danger ${sizeClass} ${className}`}
      role="alert"
    >
      <AlertTriangle className={iconSize} />
      <span>{t.saveStateFailed}</span>
      {onRetry && (
        <Button
          variant="unstyled"
          size="unstyled"
          type="button"
          onClick={onRetry}
          className="ml-1 underline-offset-2 hover:underline font-medium"
        >
          {t.toastRetry}
        </Button>
      )}
    </div>
  );
}
