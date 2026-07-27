// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NovelWorkspace } from '@/components/NovelWorkspace';

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  startWriting: vi.fn(),
  fetchNovel: vi.fn(),
  fetchChapters: vi.fn(),
  refreshNovel: vi.fn(),
  refreshDeck: vi.fn(),
  refreshCoverage: vi.fn(),
  downloadBundle: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.params,
}));
vi.mock('@/components/LanguageProvider', () => ({
  useLanguage: () => ({
    t: {
      errorSubmitFailed: 'Submit failed',
      errorUpdateNovel: 'Update failed',
      toastRetry: 'Retry',
      stageStoryReady: 'Story Ready',
      stageApproval: 'Approval',
      storyDeckReviewAction: 'Review Story Deck',
    },
  }),
}));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock('@/app/actions/conversations', () => ({
  createConversation: vi.fn(),
}));
vi.mock('@/lib/use-storage', () => ({
  useNovel: () => ({
    novel: {
      id: 'novel-a',
      title: 'Novel A',
      genre: 'Fantasy',
      stage: 'ready_for_greenlight',
      progress: 12,
      settings: { creativity: 'balanced' },
    },
    refresh: mocks.refreshNovel,
    update: vi.fn(),
  }),
}));
vi.mock('@/lib/use-manuscript-session', () => ({
  useManuscriptSession: () => ({
    novel: null,
    isStreaming: false,
    fetchNovel: mocks.fetchNovel,
    fetchChapters: mocks.fetchChapters,
    startWriting: mocks.startWriting,
  }),
}));
vi.mock('@/components/novel-workspace/useStoryDeckCoverage', () => ({
  useStoryDeckCoverage: () => ({
    counts: { character: 1, world: 1, outline: 1 },
    complete: true,
    loading: false,
    panelRefreshToken: 7,
    refreshCoverage: mocks.refreshCoverage,
    refreshAll: mocks.refreshDeck,
  }),
}));
vi.mock('@/components/novel-workspace/useNovelBundleExport', () => ({
  useNovelBundleExport: () => mocks.downloadBundle,
}));
vi.mock('@/components/NovelTopBar', () => ({
  NovelTopBar: ({
    view,
    setView,
  }: {
    view: string;
    setView: (view: 'agent' | 'story-deck' | 'read-edit') => void;
  }) => (
    <div>
      <span data-testid="active-view">{view}</span>
      <button type="button" onClick={() => setView('agent')}>Agent</button>
      <button type="button" onClick={() => setView('story-deck')}>Story</button>
      <button type="button" onClick={() => setView('read-edit')}>Manuscript</button>
    </div>
  ),
}));
vi.mock('@/components/StageBar', () => ({
  StageBar: ({
    onApprove,
    onReviewDeck,
  }: {
    onApprove: () => void;
    onReviewDeck: () => void;
  }) => (
    <div>
      <button type="button" onClick={onApprove}>Approve</button>
      <button type="button" onClick={onReviewDeck}>Review deck</button>
    </div>
  ),
}));
vi.mock('@/components/novel-workspace/AgentWorkspacePane', () => ({
  AgentWorkspacePane: () => <div data-testid="agent-pane">Agent pane</div>,
}));
vi.mock('@/components/novel-workspace/StoryDeckWorkspacePane', () => ({
  StoryDeckWorkspacePane: ({
    tab,
  }: {
    tab: string;
  }) => <div data-testid="story-pane" data-tab={tab}>Story pane</div>,
}));
vi.mock('@/components/novel-workspace/ManuscriptWorkspacePane', () => ({
  ManuscriptWorkspacePane: ({
    onJumpToOutline,
  }: {
    onJumpToOutline: () => void;
  }) => (
    <div data-testid="manuscript-pane">
      <button type="button" onClick={onJumpToOutline}>Edit outline</button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.params = new URLSearchParams();
  window.history.replaceState(null, '', '/novel/novel-a');
});

describe('NovelWorkspace mode orchestration', () => {
  it('keeps the assistant runtime mounted while other workspace modes are visible', () => {
    render(<NovelWorkspace novelId="novel-a" />);
    expect(screen.getByTestId('agent-pane')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    expect(screen.getByTestId('story-pane')).toBeTruthy();
    expect(screen.getByTestId('agent-pane')).toBeTruthy();
    expect(screen.getByTestId('agent-pane').parentElement?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Manuscript' }));
    expect(screen.getByTestId('manuscript-pane')).toBeTruthy();
    expect(screen.getByTestId('agent-pane')).toBeTruthy();
  });

  it('starts writing directly and moves to the manuscript in the same action', () => {
    render(<NovelWorkspace novelId="novel-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(mocks.startWriting).toHaveBeenCalledOnce();
    expect(screen.getByTestId('active-view').textContent).toBe('read-edit');
  });

  it('routes the manuscript outline action to the Story Deck outline tab', () => {
    render(<NovelWorkspace novelId="novel-a" initialView="read-edit" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit outline' }));

    expect(screen.getByTestId('story-pane').getAttribute('data-tab')).toBe('outline');
    expect(screen.getByTestId('active-view').textContent).toBe('story-deck');
  });

  it('refreshes both novel copies and Story Deck ownership on focus', () => {
    render(<NovelWorkspace novelId="novel-a" />);
    window.dispatchEvent(new Event('focus'));

    expect(mocks.refreshDeck).toHaveBeenCalledOnce();
    expect(mocks.refreshNovel).toHaveBeenCalledOnce();
    expect(mocks.fetchNovel).toHaveBeenCalledOnce();
    expect(mocks.fetchChapters).toHaveBeenCalledOnce();
  });
});
