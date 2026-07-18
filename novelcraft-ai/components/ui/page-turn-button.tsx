import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PageTurnButtonProps {
  /** Which way the book turns. Picks the chevron and is the control's identity. */
  direction: 'prev' | 'next';
  onClick: () => void;
  disabled?: boolean;
  /** Localized accessible name ("Previous page" / "Next page"). */
  label: string;
  /** Chevron scale — the landing mockup runs a touch larger than the studio rail. */
  iconSize?: 'sm' | 'md';
  className?: string;
}

/**
 * The book page-turn control. This is the single semantic exception to the
 * "clickable controls inherit the canonical Button radius" rule: page turning
 * is a round affordance on the book itself, and both the landing mockup and the
 * manuscript reading view render the same contract instead of re-deriving it.
 */
export function PageTurnButton({
  direction,
  onClick,
  disabled = false,
  label,
  iconSize = 'sm',
  className,
}: PageTurnButtonProps) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <Button
      type="button"
      variant="unstyled"
      size="unstyled"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-shape="page-turn"
      className={cn(
        'inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-book-border bg-book-bg-card/70 text-book-ink-secondary transition hover:bg-book-bg-card disabled:cursor-not-allowed disabled:opacity-30',
        className,
      )}
    >
      <Icon className={iconSize === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
    </Button>
  );
}
