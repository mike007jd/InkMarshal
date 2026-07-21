// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { ManuscriptReadingView } from '@/components/ManuscriptReadingView';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';
import { paginateManuscript } from '@/lib/pagination';

const flipBookProbe = vi.hoisted(() => ({
  mountCount: 0,
  latestFlippingTime: 0,
  onFlip: null as null | ((event: { data: number }) => void),
}));

const paginationProbe = vi.hoisted(() => ({
  onContainerResize: null as null | (() => void),
  charsPerPage: 40,
  geometry: {
    pageWidth: 500,
    pageHeight: 850,
    spreadWidth: 1000,
    spreadPages: 2 as 1 | 2,
    left: 0,
    top: 0,
  },
}));

const pageFlip = vi.hoisted(() => ({
  currentPage: 0,
  pageCount: 0,
  /** True when updateFromHtml tried show(oldIndex) out of range and no-op'd. */
  blank: false,
  update: vi.fn(),
  flipNext: vi.fn(),
  flipPrev: vi.fn(),
  turnToNextPage: vi.fn(),
  turnToPrevPage: vi.fn(),
  turnToPage: vi.fn(),
  getCurrentPageIndex: vi.fn(),
}));

function installPageFlipBehavior() {
  pageFlip.turnToPage.mockImplementation((page: number) => {
    // Real page-flip: out-of-range turn is a silent no-op.
    if (!Number.isInteger(page) || page < 0 || page >= pageFlip.pageCount) return;
    pageFlip.currentPage = page;
    pageFlip.blank = false;
    flipBookProbe.onFlip?.({ data: page });
  });
  pageFlip.getCurrentPageIndex.mockImplementation(() => pageFlip.currentPage);
  pageFlip.flipNext.mockImplementation(() => {
    const next = Math.min(pageFlip.currentPage + 2, Math.max(0, pageFlip.pageCount - 1));
    pageFlip.currentPage = next;
    pageFlip.blank = false;
    flipBookProbe.onFlip?.({ data: pageFlip.currentPage });
  });
  pageFlip.turnToNextPage.mockImplementation(() => {
    const next = Math.min(pageFlip.currentPage + 2, Math.max(0, pageFlip.pageCount - 1));
    pageFlip.currentPage = next;
    pageFlip.blank = false;
    flipBookProbe.onFlip?.({ data: pageFlip.currentPage });
  });
}

vi.mock('next/dynamic', async () => {
  const ReactModule = await import('react');
  const MockFlipBook = ReactModule.forwardRef<
    { pageFlip(): typeof pageFlip },
    React.PropsWithChildren<{
      flippingTime: number;
      onFlip?: (event: { data: number }) => void;
      onInit?: () => void;
    }>
  >((props, ref) => {
    ReactModule.useImperativeHandle(ref, () => ({ pageFlip: () => pageFlip }));
    const initialOnInit = ReactModule.useRef(props.onInit);
    const childCount = ReactModule.Children.count(props.children);
    // Mirror page-flip updateFromHtml: after collection refresh it calls
    // show(oldIndex). When that index is gone the display stays blank/no-op,
    // while getCurrentPageIndex may still report 0. Do NOT auto-correct to a
    // visible page 0 — production restore must turnToPage(target) itself.
    ReactModule.useLayoutEffect(() => {
      const oldIndex = pageFlip.currentPage;
      pageFlip.pageCount = childCount;
      if (childCount <= 0 || oldIndex < 0 || oldIndex >= childCount) {
        pageFlip.blank = true;
        pageFlip.currentPage = 0;
        return;
      }
      pageFlip.blank = false;
      pageFlip.currentPage = oldIndex;
    }, [childCount]);
    ReactModule.useEffect(() => {
      flipBookProbe.mountCount += 1;
      initialOnInit.current?.();
    }, []);
    flipBookProbe.latestFlippingTime = props.flippingTime;
    flipBookProbe.onFlip = props.onFlip ?? null;
    return <div data-testid="flipbook">{props.children}</div>;
  });
  MockFlipBook.displayName = 'MockFlipBook';

  return { default: () => MockFlipBook };
});

vi.mock('@/hooks/useDynamicPagination', () => ({
  useDynamicPagination: (options: { onContainerResize?: () => void }) => {
    paginationProbe.onContainerResize = options.onContainerResize ?? null;
    return {
      containerRef: { current: null },
      charsPerPage: paginationProbe.charsPerPage,
      titleReserve: 0,
      geometry: paginationProbe.geometry,
    };
  },
}));

const chapter: ManuscriptChapter = {
  id: 'ch-1',
  chapterNumber: 1,
  title: 'The First Page',
  content: 'A deliberately long manuscript page. '.repeat(20),
};

let mediaQuery: MediaQueryList;
let mediaListeners: Set<(event: MediaQueryListEvent) => void>;

function setReducedMotion(matches: boolean) {
  Object.defineProperty(mediaQuery, 'matches', { configurable: true, value: matches });
  const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
  for (const listener of mediaListeners) listener(event);
}

function renderFlipbook() {
  return render(
    <LocaleProvider>
      <ManuscriptReadingView
        novelId="nv-test"
        chapters={[chapter]}
        liveChapter={null}
        mode="reading-review"
        activeChapter={null}
        layout="flipbook"
        onLayoutChange={() => {}}
      />
    </LocaleProvider>,
  );
}

describe('ManuscriptReadingView reduced-motion page flips', () => {
  beforeEach(() => {
    mediaListeners = new Set();
    mediaQuery = {
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') {
          mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
        }
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') {
          mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
        }
      },
      addListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) mediaListeners.add(listener);
      },
      removeListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) mediaListeners.delete(listener);
      },
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));
    pageFlip.currentPage = 0;
    pageFlip.pageCount = 0;
    pageFlip.blank = false;
    pageFlip.update.mockReset();
    pageFlip.flipNext.mockReset();
    pageFlip.flipPrev.mockReset();
    pageFlip.turnToNextPage.mockReset();
    pageFlip.turnToPrevPage.mockReset();
    pageFlip.turnToPage.mockReset();
    pageFlip.getCurrentPageIndex.mockReset();
    installPageFlipBehavior();
    flipBookProbe.mountCount = 0;
    flipBookProbe.latestFlippingTime = 0;
    flipBookProbe.onFlip = null;
    paginationProbe.onContainerResize = null;
    paginationProbe.charsPerPage = 40;
    paginationProbe.geometry = {
      pageWidth: 500,
      pageHeight: 850,
      spreadWidth: 1000,
      spreadPages: 2,
      left: 0,
      top: 0,
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('uses the library instant-turn API when Reduce Motion is already on', async () => {
    setReducedMotion(true);
    renderFlipbook();

    await waitFor(() => expect(flipBookProbe.latestFlippingTime).toBe(400));
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    expect(pageFlip.turnToNextPage).toHaveBeenCalledOnce();
    expect(pageFlip.flipNext).not.toHaveBeenCalled();
  });

  it('updates the live instance without remounting or losing navigation after preference changes', async () => {
    renderFlipbook();
    await waitFor(() => expect(flipBookProbe.latestFlippingTime).toBe(400));
    const initialMountCount = flipBookProbe.mountCount;

    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    expect(pageFlip.flipNext).toHaveBeenCalledOnce();

    act(() => setReducedMotion(true));
    await waitFor(() => expect(flipBookProbe.latestFlippingTime).toBe(400));
    expect(flipBookProbe.mountCount).toBe(initialMountCount);
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    expect(pageFlip.turnToNextPage).toHaveBeenCalledOnce();

    act(() => setReducedMotion(false));
    await waitFor(() => expect(flipBookProbe.latestFlippingTime).toBe(400));
    expect(flipBookProbe.mountCount).toBe(initialMountCount);
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    expect(pageFlip.flipNext).toHaveBeenCalledTimes(2);
  });

  it('updates the live book in place when only its container changes size', async () => {
    renderFlipbook();
    await waitFor(() => expect(paginationProbe.onContainerResize).not.toBeNull());
    const initialMountCount = flipBookProbe.mountCount;
    pageFlip.currentPage = 2;

    act(() => paginationProbe.onContainerResize?.());

    expect(pageFlip.update).toHaveBeenCalledOnce();
    expect(pageFlip.currentPage).toBe(2);
    expect(flipBookProbe.mountCount).toBe(initialMountCount);
  });

  it('keeps the same source passage when a larger book reduces the page count', async () => {
    const anchoredChapter: ManuscriptChapter = {
      id: 'anchor',
      chapterNumber: 1,
      title: 'Anchor',
      content: Array.from({ length: 400 }, (_, index) => `word-${index}`).join(' '),
    };
    const before = paginateManuscript([anchoredChapter], { charsPerPage: 160, chapterTitleReserve: 0 });
    const oldIndex = Math.floor(before.length * 0.7);
    const sourceOffset = before[oldIndex].sourceStart
      + Math.floor((before[oldIndex].sourceEnd - before[oldIndex].sourceStart) / 2);
    paginationProbe.charsPerPage = 160;
    const { rerender } = render(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-anchor"
          chapters={[anchoredChapter]}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );
    pageFlip.currentPage = oldIndex;
    act(() => flipBookProbe.onFlip?.({ data: oldIndex }));
    pageFlip.turnToPage.mockClear();

    paginationProbe.charsPerPage = 420;
    const after = paginateManuscript([anchoredChapter], { charsPerPage: 420, chapterTitleReserve: 0 });
    const expectedTarget = after.findIndex(page => (
      sourceOffset >= page.sourceStart && sourceOffset < page.sourceEnd
    ));
    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-anchor"
          chapters={[anchoredChapter]}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );
    expect(after.length).toBeLessThan(before.length);
    expect(expectedTarget).toBeGreaterThan(0);
    // Collection refresh left the book blank with getter=0; restore must still
    // turn to the mapped non-zero target.
    expect(pageFlip.blank).toBe(true);
    expect(pageFlip.getCurrentPageIndex()).toBe(0);
    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalledWith(expectedTarget));
    expect(pageFlip.turnToPage).not.toHaveBeenCalledWith(0);
    expect(pageFlip.blank).toBe(false);
  });

  it('unconditionally turns to mapped target 0 after re-pagination blanks an out-of-range index', async () => {
    const anchoredChapter: ManuscriptChapter = {
      id: 'anchor-zero',
      chapterNumber: 1,
      title: 'Anchor Zero',
      content: Array.from({ length: 400 }, (_, index) => `word-${index}`).join(' '),
    };
    const before = paginateManuscript([anchoredChapter], { charsPerPage: 120, chapterTitleReserve: 0 });
    const oldIndex = Math.floor(before.length * 0.85);
    const sourceOffset = before[oldIndex].sourceStart
      + Math.floor((before[oldIndex].sourceEnd - before[oldIndex].sourceStart) / 2);
    paginationProbe.charsPerPage = 120;
    const { rerender } = render(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-anchor-zero"
          chapters={[anchoredChapter]}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );
    pageFlip.currentPage = oldIndex;
    act(() => flipBookProbe.onFlip?.({ data: oldIndex }));
    pageFlip.turnToPage.mockClear();

    // Shrink hard so the preserved source passage lands on page 0.
    paginationProbe.charsPerPage = 8000;
    const after = paginateManuscript([anchoredChapter], { charsPerPage: 8000, chapterTitleReserve: 0 });
    const expectedTarget = after.findIndex(page => (
      sourceOffset >= page.sourceStart && sourceOffset < page.sourceEnd
    ));
    expect(after.length).toBe(1);
    expect(expectedTarget).toBe(0);

    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-anchor-zero"
          chapters={[anchoredChapter]}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    // Real library: show(oldIndex) no-ops → blank, getter may already be 0.
    expect(pageFlip.blank).toBe(true);
    expect(pageFlip.getCurrentPageIndex()).toBe(0);
    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalledWith(0));
    expect(pageFlip.blank).toBe(false);
    expect(pageFlip.getCurrentPageIndex()).toBe(0);
  });

  it('restores the source passage across desktop spread ↔ narrow single-page geometry', async () => {
    const anchoredChapter: ManuscriptChapter = {
      id: 'anchor-spread',
      chapterNumber: 1,
      title: 'Spread',
      content: Array.from({ length: 360 }, (_, index) => `word-${index}`).join(' '),
    };
    paginationProbe.charsPerPage = 140;
    paginationProbe.geometry = {
      pageWidth: 500,
      pageHeight: 850,
      spreadWidth: 1000,
      spreadPages: 2,
      left: 0,
      top: 0,
    };
    const before = paginateManuscript([anchoredChapter], { charsPerPage: 140, chapterTitleReserve: 0 });
    const oldIndex = Math.min(4, before.length - 1);
    const sourceOffset = before[oldIndex].sourceStart
      + Math.floor((before[oldIndex].sourceEnd - before[oldIndex].sourceStart) / 2);

    const { rerender } = render(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-spread"
          chapters={[anchoredChapter]}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );
    pageFlip.currentPage = oldIndex;
    act(() => flipBookProbe.onFlip?.({ data: oldIndex }));
    pageFlip.turnToPage.mockClear();

    paginationProbe.charsPerPage = 220;
    paginationProbe.geometry = {
      pageWidth: 360,
      pageHeight: 612,
      spreadWidth: 360,
      spreadPages: 1,
      left: 0,
      top: 0,
    };
    const after = paginateManuscript([anchoredChapter], { charsPerPage: 220, chapterTitleReserve: 0 });
    const expectedTarget = after.findIndex(page => (
      sourceOffset >= page.sourceStart && sourceOffset < page.sourceEnd
    ));
    expect(expectedTarget).toBeGreaterThanOrEqual(0);

    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-spread"
          chapters={[anchoredChapter]}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalledWith(expectedTarget));
    expect(screen.getByTestId('flipbook').children).toHaveLength(after.length);
    expect(screen.queryByTestId('flipbook-spine')).toBeNull();

    const narrowPage = after[expectedTarget];
    const narrowSourceOffset = narrowPage.sourceStart
      + Math.floor((narrowPage.sourceEnd - narrowPage.sourceStart) / 2);
    pageFlip.turnToPage.mockClear();
    paginationProbe.charsPerPage = 140;
    paginationProbe.geometry = {
      pageWidth: 500,
      pageHeight: 850,
      spreadWidth: 1000,
      spreadPages: 2,
      left: 0,
      top: 0,
    };
    const backToDesktop = paginateManuscript(
      [anchoredChapter],
      { charsPerPage: 140, chapterTitleReserve: 0 },
    );
    const desktopTarget = backToDesktop.findIndex(page => (
      narrowSourceOffset >= page.sourceStart && narrowSourceOffset < page.sourceEnd
    ));

    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-spread"
          chapters={[anchoredChapter]}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalledWith(desktopTarget));
    expect(screen.getByTestId('flipbook').children).toHaveLength(
      backToDesktop.length + (backToDesktop.length % 2),
    );
    expect(screen.queryByTestId('flipbook-spine')).not.toBeNull();
  });

  it('does not add a filler page or fake spine in one-page portrait mode', () => {
    paginationProbe.geometry = {
      pageWidth: 400,
      pageHeight: 680,
      spreadWidth: 400,
      spreadPages: 1,
      left: 0,
      top: 0,
    };
    renderFlipbook();

    const realPages = paginateManuscript([chapter], { charsPerPage: 40, chapterTitleReserve: 0 });
    expect(screen.getByTestId('flipbook').children).toHaveLength(realPages.length);
    expect(screen.queryByTestId('flipbook-spine')).toBeNull();
  });

  it('does not snap a completed page turn back to the active chapter start', async () => {
    render(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-test"
          chapters={[chapter]}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    await waitFor(() => expect(flipBookProbe.latestFlippingTime).toBe(400));
    pageFlip.turnToPage.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);

    await waitFor(() => expect(pageFlip.currentPage).toBe(2));
    expect(pageFlip.turnToPage).not.toHaveBeenCalled();
  });
});

/* ---------- Live-writing follow / suspend regression suite ---------- */

const PAGINATION_OPTS = { charsPerPage: 40, chapterTitleReserve: 0 } as const;

const ch1: ManuscriptChapter = {
  id: 'ch-1',
  chapterNumber: 1,
  title: 'First',
  content: 'One two three four five six seven eight nine ten. '.repeat(24),
};

function liveChapterWith(words: number): ManuscriptChapter {
  return {
    id: 'ch-live',
    chapterNumber: 2,
    title: 'Live',
    content: 'live draft words streaming in steadily now. '.repeat(words),
  };
}

function lastRealPageIndex(chapters: ManuscriptChapter[]): number {
  return paginateManuscript(chapters, { ...PAGINATION_OPTS }).length - 1;
}

function renderLive(props: {
  chapters: ManuscriptChapter[];
  liveChapter: ManuscriptChapter | null;
  mode?: 'writing-live' | 'reading-review';
  activeChapter?: number | null;
  chapterSelection?: { chapterNumber: number; seq: number } | null;
  onActiveChapterChange?: (n: number) => void;
}) {
  return render(
    <LocaleProvider>
      <ManuscriptReadingView
        novelId="nv-live"
        chapters={props.chapters}
        liveChapter={props.liveChapter}
        mode={props.mode ?? 'writing-live'}
        activeChapter={props.activeChapter ?? null}
        chapterSelection={props.chapterSelection ?? null}
        onActiveChapterChange={props.onActiveChapterChange}
        layout="flipbook"
        onLayoutChange={() => {}}
      />
    </LocaleProvider>,
  );
}

describe('ManuscriptReadingView live-writing follow & suspend', () => {
  beforeEach(() => {
    mediaListeners = new Set();
    mediaQuery = {
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') {
          mediaListeners.add(listener as (event: MediaQueryListEvent) => void);
        }
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') {
          mediaListeners.delete(listener as (event: MediaQueryListEvent) => void);
        }
      },
      addListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) mediaListeners.add(listener);
      },
      removeListener: (listener: ((event: MediaQueryListEvent) => void) | null) => {
        if (listener) mediaListeners.delete(listener);
      },
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
    vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));
    pageFlip.currentPage = 0;
    pageFlip.pageCount = 0;
    pageFlip.blank = false;
    pageFlip.update.mockReset();
    pageFlip.flipNext.mockReset();
    pageFlip.flipPrev.mockReset();
    pageFlip.turnToNextPage.mockReset();
    pageFlip.turnToPrevPage.mockReset();
    pageFlip.turnToPage.mockReset();
    pageFlip.getCurrentPageIndex.mockReset();
    installPageFlipBehavior();
    flipBookProbe.mountCount = 0;
    flipBookProbe.latestFlippingTime = 0;
    flipBookProbe.onFlip = null;
    paginationProbe.onContainerResize = null;
    paginationProbe.charsPerPage = 40;
    paginationProbe.geometry = {
      pageWidth: 500,
      pageHeight: 850,
      spreadWidth: 1000,
      spreadPages: 2,
      left: 0,
      top: 0,
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('auto-follows the latest real page as chunks grow the draft, never page 0 and never the blank filler page', async () => {
    const live = liveChapterWith(30);
    const chapters = [ch1, live];
    const { rerender } = renderLive({ chapters, liveChapter: live });

    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalled());
    const firstTargets = pageFlip.turnToPage.mock.calls.map(c => c[0]);
    expect(firstTargets).not.toContain(0);
    expect(firstTargets[firstTargets.length - 1]).toBe(lastRealPageIndex(chapters));

    pageFlip.turnToPage.mockClear();
    const grownLive = liveChapterWith(60);
    const grownChapters = [ch1, grownLive];
    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-live"
          chapters={grownChapters}
          liveChapter={grownLive}
          mode="writing-live"
          activeChapter={null}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalled());
    const targets = pageFlip.turnToPage.mock.calls.map(c => c[0]);
    const expectedLast = lastRealPageIndex(grownChapters);
    expect(targets).not.toContain(0);
    expect(targets[targets.length - 1]).toBe(expectedLast);
    // The even-spread blank filler page (displayPages.length - 1 when the
    // real page count is odd) must never be the follow target.
    expect(expectedLast % 2 === 0 ? true : targets.every(t => t !== expectedLast + 1)).toBe(true);
  });

  it('does not jump to a chapter start when a cross-chapter flip only syncs activeChapter', async () => {
    const chapters = [ch1, liveChapterWith(30)];
    const { rerender } = renderLive({
      chapters,
      liveChapter: null,
      mode: 'reading-review',
      activeChapter: 2,
    });

    await waitFor(() => expect(flipBookProbe.onFlip).not.toBeNull());
    // User flips back into chapter 1; the parent mirrors the chapter change.
    act(() => flipBookProbe.onFlip?.({ data: 0 }));
    pageFlip.turnToPage.mockClear();
    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-live"
          chapters={chapters}
          liveChapter={null}
          mode="reading-review"
          activeChapter={1}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    expect(pageFlip.turnToPage).not.toHaveBeenCalled();
  });

  it('keeps following immediately after programmatic turns — they never trigger the 5s suspension', async () => {
    const live = liveChapterWith(30);
    const chapters = [ch1, live];
    const { rerender } = renderLive({ chapters, liveChapter: live });
    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalled());

    pageFlip.turnToPage.mockClear();
    const grownLive = liveChapterWith(45);
    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-live"
          chapters={[ch1, grownLive]}
          liveChapter={grownLive}
          mode="writing-live"
          activeChapter={null}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    // A chunk lands right after the programmatic follow turn: the next
    // follow jump happens immediately, with no 5s wait.
    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalled());
  });

  it('resumes to the latest real page 5s after a button takeover even when no new chunk arrives', () => {
    vi.useFakeTimers();
    const live = liveChapterWith(30);
    const chapters = [ch1, live];
    renderLive({ chapters, liveChapter: live });
    const expectedLast = lastRealPageIndex(chapters);
    // Flush mount-time setTimeout(0) collection restore before asserting suspend.
    act(() => {
      vi.advanceTimersByTime(0);
    });
    pageFlip.turnToPage.mockClear();

    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    expect(pageFlip.flipNext).toHaveBeenCalledOnce();
    pageFlip.turnToPage.mockClear();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(pageFlip.turnToPage).toHaveBeenCalledWith(expectedLast);
  });

  it('re-arms the 5s window on consecutive button presses', () => {
    vi.useFakeTimers();
    const live = liveChapterWith(30);
    const chapters = [ch1, live];
    renderLive({ chapters, liveChapter: live });
    const expectedLast = lastRealPageIndex(chapters);
    act(() => {
      vi.advanceTimersByTime(0);
    });
    // Stand mid-book so both Next presses can suspend (end-of-book Next no-ops).
    pageFlip.currentPage = 2;
    act(() => flipBookProbe.onFlip?.({ data: 2 }));
    pageFlip.turnToPage.mockClear();

    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // 6s since the first press, but only 3s since the second — still suspended.
    expect(pageFlip.turnToPage).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(pageFlip.turnToPage).toHaveBeenCalledWith(expectedLast);
  });

  it('suspends on ArrowRight and announces the paused countdown in the aria-live status', () => {
    vi.useFakeTimers();
    const live = liveChapterWith(30);
    const chapters = [ch1, live];
    renderLive({ chapters, liveChapter: live });

    expect(screen.getByRole('status').textContent).toContain('Following live writing');
    // Exactly one page indicator exists — the single toolbar instance.
    expect(screen.getAllByText(/Page \d+ of \d+/)).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    });
    expect(pageFlip.flipNext).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toContain('Paused · resumes in 5s');
  });

  it('external chapter selection turns to the chapter start and suspends follow until the 5s resume', () => {
    vi.useFakeTimers();
    const live = liveChapterWith(30);
    const chapters = [ch1, live];
    const { rerender } = renderLive({ chapters, liveChapter: live });
    pageFlip.turnToPage.mockClear();

    // The reader was mid-book when they picked chapter 1 in the sidebar.
    pageFlip.currentPage = 5;
    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-live"
          chapters={chapters}
          liveChapter={live}
          mode="writing-live"
          activeChapter={1}
          chapterSelection={{ chapterNumber: 1, seq: 1 }}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );
    expect(pageFlip.turnToPage).toHaveBeenCalledWith(0);

    // A chunk arrives while suspended: no follow jump.
    pageFlip.turnToPage.mockClear();
    const grownLive = liveChapterWith(50);
    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-live"
          chapters={[ch1, grownLive]}
          liveChapter={grownLive}
          mode="writing-live"
          activeChapter={1}
          chapterSelection={{ chapterNumber: 1, seq: 1 }}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );
    expect(pageFlip.turnToPage).not.toHaveBeenCalled();

    // After the 5s window, follow resumes to the newest real page.
    const expectedLast = lastRealPageIndex([ch1, grownLive]);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(pageFlip.turnToPage).toHaveBeenCalledWith(expectedLast);
  });

  it('never auto-follows the latest page in reading-review mode, even when content grows', async () => {
    const chapters = [ch1, liveChapterWith(30)];
    const { rerender } = renderLive({
      chapters,
      liveChapter: liveChapterWith(30),
      mode: 'reading-review',
    });
    pageFlip.turnToPage.mockClear();

    const grown = [ch1, liveChapterWith(60)];
    const latest = lastRealPageIndex(grown);
    expect(latest).toBeGreaterThan(0);

    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-live"
          chapters={grown}
          liveChapter={liveChapterWith(60)}
          mode="reading-review"
          activeChapter={null}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    // Let the setTimeout(0) collection-restore settle. Source-anchor restore
    // may re-turn the current passage, but review must never jump to latest.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    const targets = pageFlip.turnToPage.mock.calls.map(call => call[0]);
    expect(targets).not.toContain(latest);
  });

  it('live-follow still calls turnToPage(0) when the latest content collapses to a single page', async () => {
    const shortLive: ManuscriptChapter = {
      id: 'ch-live',
      chapterNumber: 2,
      title: 'Live',
      content: '短篇即时草稿。'.repeat(40),
    };
    paginationProbe.charsPerPage = 40;
    const { rerender } = renderLive({
      chapters: [ch1, shortLive],
      liveChapter: shortLive,
    });
    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalled());
    const multiPageIndex = lastRealPageIndex([ch1, shortLive]);
    expect(multiPageIndex).toBeGreaterThan(0);
    pageFlip.currentPage = multiPageIndex;
    act(() => flipBookProbe.onFlip?.({ data: multiPageIndex }));
    pageFlip.turnToPage.mockClear();

    // Collapse pagination so the live chapter occupies only page 0;
    // collection refresh blanks the old high index first.
    paginationProbe.charsPerPage = 20000;
    const collapsedLive: ManuscriptChapter = {
      ...shortLive,
      content: '完。',
    };
    expect(paginateManuscript([collapsedLive], { charsPerPage: 20000, chapterTitleReserve: 0 })).toHaveLength(1);

    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-live"
          chapters={[collapsedLive]}
          liveChapter={collapsedLive}
          mode="writing-live"
          activeChapter={null}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );

    // Live-follow turns synchronously; assert the explicit target-0 turn that
    // clears the out-of-range blank left by collection refresh.
    await waitFor(() => expect(pageFlip.turnToPage).toHaveBeenCalledWith(0));
    expect(pageFlip.blank).toBe(false);
    expect(pageFlip.getCurrentPageIndex()).toBe(0);
  });

  it('does not re-suspend or re-position when the same selection seq re-renders after flips', () => {
    const chapters = [ch1, liveChapterWith(30)];
    const { rerender } = renderLive({
      chapters,
      liveChapter: null,
      mode: 'reading-review',
      activeChapter: 2,
      chapterSelection: { chapterNumber: 2, seq: 1 },
    });
    const firstPageOfCh2 = paginateManuscript(chapters, { ...PAGINATION_OPTS })
      .findIndex(p => p.chapterNumber === 2 && p.isFirstOfChapter);
    expect(pageFlip.turnToPage).toHaveBeenCalledWith(firstPageOfCh2);

    // User flips forward; the SAME selection re-rendering (e.g. parent state
    // churn) must not snap the book back to the chapter start.
    pageFlip.turnToPage.mockClear();
    pageFlip.currentPage = firstPageOfCh2 + 1;
    rerender(
      <LocaleProvider>
        <ManuscriptReadingView
          novelId="nv-live"
          chapters={chapters}
          liveChapter={null}
          mode="reading-review"
          activeChapter={2}
          chapterSelection={{ chapterNumber: 2, seq: 1 }}
          layout="flipbook"
          onLayoutChange={() => {}}
        />
      </LocaleProvider>,
    );
    expect(pageFlip.turnToPage).not.toHaveBeenCalled();
  });
});
