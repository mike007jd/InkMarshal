// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { ManuscriptReadingView } from '@/components/ManuscriptReadingView';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';

const flipBookProbe = vi.hoisted(() => ({
  mountCount: 0,
  latestFlippingTime: 0,
  onFlip: null as null | ((event: { data: number }) => void),
}));

const pageFlip = vi.hoisted(() => ({
  currentPage: 0,
  flipNext: vi.fn(),
  flipPrev: vi.fn(),
  turnToNextPage: vi.fn(),
  turnToPrevPage: vi.fn(),
  turnToPage: vi.fn(),
  getCurrentPageIndex: vi.fn(),
}));

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
  useDynamicPagination: () => ({
    containerRef: { current: null },
    charsPerPage: 40,
    titleReserve: 0,
  }),
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
    pageFlip.flipNext.mockReset();
    pageFlip.flipPrev.mockReset();
    pageFlip.turnToNextPage.mockReset();
    pageFlip.turnToPrevPage.mockReset();
    pageFlip.turnToPage.mockReset();
    pageFlip.getCurrentPageIndex.mockReset().mockImplementation(() => pageFlip.currentPage);
    pageFlip.flipNext.mockImplementation(() => {
      pageFlip.currentPage += 2;
      flipBookProbe.onFlip?.({ data: pageFlip.currentPage });
    });
    pageFlip.turnToNextPage.mockImplementation(() => {
      pageFlip.currentPage += 2;
      flipBookProbe.onFlip?.({ data: pageFlip.currentPage });
    });
    flipBookProbe.mountCount = 0;
    flipBookProbe.latestFlippingTime = 0;
    flipBookProbe.onFlip = null;
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
