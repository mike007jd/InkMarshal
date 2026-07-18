'use client';

import { useMemo, useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Pages a flat edits array for the unification UI. Designed for long novels
 * where a single batch can run 500+ edits — rendering them all at once
 * deflates virtualised lists and overwhelms the user.
 *
 * Stable: when the input array changes, the pager keeps the user on the
 * existing page (clamped to the new total) so a re-fetch doesn't snap to
 * page 0.
 */
export function useUnificationPager<T>(items: T[], pageSize: number = 20) {
  const [page, setPage] = useState(0);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const safePage = Math.min(page, pageCount - 1);

  const start = safePage * pageSize;
  const end = Math.min(total, start + pageSize);
  const pageItems = useMemo(() => items.slice(start, end), [items, start, end]);

  const goTo = useCallback((target: number) => {
    setPage(Math.max(0, Math.min(pageCount - 1, target)));
  }, [pageCount]);

  const next = useCallback(() => goTo(safePage + 1), [goTo, safePage]);
  const prev = useCallback(() => goTo(safePage - 1), [goTo, safePage]);

  return {
    page: safePage,
    pageCount,
    pageSize,
    total,
    pageItems,
    start,
    end,
    goTo,
    next,
    prev,
    isFirst: safePage === 0,
    isLast: safePage === pageCount - 1,
  };
}

interface UnificationPagerControlsProps {
  page: number;
  pageCount: number;
  start: number;
  end: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
  onPrev: () => void;
  onNext: () => void;
  labels: {
    previous: string;
    next: string;
    showing: (start: number, end: number, total: number) => string;
  };
}

export function UnificationPagerControls(props: UnificationPagerControlsProps) {
  const { page, pageCount, start, end, total, isFirst, isLast, onPrev, onNext, labels } = props;
  if (pageCount <= 1) return null;
  return (
    <nav className="mt-3 flex items-center justify-between gap-2 text-xs text-book-ink-secondary">
      <span>{labels.showing(start + 1, end, total)}</span>
      <div className="flex items-center gap-2">
        <Button
          variant="unstyled"
          size="unstyled"
          type="button"
          onClick={onPrev}
          disabled={isFirst}
          className="border border-book-border px-2 py-0.5 text-book-ink-primary transition hover:bg-book-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {labels.previous}
        </Button>
        <span className="font-mono">{page + 1} / {pageCount}</span>
        <Button
          variant="unstyled"
          size="unstyled"
          type="button"
          onClick={onNext}
          disabled={isLast}
          className="border border-book-border px-2 py-0.5 text-book-ink-primary transition hover:bg-book-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {labels.next}
        </Button>
      </div>
    </nav>
  );
}
