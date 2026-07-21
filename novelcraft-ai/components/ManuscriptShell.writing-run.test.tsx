// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatRunElapsed,
  isAwaitingDraftContentState,
  isBlueprintPlanningState,
  ManuscriptShell,
  type ManuscriptChapter,
  type WritingRunState,
} from '@/components/ManuscriptShell';
import { LocaleProvider } from '@/components/LanguageProvider';

const readingProbe = vi.hoisted(() => ({
  props: null as null | {
    activeChapter: number | null;
    chapterSelection?: { chapterNumber: number; seq: number } | null;
    onActiveChapterChange?: (n: number) => void;
    onChapterJump?: (n: number) => void;
  },
}));

vi.mock('@/components/ManuscriptReadingView', async () => {
  const ReactModule = await import('react');
  return {
    ManuscriptReadingView: (props: NonNullable<typeof readingProbe.props>) => {
      readingProbe.props = props;
      return ReactModule.createElement('div', { 'data-testid': 'reading-view' });
    },
  };
});

vi.mock('@/components/ManuscriptEditingView', async () => {
  const ReactModule = await import('react');
  return {
    ManuscriptEditingView: () => ReactModule.createElement('div', { 'data-testid': 'editing-view' }),
  };
});

vi.mock('@/components/search/GlobalSearchProvider', () => ({
  useRegisterSearchScope: () => {},
}));

vi.mock('@/components/WritingModelDotBadge', () => ({
  WritingModelDotBadge: () => null,
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => false,
  isMacPlatform: () => false,
}));

vi.mock('@/lib/app-settings-client', () => ({
  onAppSettingsHydrated: () => () => {},
  getStoredSetting: () => null,
  setStoredSetting: () => {},
  removeStoredSetting: () => {},
}));

function run(overrides: Partial<WritingRunState> = {}): WritingRunState {
  return {
    phase: 'planning',
    statusLabel: 'Planning chapter blueprint',
    liveWordCount: 0,
    completedChapters: 0,
    progress: 0,
    ...overrides,
  };
}

describe('formatRunElapsed', () => {
  it('formats seconds, minutes and hours compactly', () => {
    expect(formatRunElapsed(0)).toBe('0s');
    expect(formatRunElapsed(42)).toBe('42s');
    expect(formatRunElapsed(60)).toBe('1m');
    expect(formatRunElapsed(200)).toBe('3m 20s');
    expect(formatRunElapsed(3600)).toBe('1h');
    expect(formatRunElapsed(3900)).toBe('1h 5m');
  });

  it('never goes negative', () => {
    expect(formatRunElapsed(-5)).toBe('0s');
  });
});

describe('isAwaitingDraftContentState', () => {
  it('keeps the active-run state visible through the first drafting chunk gap', () => {
    expect(isAwaitingDraftContentState(run({ phase: 'preparing' }), 0, false)).toBe(true);
    expect(isAwaitingDraftContentState(run({ phase: 'planning' }), 0, false)).toBe(true);
    expect(isAwaitingDraftContentState(run({ phase: 'drafting' }), 0, false)).toBe(true);
    expect(isAwaitingDraftContentState(run({ phase: 'saving' }), 0, false)).toBe(true);
    expect(isAwaitingDraftContentState(run({ phase: 'paused' }), 0, false)).toBe(true);
    expect(isAwaitingDraftContentState(run({ phase: 'failed' }), 0, false)).toBe(true);
  });

  it('returns to manuscript content or the true idle empty state when appropriate', () => {
    expect(isAwaitingDraftContentState(run({ phase: 'drafting' }), 0, true)).toBe(false);
    expect(isAwaitingDraftContentState(run({ phase: 'drafting' }), 1, false)).toBe(false);
    expect(isAwaitingDraftContentState(run({ phase: 'idle' }), 0, false)).toBe(false);
    expect(isAwaitingDraftContentState(run({ phase: 'chapter_complete' }), 0, false)).toBe(false);
    expect(isAwaitingDraftContentState(run({ phase: 'complete' }), 0, false)).toBe(false);
  });
});

describe('isBlueprintPlanningState', () => {
  it('is true while preparing/planning with nothing on the page', () => {
    expect(isBlueprintPlanningState(run({ phase: 'preparing' }), 0, false)).toBe(true);
    expect(isBlueprintPlanningState(run({ phase: 'planning' }), 0, false)).toBe(true);
  });

  it('is false once drafting starts or content exists', () => {
    expect(isBlueprintPlanningState(run({ phase: 'drafting' }), 0, false)).toBe(false);
    // First live chunk arrived — the reading view streams it instead.
    expect(isBlueprintPlanningState(run({ phase: 'planning' }), 0, true)).toBe(false);
    expect(isBlueprintPlanningState(run({ phase: 'planning' }), 2, false)).toBe(false);
  });

  it('is false without a run state', () => {
    expect(isBlueprintPlanningState(null, 0, false)).toBe(false);
    expect(isBlueprintPlanningState(undefined, 0, false)).toBe(false);
    expect(isBlueprintPlanningState(run({ phase: 'idle' }), 0, false)).toBe(false);
  });
});

/* ---------- Shell render: compact run status + chapter-selection routing ---------- */

const NOW = Date.parse('2026-07-21T12:00:00.000Z');

const shellChapters: ManuscriptChapter[] = [
  { id: 'c1', chapterNumber: 1, title: 'Opening', content: 'First chapter text.' },
  { id: 'c2', chapterNumber: 2, title: 'Storm', content: 'Second chapter text.' },
];

function liveRun(overrides: Partial<WritingRunState> = {}): WritingRunState {
  return {
    phase: 'drafting',
    statusLabel: 'Drafting chapter',
    modelLabel: 'Qwen3.5 9B',
    chapterNumber: 2,
    liveWordCount: 456,
    completedChapters: 1,
    totalChapters: 5,
    progress: 40,
    startedAt: new Date(NOW - 30_000).toISOString(),
    lastActivityAt: new Date(NOW - 1_000).toISOString(),
    ...overrides,
  };
}

function renderShell(props: {
  mode?: 'writing-live' | 'reading-review';
  writingRunState?: WritingRunState | null;
  writingRunControls?: { onPause?: () => void; onResume?: () => void; onRetry?: () => void };
} = {}) {
  return render(
    <LocaleProvider>
      <ManuscriptShell
        novelId="nv-shell"
        title="Demo Novel"
        genre="Fantasy"
        progress={40}
        mode={props.mode ?? 'writing-live'}
        chapters={shellChapters}
        liveChapter={null}
        writingRunState={props.writingRunState ?? null}
        writingRunControls={props.writingRunControls}
      />
    </LocaleProvider>,
  );
}

describe('ManuscriptShell compact writing-run status', () => {
  beforeEach(() => {
    readingProbe.props = null;
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the narrow single-line bar (≤40px) above the prose instead of the old big card', () => {
    renderShell({ writingRunState: liveRun(), writingRunControls: { onPause: () => {} } });
    const bars = screen.getAllByRole('status');
    const narrowBar = bars.find(el => el.className.includes('h-10'));
    expect(narrowBar).toBeTruthy();
    expect(narrowBar!.className).toContain('max-h-10');
    expect(narrowBar!.className).toContain('whitespace-nowrap');
    // The bar carries only the compressed set: phase, chapter, progress, action.
    expect(narrowBar!.textContent).toContain('Drafting chapter');
    expect(narrowBar!.textContent).toContain('Ch.2');
    expect(narrowBar!.textContent).toContain('40%');
  });

  it('replaces the sidebar Progress section with the run panel on desktop', () => {
    renderShell({ writingRunState: liveRun(), writingRunControls: { onPause: () => {} } });
    expect(screen.queryByText('Progress')).toBeNull();
    // The panel shows the full narration (model + words + counts) in the sidebar.
    expect(screen.getByText('Qwen3.5 9B')).toBeTruthy();
    expect(screen.getByText('456 words')).toBeTruthy();
    expect(screen.getByText('1/5')).toBeTruthy();
  });

  it('routes Pause / Resume / Retry to the unchanged writing controls', () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onRetry = vi.fn();

    const { unmount } = renderShell({
      writingRunState: liveRun(),
      writingRunControls: { onPause },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Pause' })[0]);
    expect(onPause).toHaveBeenCalledOnce();
    unmount();

    cleanup();
    renderShell({
      writingRunState: liveRun({ phase: 'paused', statusLabel: 'Writing paused' }),
      writingRunControls: { onResume },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Resume now' })[0]);
    expect(onResume).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();

    cleanup();
    renderShell({
      writingRunState: liveRun({ phase: 'failed', statusLabel: 'Writing failed', error: 'stream broke' }),
      writingRunControls: { onRetry },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getAllByText('stream broke').length).toBeGreaterThan(0);

    cleanup();
    renderShell({
      writingRunState: liveRun({ phase: 'complete', statusLabel: 'All chapters written', progress: 100 }),
      writingRunControls: { onPause, onResume, onRetry },
    });
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('renders no run chrome when the run is idle or absent', () => {
    renderShell({ writingRunState: null });
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    renderShell({ writingRunState: liveRun({ phase: 'idle', statusLabel: '' }) });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Progress')).toBeTruthy();
  });
});

describe('ManuscriptShell chapter-selection routing', () => {
  beforeEach(() => {
    readingProbe.props = null;
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('marks sidebar chapter picks as external selections (fresh seq) while flip syncs never bump it', () => {
    renderShell({ mode: 'reading-review' });
    expect(readingProbe.props).not.toBeNull();

    fireEvent.click(screen.getByTitle('Storm'));
    expect(readingProbe.props!.activeChapter).toBe(2);
    expect(readingProbe.props!.chapterSelection).toEqual({ chapterNumber: 2, seq: 1 });

    // A page-flip sync (onActiveChapterChange) must NOT mint a new selection
    // token — the flipbook relies on the seq to decide chapter-start jumps.
    act(() => {
      readingProbe.props!.onActiveChapterChange?.(1);
    });
    expect(readingProbe.props!.activeChapter).toBe(1);
    expect(readingProbe.props!.chapterSelection).toEqual({ chapterNumber: 2, seq: 1 });
  });

  it('routes the jump-to-chapter input through the external-selection path', () => {
    renderShell({ mode: 'reading-review' });
    act(() => {
      readingProbe.props!.onChapterJump?.(2);
    });
    expect(readingProbe.props!.activeChapter).toBe(2);
    expect(readingProbe.props!.chapterSelection).toEqual({ chapterNumber: 2, seq: 1 });
  });
});
