'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import React, { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react';
import { BookOpen, ArrowRight, Scroll } from 'lucide-react';

import {
  findPageIndexForSourceOffset,
  paginateManuscript,
  type ManuscriptPage,
} from '@/lib/pagination';
import { FLIPBOOK_LAYOUT } from '@/lib/flipbook-geometry';
import { useLanguage } from '@/components/LanguageProvider';
import { parsePositiveIntegerParam } from '@/lib/route-params';
import { useToast } from '@/components/Toast';
import { useDynamicPagination } from '@/hooks/useDynamicPagination';
import { useGlobalHotkey } from '@/hooks/useGlobalHotkey';
import type { ManuscriptChapter } from './ManuscriptShell';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { PageTurnButton } from '@/components/ui/page-turn-button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

// Dynamic import — react-pageflip accesses DOM at module scope
const HTMLFlipBook = dynamic(() => import('react-pageflip'), { ssr: false });

export type ReadingLayout = 'continuous' | 'flipbook';

/** External chapter-selection token. `seq` increments on every explicit
 *  user-driven chapter pick (sidebar, jump input, deep link, search result)
 *  so the flipbook can tell "jump to this chapter's first page" apart from
 *  the passive activeChapter sync produced by page flips. */
export interface ChapterSelection {
  chapterNumber: number;
  seq: number;
}

interface ManuscriptReadingViewProps {
  novelId: string;
  chapters: ManuscriptChapter[]; // already combined with live chapter by parent
  liveChapter: ManuscriptChapter | null;
  mode: 'writing-live' | 'reading-review';
  activeChapter: number | null;
  onActiveChapterChange?: (chapterNumber: number) => void;
  /** Explicit user chapter navigation (jump input). Distinct from the passive
   *  flip/scroll sync above so the parent can route it as an external
   *  selection that repositions the book and suspends live-follow. */
  onChapterJump?: (chapterNumber: number) => void;
  chapterSelection?: ChapterSelection | null;
  layout: ReadingLayout;
  onLayoutChange: (layout: ReadingLayout) => void;
}

/* ---------- Decorative ornaments ---------- */

function ChapterTailOrnament({ label }: { label: string }) {
  return (
    <div className="mt-10 flex flex-col items-center gap-3 text-book-gold-dark/80">
      <svg viewBox="0 0 120 24" fill="none" className="w-32 h-5 opacity-70">
        <path d="M2 12 Q30 2, 60 12 Q90 22, 118 12" stroke="currentColor" strokeWidth="0.7" fill="none" />
        <circle cx="60" cy="12" r="2.5" fill="currentColor" />
        <circle cx="60" cy="12" r="5" fill="none" stroke="currentColor" strokeWidth="0.4" opacity="0.5" />
        <path d="M40 12 L52 12" stroke="currentColor" strokeWidth="0.5" />
        <path d="M68 12 L80 12" stroke="currentColor" strokeWidth="0.5" />
      </svg>
      <span className="font-hand text-base tracking-display uppercase opacity-70">
        {label}
      </span>
    </div>
  );
}

function FlyleafOrnament({ heading, hint }: { heading: string; hint: string }) {
  return (
    <div className="flex h-full items-center justify-center text-center">
      <div className="px-6">
        <svg viewBox="0 0 60 60" fill="none" className="mx-auto w-14 h-14 text-book-gold/60 mb-4">
          <circle cx="30" cy="30" r="22" stroke="currentColor" strokeWidth="0.6" />
          <circle cx="30" cy="30" r="14" stroke="currentColor" strokeWidth="0.4" />
          <path d="M30 8 L30 52 M8 30 L52 30" stroke="currentColor" strokeWidth="0.3" opacity="0.5" />
          <circle cx="30" cy="30" r="2" fill="currentColor" />
        </svg>
        <div className="font-hand text-2xl text-book-ink-primary italic mb-2">
          {heading}
        </div>
        <p className="font-serif text-xs leading-6 text-book-ink-muted max-w-[14rem] mx-auto">
          {hint}
        </p>
      </div>
    </div>
  );
}

/* ---------- Page content renderer (shared by flipbook) ---------- */

function ChapterPageContent({ page }: { page: ManuscriptPage | null }) {
  const { t } = useLanguage();

  if (!page) {
    return <FlyleafOrnament heading={t.manuscriptBlankPage} hint={t.manuscriptBlankHint} />;
  }

  const chapterLabel = t.manuscriptChapter.replace(
    '{num}',
    String(page.chapterNumber).padStart(2, '0'),
  );

  const showTail = page.isLastOfChapter && page.fillRatio < 0.7;

  return (
    <article className="flex h-full flex-col">
      {page.title && (
        <div className="mb-6 border-b border-book-border/70 pb-4">
          <div className="text-xs-tight font-semibold uppercase tracking-display text-book-gold">
            {chapterLabel}
          </div>
          <h3 className="mt-3 font-serif text-chapter-title text-book-ink-primary">
            {page.title}
          </h3>
        </div>
      )}
      <div className="manuscript-prose font-serif text-book-ink-secondary">
        <p className="whitespace-pre-wrap">{page.content}</p>
      </div>
      {showTail && (
        <div className="mt-auto pt-6">
          <ChapterTailOrnament label={t.manuscriptChapterEnd ?? 'fin'} />
        </div>
      )}
    </article>
  );
}

/* ---------- FlipBook page wrapper (forwardRef required by react-pageflip) ---------- */

const FlipBookPage = React.memo(
  React.forwardRef<HTMLDivElement, { page: ManuscriptPage | null }>(
    ({ page }, ref) => (
      <div
        ref={ref}
        className="manuscript-page bg-book-bg-card px-9 py-7 h-full overflow-hidden"
      >
        <ChapterPageContent page={page} />
      </div>
    ),
  ),
);
FlipBookPage.displayName = 'FlipBookPage';

/* ---------- Empty state ---------- */

function EmptyManuscript({ novelId }: { novelId: string }) {
  const { t } = useLanguage();
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <Empty className="max-w-lg border border-book-border bg-book-bg-card p-10 text-left shadow-xl md:p-12">
        <EmptyHeader className="max-w-none items-start text-left">
          <EmptyMedia className="mb-7 flex h-16 w-16 items-center justify-center rounded-md border border-book-border bg-book-bg-secondary">
            <BookOpen className="h-9 w-9 text-book-gold" strokeWidth={1.5} />
          </EmptyMedia>
          <EmptyTitle className="mb-3 font-hand text-3xl font-normal tracking-normal text-book-ink-primary">
            {t.manuscriptEmptyTitle}
          </EmptyTitle>
          <EmptyDescription className="mb-0 max-w-sm font-serif text-sm leading-6 text-book-ink-muted">
            {t.manuscriptEmptyDesc}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="mt-8 max-w-none items-start">
          <Button asChild variant="outline" size="lg" className="border-book-gold text-book-gold-dark hover:border-book-gold-dark">
            <Link href={`/novel/${novelId}`}>
              {t.manuscriptEmptyAction}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/* ---------- Layout toolbar (segmented toggle + page nav + jump-to-chapter) ---------- */

interface LayoutToolbarProps {
  layout: ReadingLayout;
  onLayoutChange: (layout: ReadingLayout) => void;
  jumpInputRef: React.RefObject<HTMLInputElement | null>;
  onJump: (chapterNumber: number) => void;
  totalChapters: number;
  /** Flipbook page controls (prev / page info / next). Rendered by the
   *  flipbook only; the buttons are hidden at xl+ where the fixed side
   *  rails take over, the single page indicator stays. */
  pageNav?: React.ReactNode;
  /** Live-writing follow status for the aria-live announcement. Null when
   *  not in writing-live flipbook mode. */
  follow?: { suspended: boolean; remainingSec: number } | null;
}

function LayoutToolbar({ layout, onLayoutChange, jumpInputRef, onJump, totalChapters, pageNav, follow }: LayoutToolbarProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [jumpValue, setJumpValue] = useState('');

  const submit = () => {
    const trimmed = jumpValue.trim();
    if (!trimmed) return;
    const n = parsePositiveIntegerParam(trimmed);
    if (n == null || n > totalChapters) {
      toast(t.readingJumpInvalid, 'error');
      return;
    }
    onJump(n);
    setJumpValue('');
    jumpInputRef.current?.blur();
  };

  return (
    <div className="mb-2 shrink-0 flex flex-wrap items-center gap-2 px-1">
      <ToggleGroup
        type="single"
        value={layout}
        onValueChange={next => {
          if (next === 'continuous' || next === 'flipbook') {
            onLayoutChange(next);
          }
        }}
        className="flex rounded-md bg-book-bg-secondary p-0.5"
      >
        <ToggleGroupItem
          value="continuous"
          className={[
            'inline-flex items-center gap-1 rounded px-2 py-1 text-2xs font-medium uppercase tracking-label transition-feedback',
            layout === 'continuous'
              ? 'bg-book-bg-card text-book-ink-primary shadow-sm'
              : 'text-book-ink-muted hover:text-book-ink-primary',
          ].join(' ')}
          title={t.readingLayoutContinuous}
        >
          <Scroll className="h-3 w-3" />
          <span className="hidden sm:inline">{t.readingLayoutContinuous}</span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="flipbook"
          className={[
            'inline-flex items-center gap-1 rounded px-2 py-1 text-2xs font-medium uppercase tracking-label transition-feedback',
            layout === 'flipbook'
              ? 'bg-book-bg-card text-book-ink-primary shadow-sm'
              : 'text-book-ink-muted hover:text-book-ink-primary',
          ].join(' ')}
          title={t.readingLayoutFlipbook}
        >
          <BookOpen className="h-3 w-3" />
          <span className="hidden sm:inline">{t.readingLayoutFlipbook}</span>
        </ToggleGroupItem>
      </ToggleGroup>

      {follow && (
        <span
          role="status"
          aria-live="polite"
          className="inline-flex items-center gap-1.5 text-2xs font-medium text-book-ink-muted"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${follow.suspended ? 'bg-book-ink-muted' : 'bg-book-stage-writing'}`}
            aria-hidden
          />
          {follow.suspended
            ? t.readingFollowPaused.replace('{seconds}', String(follow.remainingSec))
            : t.readingFollowActive}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {pageNav}
        <Input
          ref={jumpInputRef}
          type="number"
          min={1}
          max={totalChapters || undefined}
          inputMode="numeric"
          value={jumpValue}
          onChange={e => setJumpValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t.readingJumpPlaceholder}
          aria-label={t.readingJumpPlaceholder}
          variant="boxed"
          className="w-32 px-2 py-1 text-2xs focus:border-book-gold"
        />
      </div>
    </div>
  );
}

/* ---------- Continuous reading view ---------- */

interface ContinuousReadingViewProps {
  chapters: ManuscriptChapter[];
  activeChapter: number | null;
  onActiveChapterChange?: (n: number) => void;
}

function ContinuousReadingView({ chapters, activeChapter, onActiveChapterChange }: ContinuousReadingViewProps) {
  const { t } = useLanguage();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<number, HTMLElement>>(new Map());
  // True while we're programmatically scrolling — suppresses the observer
  // updates that would otherwise flip activeChapter back to whatever's at the
  // viewport edge during the smooth scroll animation.
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSectionRef = useCallback((chapterNumber: number, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(chapterNumber, el);
    else sectionRefs.current.delete(chapterNumber);
  }, []);

  // Scroll to active chapter. Long-novel jumps (search/deep links) are
  // immediate so the observer cannot reclaim an in-between chapter before a
  // multi-screen smooth animation finishes; nearby navigation stays smooth.
  useEffect(() => {
    if (activeChapter == null) return;
    const el = sectionRefs.current.get(activeChapter);
    if (!el) return;
    const scroller = scrollerRef.current;
    const distance = scroller
      ? Math.abs(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
      : 0;
    const longJump = Boolean(scroller && distance > scroller.clientHeight * 2);
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
    el.scrollIntoView({ behavior: longJump ? 'auto' : 'smooth', block: 'start' });
    programmaticScrollTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, longJump ? 100 : 700);
  }, [activeChapter]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (programmaticScrollTimerRef.current) clearTimeout(programmaticScrollTimerRef.current);
    };
  }, []);

  // Observe section visibility → notify parent of active chapter
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      entries => {
        if (programmaticScrollRef.current) return;
        // Pick the section closest to the top that's currently visible.
        const visible = entries
          .filter(e => e.isIntersecting)
          .map(e => {
            const num = Number((e.target as HTMLElement).dataset.chapterNumber);
            return { num, top: e.boundingClientRect.top };
          })
          .filter(v => Number.isFinite(v.num))
          .sort((a, b) => a.top - b.top);
        if (visible.length > 0) {
          const top = visible[0].num;
          if (top !== activeChapter) onActiveChapterChange?.(top);
        }
      },
      {
        root: scroller,
        // top 100px band — section enters "active" once its header is near the
        // scroller's top edge.
        rootMargin: '0px 0px -75% 0px',
        threshold: 0,
      },
    );
    for (const el of sectionRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
    // Re-run when chapter list changes so newly-mounted sections get observed.
  }, [chapters.length, activeChapter, onActiveChapterChange]);

  if (chapters.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <FlyleafOrnament heading={t.manuscriptBlankPage} hint={t.manuscriptBlankHint} />
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="absolute inset-0 overflow-y-auto px-6 py-6 md:px-10 md:py-10"
    >
      <div className="mx-auto max-w-2xl space-y-12">
        {chapters.map(ch => {
          const chapterLabel = t.manuscriptChapter.replace(
            '{num}',
            String(ch.chapterNumber).padStart(2, '0'),
          );
          return (
            <section
              key={ch.id ?? `ch-${ch.chapterNumber}`}
              id={`ch-${ch.chapterNumber}`}
              data-chapter-number={ch.chapterNumber}
              ref={el => setSectionRef(ch.chapterNumber, el)}
              className="scroll-mt-2"
            >
              <div className="mb-5 border-b border-book-border/70 pb-3">
                <div className="text-xs-tight font-semibold uppercase tracking-display text-book-gold">
                  {chapterLabel}
                </div>
                <h3 className="mt-3 font-serif text-chapter-title text-book-ink-primary">
                  {ch.title}
                </h3>
              </div>
              <div className="manuscript-prose font-serif text-book-ink-secondary whitespace-pre-wrap">
                {ch.content || (
                  <span className="italic text-book-ink-muted">{t.manuscriptChapterEmpty}</span>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Flipbook reading view ---------- */

interface FlipbookReadingViewProps {
  novelId: string;
  chapters: ManuscriptChapter[];
  liveChapter: ManuscriptChapter | null;
  mode: 'writing-live' | 'reading-review';
  activeChapter: number | null;
  onActiveChapterChange?: (n: number) => void;
  chapterSelection?: ChapterSelection | null;
  toolbar: {
    layout: ReadingLayout;
    onLayoutChange: (layout: ReadingLayout) => void;
    jumpInputRef: React.RefObject<HTMLInputElement | null>;
    onJump: (chapterNumber: number) => void;
    totalChapters: number;
  };
}

const FLIP_TIME_MS = 400;
/** How long a user page-turn gesture suspends live-writing auto-follow. */
const FOLLOW_SUSPEND_MS = 5000;

interface PageFlipController {
  update(): void;
  flipNext(): void;
  flipPrev(): void;
  turnToNextPage(): void;
  turnToPrevPage(): void;
  turnToPage(page: number): void;
  getCurrentPageIndex(): number;
}

function FlipbookReadingView({
  novelId,
  chapters,
  liveChapter,
  mode,
  activeChapter,
  onActiveChapterChange,
  chapterSelection,
  toolbar,
}: FlipbookReadingViewProps) {
  const bookRef = useRef<{ pageFlip(): PageFlipController | null } | null>(null);
  const updateBookLayout = useCallback(() => {
    bookRef.current?.pageFlip()?.update();
  }, []);

  // --- Dynamic pagination: measures ONLY the real book viewport below (the
  // centre column between the side rails). The toolbar and rails live outside
  // the measured element, so no fixed "reserve" guess is needed; the
  // ResizeObserver inside the hook re-paginates on window/zoom changes.
  const { containerRef, charsPerPage, titleReserve, geometry } = useDynamicPagination({
    lineHeight: 30,
    charsPerLine: 42,
    titleReserveLines: 5,
    paddingY: 56,
    paddingX: 72,
    averageCharWidth: 9,
    onContainerResize: updateBookLayout,
  });

  const bookOverlayStyle = useMemo<React.CSSProperties>(() => ({
    left: geometry.left,
    top: geometry.top,
    width: geometry.spreadWidth,
    height: geometry.pageHeight,
  }), [geometry]);

  const pages = useMemo(
    () => paginateManuscript(chapters, { charsPerPage, chapterTitleReserve: titleReserve }),
    [chapters, charsPerPage, titleReserve],
  );

  const hasContent = pages.length > 0;

  const displayPages = useMemo(() => {
    const result: (ManuscriptPage | null)[] = [...pages];
    if (result.length === 0) {
      result.push(null);
      if (geometry.spreadPages === 2) result.push(null);
    } else if (geometry.spreadPages === 2 && result.length % 2 !== 0) {
      result.push(null);
    }
    return result;
  }, [pages, geometry.spreadPages]);

  const [currentPage, setCurrentPage] = useState(0);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const previousPagesRef = useRef(pages);
  const pendingReadingAnchorRef = useRef<{ chapterNumber: number; sourceOffset: number } | null>(null);

  // Capture the centre of the currently visible source range before new page
  // boundaries replace it. A numeric page index is not a stable reading
  // position: enlarging the book can reduce the page count and page-flip then
  // falls back to page zero when the old index no longer exists.
  useLayoutEffect(() => {
    const previousPages = previousPagesRef.current;
    if (previousPages !== pages && previousPages.length > 0) {
      const previousPage = previousPages[Math.min(currentPage, previousPages.length - 1)];
      if (previousPage) {
        pendingReadingAnchorRef.current = {
          chapterNumber: previousPage.chapterNumber,
          sourceOffset: previousPage.sourceStart
            + Math.max(0, Math.floor((previousPage.sourceEnd - previousPage.sourceStart) / 2)),
        };
      }
    }
    previousPagesRef.current = pages;
  }, [pages, currentPage]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncPreference = () => setPrefersReducedMotion(media.matches);
    syncPreference();
    media.addEventListener('change', syncPreference);
    return () => media.removeEventListener('change', syncPreference);
  }, []);

  // --- Live-follow state -------------------------------------------------
  // `suspendResumeAt != null` means the user explicitly took over (buttons,
  // arrow keys, book swipe, chapter jump, sidebar chapter pick) and
  // auto-follow is paused until that timestamp. Every further gesture
  // re-arms the full window. When the timer fires we snap straight to the
  // latest real content page — even if no new chunk arrived meanwhile.
  const [suspendResumeAt, setSuspendResumeAt] = useState<number | null>(null);
  const suspendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [followNowMs, setFollowNowMs] = useState(() => Date.now());

  useEffect(() => {
    return () => {
      if (suspendTimerRef.current) clearTimeout(suspendTimerRef.current);
    };
  }, []);

  // Last REAL content page of the chapter currently being generated — never
  // the blank filler page appended to complete a spread.
  const lastContentPageIndex = useMemo(() => {
    if (pages.length === 0) return -1;
    if (liveChapter) {
      for (let i = pages.length - 1; i >= 0; i -= 1) {
        if (pages[i].chapterNumber === liveChapter.chapterNumber) return i;
      }
    }
    return pages.length - 1;
  }, [pages, liveChapter]);

  const jumpToLatestContentPage = useCallback(() => {
    if (lastContentPageIndex < 0) return;
    const pf = bookRef.current?.pageFlip();
    // Always turn — including target 0. After updateFromHtml, page-flip may
    // report index 0 while the display is still blank from an out-of-range show.
    if (!pf) return;
    pf.turnToPage(lastContentPageIndex);
  }, [lastContentPageIndex]);
  const jumpToLatestRef = useRef(jumpToLatestContentPage);
  useEffect(() => {
    jumpToLatestRef.current = jumpToLatestContentPage;
  });

  const suspendFollow = useCallback(() => {
    const now = Date.now();
    setFollowNowMs(now);
    setSuspendResumeAt(now + FOLLOW_SUSPEND_MS);
    if (suspendTimerRef.current) clearTimeout(suspendTimerRef.current);
    suspendTimerRef.current = setTimeout(() => {
      suspendTimerRef.current = null;
      setSuspendResumeAt(null);
      jumpToLatestRef.current();
    }, FOLLOW_SUSPEND_MS);
  }, []);

  // 1s-ish heartbeat while suspended so the toolbar countdown reads live.
  useEffect(() => {
    if (suspendResumeAt == null) return;
    const id = setInterval(() => setFollowNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [suspendResumeAt]);

  const followSuspended = suspendResumeAt != null;
  const followRemainingSec = suspendResumeAt == null
    ? 0
    : Math.max(0, Math.ceil((suspendResumeAt - followNowMs) / 1000));

  // Auto-follow the live draft. Writing-live only; review mode is fully
  // manual. Fires whenever pagination grows (one page or several) and right
  // after a suspension ends.
  useEffect(() => {
    if (mode !== 'writing-live' || !liveChapter || followSuspended) return;
    jumpToLatestContentPage();
  }, [mode, liveChapter, followSuspended, jumpToLatestContentPage]);

  // React-pageflip refreshes its internal HTML collection in a passive effect.
  // Restore after that refresh: active live-follow owns the latest page;
  // review mode and suspended follow retain the same source passage.
  useEffect(() => {
    const shouldFollowLatest = mode === 'writing-live' && liveChapter && !followSuspended;
    if (!shouldFollowLatest && !pendingReadingAnchorRef.current) return;

    const timer = setTimeout(() => {
      if (shouldFollowLatest) {
        pendingReadingAnchorRef.current = null;
        jumpToLatestContentPage();
        return;
      }

      const anchor = pendingReadingAnchorRef.current;
      const pf = bookRef.current?.pageFlip();
      if (!anchor || !pf) return;
      const target = findPageIndexForSourceOffset(pages, anchor.chapterNumber, anchor.sourceOffset);
      // Unconditional turn after collection refresh, including target 0: the
      // getter can already read 0 while show(oldIndex) no-op'd to a blank page.
      if (target >= 0) pf.turnToPage(target);
      pendingReadingAnchorRef.current = null;
    }, 0);

    return () => clearTimeout(timer);
  }, [pages, mode, liveChapter, followSuspended, jumpToLatestContentPage]);

  const [hasFlipped, setHasFlipped] = useState(false);

  // onFlip is a passive sync: it records the current page and mirrors the
  // chapter into the sidebar. It must NOT infer user intent — programmatic
  // turns fire it too, so suspending follow here would break auto-follow.
  const handleFlip = useCallback((e: { data: number }) => {
    setCurrentPage(e.data);
    setHasFlipped(true);
    // Map page → chapterNumber for sidebar sync
    const page = pages[e.data];
    if (page && page.chapterNumber !== activeChapter) {
      onActiveChapterChange?.(page.chapterNumber);
    }
  }, [pages, activeChapter, onActiveChapterChange]);

  const flipNext = useCallback(() => {
    if (!hasContent) return;
    const pf = bookRef.current?.pageFlip();
    if (!pf) return;
    const cur = pf.getCurrentPageIndex();
    if (cur >= displayPages.length - 1) return;
    suspendFollow();
    if (prefersReducedMotion) pf.turnToNextPage();
    else pf.flipNext();
  }, [hasContent, displayPages.length, prefersReducedMotion, suspendFollow]);

  const flipPrev = useCallback(() => {
    if (!hasContent) return;
    const pf = bookRef.current?.pageFlip();
    if (!pf) return;
    const cur = pf.getCurrentPageIndex();
    if (cur <= 0) return;
    suspendFollow();
    if (prefersReducedMotion) pf.turnToPrevPage();
    else pf.flipPrev();
  }, [hasContent, prefersReducedMotion, suspendFollow]);

  // Arrow keys flip pages. We delegate the input-focus skip to
  // useGlobalHotkey so it walks `isContentEditable` ancestors too —
  // hand-rolled instanceof checks miss live-writing's Lexical surface and
  // anything else rendered with contenteditable=true.
  useGlobalHotkey('arrowright', flipNext, { enabled: hasContent });
  useGlobalHotkey('arrowleft', flipPrev, { enabled: hasContent });

  // --- Chapter-start positioning ------------------------------------------
  // Only an EXTERNAL chapter selection (sidebar pick, jump input, deep link,
  // search result — signalled by a fresh selection seq) repositions the book
  // to a chapter's first page. Flip-driven activeChapter syncs, stream
  // chunks, re-pagination and programmatic turns never do.
  const turnToChapterStart = useCallback((chapterNumber: number): boolean => {
    const target = pages.findIndex(p => p.chapterNumber === chapterNumber && p.isFirstOfChapter);
    if (target < 0) return false;
    const pf = bookRef.current?.pageFlip();
    if (!pf) return false;
    if (pf.getCurrentPageIndex() !== target) pf.turnToPage(target);
    return true;
  }, [pages]);

  const selectionStateRef = useRef<{ seq: number; chapterNumber: number; done: boolean } | null>(null);

  useEffect(() => {
    if (!chapterSelection) return;
    let pending = selectionStateRef.current;
    if (!pending || pending.seq !== chapterSelection.seq) {
      pending = { ...chapterSelection, done: false };
      selectionStateRef.current = pending;
      suspendFollow();
    }
    if (pending.done) return;
    // If the chapter is not paginated yet (fresh draft), stay pending — the
    // effect re-runs when `pages` changes and retries without re-suspending.
    if (turnToChapterStart(pending.chapterNumber)) pending.done = true;
  }, [chapterSelection, suspendFollow, turnToChapterStart]);

  const handleBookInit = useCallback(() => {
    const pending = selectionStateRef.current;
    if (pending && !pending.done) {
      if (turnToChapterStart(pending.chapterNumber)) pending.done = true;
      return;
    }
    if (activeChapter != null) turnToChapterStart(activeChapter);
  }, [turnToChapterStart, activeChapter]);

  const { t } = useLanguage();
  const totalPages = pages.length;
  const boundedCurrentPage = hasContent
    ? Math.min(currentPage, Math.max(0, displayPages.length - 1))
    : 0;

  const pageInfo = hasContent
    ? t.manuscriptPageOf.replace('{current}', String(Math.min(boundedCurrentPage + 1, totalPages))).replace('{total}', String(totalPages))
    : t.manuscriptEmpty;

  const isAtStart = !hasContent || boundedCurrentPage <= 0;
  const isAtEnd = !hasContent || boundedCurrentPage >= displayPages.length - 1;

  // Single page indicator: it lives in the toolbar at every width. The prev/
  // next buttons render twice — in the toolbar below xl and inside the fixed
  // side rails at xl+ (CSS-gated, so exactly one pair is ever visible).
  const pageNav = (
    <div className="flex items-center gap-1.5">
      <span className="xl:hidden">
        <PageTurnButton
          direction="prev"
          onClick={flipPrev}
          disabled={isAtStart}
          label={t.unificationPagerPrev}
        />
      </span>
      <span className="whitespace-nowrap text-xs-tight font-semibold uppercase tracking-label text-book-gold">
        {pageInfo}
      </span>
      <span className="xl:hidden">
        <PageTurnButton
          direction="next"
          onClick={flipNext}
          disabled={isAtEnd}
          label={t.unificationPagerNext}
        />
      </span>
    </div>
  );

  const followStatus = mode === 'writing-live'
    ? { suspended: followSuspended, remainingSec: followRemainingSec }
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0 relative">
      <LayoutToolbar
        layout={toolbar.layout}
        onLayoutChange={toolbar.onLayoutChange}
        jumpInputRef={toolbar.jumpInputRef}
        onJump={toolbar.onJump}
        totalChapters={toolbar.totalChapters}
        pageNav={pageNav}
        follow={followStatus}
      />

      <div className="flex-1 min-h-0 flex items-stretch">
        {/* Fixed side rail (xl+): reserves its own column, button vertically
            centred, never overlays the page. */}
        <div className="hidden xl:flex w-14 shrink-0 flex-col items-center justify-center">
          <PageTurnButton
            direction="prev"
            onClick={flipPrev}
            disabled={isAtStart}
            label={t.unificationPagerPrev}
            iconSize="md"
          />
        </div>

        {/* Real book viewport — the only element pagination measures. */}
        <div
          ref={containerRef}
          className="flex-1 min-w-0 relative"
          onPointerDown={hasContent ? suspendFollow : undefined}
          onTouchStart={hasContent ? suspendFollow : undefined}
        >
          {hasContent ? (
            <>
              {/* @ts-expect-error — dynamic import typing */}
              <HTMLFlipBook
                ref={bookRef}
                width={FLIPBOOK_LAYOUT.pageWidth}
                height={FLIPBOOK_LAYOUT.pageHeight}
                size="stretch"
                minWidth={FLIPBOOK_LAYOUT.minPageWidth}
                maxWidth={FLIPBOOK_LAYOUT.maxPageWidth}
                minHeight={FLIPBOOK_LAYOUT.minPageHeight}
                autoSize={false}
                drawShadow={true}
                maxShadowOpacity={0.45}
                flippingTime={FLIP_TIME_MS}
                usePortrait={true}
                showCover={false}
                showPageCorners={false}
                mobileScrollSupport={false}
                swipeDistance={30}
                onInit={handleBookInit}
                onFlip={handleFlip}
                className="manuscript-flipbook"
              >
                {displayPages.map((page, i) => (
                  <FlipBookPage key={i} page={page} />
                ))}
              </HTMLFlipBook>

              {geometry.pageHeight > 0 && (
                <div className="pointer-events-none absolute z-10" style={bookOverlayStyle} aria-hidden>
                  {geometry.spreadPages === 2 && (
                    <div data-testid="flipbook-spine" className="hidden md:block absolute left-1/2 top-2 h-[calc(100%-1rem)] w-6 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,_rgba(78,51,23,0.18),_rgba(78,51,23,0.04)_68%,_transparent_100%)]" />
                  )}

                  {!hasFlipped && (
                    <div className="flip-hint-swipe absolute right-12 bottom-14 z-20">
                      <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" className="text-book-gold-dark dark:text-book-gold">
                        <path d="M9,11.24V7.5C9,6.12,10.12,5,11.5,5S14,6.12,14,7.5v3.74c1.21-0.81,2-2.18,2-3.74C16,5.01,13.99,3,11.5,3S7,5.01,7,7.5C7,9.06,7.79,10.43,9,11.24z M18.84,15.87l-4.54-2.26c-0.17-0.07-0.35-0.11-0.54-0.11H13v-6C13,6.67,12.33,6,11.5,6S10,6.67,10,7.5v10.74c-3.6-0.76-3.54-0.75-3.67-0.75c-0.31,0-0.59,0.13-0.79,0.33l-0.79,0.8l4.94,4.94C9.96,23.83,10.34,24,10.75,24h6.79c0.75,0,1.33-0.55,1.44-1.28l0.75-5.27c0.01-0.07,0.02-0.14,0.02-0.2C19.75,16.63,19.37,16.09,18.84,15.87z" />
                      </svg>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <EmptyManuscript novelId={novelId} />
          )}
        </div>

        <div className="hidden xl:flex w-14 shrink-0 flex-col items-center justify-center">
          <PageTurnButton
            direction="next"
            onClick={flipNext}
            disabled={isAtEnd}
            label={t.unificationPagerNext}
            iconSize="md"
          />
        </div>
      </div>
    </div>
  );
}

/* ---------- ManuscriptReadingView (top-level switch) ---------- */

export function ManuscriptReadingView({
  novelId,
  chapters,
  liveChapter,
  mode,
  activeChapter,
  onActiveChapterChange,
  onChapterJump,
  chapterSelection,
  layout,
  onLayoutChange,
}: ManuscriptReadingViewProps) {
  const jumpInputRef = useRef<HTMLInputElement>(null);
  const totalChapters = chapters.length;

  const handleJump = useCallback((n: number) => {
    if (onChapterJump) onChapterJump(n);
    else onActiveChapterChange?.(n);
  }, [onChapterJump, onActiveChapterChange]);

  // Cmd/Ctrl+G → focus the jump-to-chapter input
  useGlobalHotkey('mod+g', () => {
    jumpInputRef.current?.focus();
    jumpInputRef.current?.select();
  });

  return (
    <div className="flex-1 min-w-0 flex flex-col min-h-0 relative">
      {layout === 'flipbook' && chapters.length > 0 ? (
        <FlipbookReadingView
          key={novelId}
          novelId={novelId}
          chapters={chapters}
          liveChapter={liveChapter}
          mode={mode}
          activeChapter={activeChapter}
          onActiveChapterChange={onActiveChapterChange}
          chapterSelection={chapterSelection}
          toolbar={{
            layout,
            onLayoutChange,
            jumpInputRef,
            onJump: handleJump,
            totalChapters,
          }}
        />
      ) : (
        <>
          <LayoutToolbar
            layout={layout}
            onLayoutChange={onLayoutChange}
            jumpInputRef={jumpInputRef}
            onJump={handleJump}
            totalChapters={totalChapters}
          />

          {chapters.length === 0 ? (
            <div className="flex-1 min-h-0 relative">
              <EmptyManuscript novelId={novelId} />
            </div>
          ) : (
            <div className="flex-1 min-h-0 relative">
              <ContinuousReadingView
                chapters={chapters}
                activeChapter={activeChapter}
                onActiveChapterChange={onActiveChapterChange}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
