// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NovelWorkspace } from '@/components/NovelWorkspace';
import { NOVEL_UPDATED_EVENT, type NovelUpdatedEventDetail } from '@/lib/use-storage';

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  startWriting: vi.fn(),
  fetchNovel: vi.fn(),
  fetchChapters: vi.fn(),
  refreshNovel: vi.fn(),
  refreshDeck: vi.fn(),
  refreshCoverage: vi.fn(),
  downloadBundle: vi.fn(),
  updateNovel: vi.fn(),
  patchNovelLocal: vi.fn(),
  toast: vi.fn(),
  flush: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
  deckCoverage: {
    counts: { character: 1, world: 1, outline: 1 },
    complete: true,
  },
  agentPaneProps: null as {
    activeConvId: string | null;
    setActiveConvId: (id: string | null) => void;
    storyDeckRepairRequest: number;
    repairPhase: string;
    onStatusChange: (status: 'submitted' | 'streaming' | 'ready' | 'error') => void;
    onRepairPhaseChange: (phase: 'running' | 'succeeded' | 'failed') => void;
  } | null,
  manuscriptNovel: {
    id: 'novel-a',
    title: 'Stale Manuscript Title',
    genre: 'Fantasy',
    stage: 'ready_for_greenlight',
    progress: 12,
    settings: { creativity: 'balanced' },
  } as {
    id: string;
    title: string;
    genre: string;
    stage: string;
    progress: number;
    settings: { creativity: string };
  } | null,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.params,
}));
vi.mock('@/components/LanguageProvider', () => ({
  useLanguage: () => ({
    t: {
      errorSubmitFailed: 'Submit failed',
      errorUpdateNovel: 'Update failed',
      editorSaveError: 'Save failed — will retry',
      toastRetry: 'Retry',
      stageStoryReady: 'Story Ready',
      stageApproval: 'Approval',
      storyDeckReviewAction: 'Review Story Deck',
      agentMode: 'Agent',
      storyDeckMode: 'Story',
      readEditMode: 'Manuscript',
      novelModeNav: 'Modes',
      editTitle: 'Edit title',
      titlePlaceholder: 'Title',
      untitledNovel: 'Untitled',
    },
  }),
}));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock('@/lib/desktop-shell-bus', async () => {
  const actual = await vi.importActual<typeof import('@/lib/desktop-shell-bus')>(
    '@/lib/desktop-shell-bus',
  );
  return {
    ...actual,
    requestManuscriptFlush: mocks.flush,
  };
});
vi.mock('@/app/actions/conversations', () => ({
  createConversation: vi.fn(),
}));
vi.mock('@/lib/use-storage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-storage')>(
    '@/lib/use-storage',
  );
  return {
    ...actual,
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
      update: mocks.updateNovel,
    }),
  };
});
vi.mock('@/lib/use-manuscript-session', () => ({
  useManuscriptSession: () => ({
    novel: mocks.manuscriptNovel,
    isStreaming: false,
    fetchNovel: mocks.fetchNovel,
    fetchChapters: mocks.fetchChapters,
    startWriting: mocks.startWriting,
    patchNovelLocal: mocks.patchNovelLocal,
  }),
}));
vi.mock('@/components/novel-workspace/useStoryDeckCoverage', () => ({
  useStoryDeckCoverage: () => ({
    counts: mocks.deckCoverage.counts,
    complete: mocks.deckCoverage.complete,
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
    novel,
    view,
    setView,
    editingTitle,
    titleDraft,
    setTitleDraft,
    setEditingTitle,
    handleTitleSave,
  }: {
    novel: { title?: string } | null;
    view: string;
    setView: (view: 'agent' | 'story-deck' | 'read-edit') => void;
    editingTitle: boolean;
    titleDraft: string;
    setTitleDraft: (value: string) => void;
    setEditingTitle: (value: boolean) => void;
    handleTitleSave: () => void;
  }) => (
    <div>
      <span data-testid="active-view">{view}</span>
      <span data-testid="live-title">{novel?.title ?? ''}</span>
      {editingTitle ? (
        <input
          aria-label="Title draft"
          value={titleDraft}
          onChange={event => setTitleDraft(event.target.value)}
          onBlur={() => { void handleTitleSave(); }}
        />
      ) : (
        <button type="button" onClick={() => {
          setTitleDraft(novel?.title || '');
          setEditingTitle(true);
        }}
        >
          Edit title
        </button>
      )}
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
    onCompleteDeck,
  }: {
    onApprove: () => void;
    onReviewDeck: () => void;
    onCompleteDeck?: () => void;
  }) => (
    <div>
      <button type="button" onClick={onApprove}>Approve</button>
      <button type="button" onClick={onReviewDeck}>Review deck</button>
      <button type="button" onClick={onCompleteDeck}>Complete deck</button>
    </div>
  ),
}));
vi.mock('@/components/novel-workspace/AgentWorkspacePane', () => ({
  AgentWorkspacePane: (props: {
    activeConvId: string | null;
    setActiveConvId: (id: string | null) => void;
    storyDeckRepairRequest: number;
    repairPhase: string;
    onStatusChange: (status: 'submitted' | 'streaming' | 'ready' | 'error') => void;
    onRepairPhaseChange: (phase: 'running' | 'succeeded' | 'failed') => void;
  }) => {
    mocks.agentPaneProps = props;
    return (
      <div
        data-testid="agent-pane"
        data-repair-request={props.storyDeckRepairRequest}
        data-repair-phase={props.repairPhase}
        data-active-conversation={props.activeConvId ?? ''}
      >
        Agent pane
      </div>
    );
  },
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
  mocks.deckCoverage = {
    counts: { character: 1, world: 1, outline: 1 },
    complete: true,
  };
  mocks.agentPaneProps = null;
  mocks.manuscriptNovel = {
    id: 'novel-a',
    title: 'Stale Manuscript Title',
    genre: 'Fantasy',
    stage: 'ready_for_greenlight',
    progress: 12,
    settings: { creativity: 'balanced' },
  };
  mocks.flush.mockResolvedValue({ ok: true });
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

  it('routes the manuscript outline action to the Story Deck outline tab after a successful flush', async () => {
    render(<NovelWorkspace novelId="novel-a" initialView="read-edit" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit outline' }));

    await waitFor(() => {
      expect(mocks.flush).toHaveBeenCalledOnce();
      expect(screen.getByTestId('story-pane').getAttribute('data-tab')).toBe('outline');
      expect(screen.getByTestId('active-view').textContent).toBe('story-deck');
    });
  });

  it('refreshes both novel copies and Story Deck ownership on focus', () => {
    render(<NovelWorkspace novelId="novel-a" />);
    window.dispatchEvent(new Event('focus'));

    expect(mocks.refreshDeck).toHaveBeenCalledOnce();
    expect(mocks.refreshNovel).toHaveBeenCalledOnce();
    expect(mocks.fetchNovel).toHaveBeenCalledOnce();
    expect(mocks.fetchChapters).toHaveBeenCalledOnce();
  });

  it('patches the manuscript novel copy after a successful title save', async () => {
    mocks.updateNovel.mockResolvedValue({
      id: 'novel-a',
      title: 'Canonical Title',
      genre: 'Fantasy',
      targetWords: 80_000,
      updatedAt: 42,
    });
    // Simulate useNovel.update's successful fan-out.
    mocks.updateNovel.mockImplementation(async () => {
      const updated = {
        id: 'novel-a',
        title: 'Canonical Title',
        genre: 'Fantasy',
        targetWords: 80_000,
        updatedAt: 42,
      };
      window.dispatchEvent(new CustomEvent<NovelUpdatedEventDetail>(NOVEL_UPDATED_EVENT, {
        detail: { novel: updated as never },
      }));
      return updated;
    });

    render(<NovelWorkspace novelId="novel-a" />);
    expect(screen.getByTestId('live-title').textContent).toBe('Stale Manuscript Title');

    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }));
    fireEvent.change(screen.getByLabelText('Title draft'), {
      target: { value: 'Canonical Title' },
    });
    fireEvent.blur(screen.getByLabelText('Title draft'));

    await waitFor(() => {
      expect(mocks.updateNovel).toHaveBeenCalledWith({ title: 'Canonical Title' });
      expect(mocks.patchNovelLocal).toHaveBeenCalledWith({
        title: 'Canonical Title',
        genre: 'Fantasy',
        targetWords: 80_000,
        updatedAt: 42,
      });
    });
  });

  it('does not patch the manuscript copy or publish when title save fails', async () => {
    const listener = vi.fn();
    window.addEventListener(NOVEL_UPDATED_EVENT, listener);
    mocks.updateNovel.mockResolvedValue(null);

    render(<NovelWorkspace novelId="novel-a" />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }));
    fireEvent.change(screen.getByLabelText('Title draft'), {
      target: { value: 'Lost Title' },
    });
    fireEvent.blur(screen.getByLabelText('Title draft'));

    await waitFor(() => {
      expect(mocks.updateNovel).toHaveBeenCalledOnce();
      expect(mocks.toast).toHaveBeenCalled();
    });
    expect(mocks.patchNovelLocal).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(NOVEL_UPDATED_EVENT, listener);
  });

  it('awaits manuscript flush before leaving read-edit and keeps the pane on failure', async () => {
    let resolveFlush!: (value: { ok: boolean }) => void;
    mocks.flush.mockImplementation(() => new Promise<{ ok: boolean }>(resolve => {
      resolveFlush = resolve;
    }));

    render(<NovelWorkspace novelId="novel-a" initialView="read-edit" />);
    expect(screen.getByTestId('manuscript-pane')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(screen.getByTestId('active-view').textContent).toBe('read-edit');
    expect(screen.getByTestId('manuscript-pane')).toBeTruthy();

    resolveFlush({ ok: false });
    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith('Save failed — will retry', 'error');
    });
    expect(screen.getByTestId('active-view').textContent).toBe('read-edit');
    expect(screen.queryByTestId('story-pane')).toBeNull();
  });

  it('uses the same flush barrier for native menu workspace transitions', async () => {
    mocks.flush.mockResolvedValue({ ok: true });
    render(<NovelWorkspace novelId="novel-a" initialView="read-edit" />);

    fireEvent(window, new CustomEvent('inkmarshal://menu', {
      detail: { view: 'agent' },
    }));

    await waitFor(() => {
      expect(mocks.flush).toHaveBeenCalledOnce();
      expect(screen.getByTestId('active-view').textContent).toBe('agent');
    });
    expect(screen.queryByTestId('manuscript-pane')).toBeNull();
  });
});

describe('NovelWorkspace Story Deck repair orchestration', () => {
  function agentPane() {
    return screen.getByTestId('agent-pane');
  }

  it('switches to the assistant and queues exactly one repair request', () => {
    mocks.deckCoverage = {
      counts: { character: 0, world: 0, outline: 0 },
      complete: false,
    };
    render(<NovelWorkspace novelId="novel-a" initialView="story-deck" />);
    expect(screen.getByTestId('active-view').textContent).toBe('story-deck');

    fireEvent.click(screen.getByRole('button', { name: 'Complete deck' }));

    expect(screen.getByTestId('active-view').textContent).toBe('agent');
    expect(agentPane().getAttribute('data-repair-request')).toBe('1');
    expect(agentPane().getAttribute('data-repair-phase')).toBe('queued');
  });

  it('returns to the main Assistant thread before queuing a Story Deck repair', () => {
    mocks.deckCoverage = {
      counts: { character: 0, world: 0, outline: 0 },
      complete: false,
    };
    render(<NovelWorkspace novelId="novel-a" initialView="story-deck" />);
    act(() => mocks.agentPaneProps?.setActiveConvId('side-thread'));
    expect(agentPane().getAttribute('data-active-conversation')).toBe('side-thread');

    fireEvent.click(screen.getByRole('button', { name: 'Complete deck' }));

    expect(agentPane().getAttribute('data-active-conversation')).toBe('');
    expect(agentPane().getAttribute('data-repair-request')).toBe('1');
  });

  it('never enqueues a duplicate repair while queued or running, retries after failure, and resets after success', () => {
    mocks.deckCoverage = {
      counts: { character: 0, world: 2, outline: 0 },
      complete: false,
    };
    render(<NovelWorkspace novelId="novel-a" />);
    const completeDeck = () => screen.getByRole('button', { name: 'Complete deck' });

    fireEvent.click(completeDeck());
    fireEvent.click(completeDeck());
    expect(agentPane().getAttribute('data-repair-request')).toBe('1');

    act(() => mocks.agentPaneProps?.onRepairPhaseChange('running'));
    expect(agentPane().getAttribute('data-repair-phase')).toBe('running');
    fireEvent.click(completeDeck());
    expect(agentPane().getAttribute('data-repair-request')).toBe('1');

    act(() => mocks.agentPaneProps?.onRepairPhaseChange('failed'));
    expect(agentPane().getAttribute('data-repair-phase')).toBe('failed');
    fireEvent.click(completeDeck());
    expect(agentPane().getAttribute('data-repair-request')).toBe('2');
    expect(agentPane().getAttribute('data-repair-phase')).toBe('queued');

    act(() => mocks.agentPaneProps?.onRepairPhaseChange('succeeded'));
    expect(agentPane().getAttribute('data-repair-phase')).toBe('idle');
    fireEvent.click(completeDeck());
    expect(agentPane().getAttribute('data-repair-request')).toBe('3');
  });

  it('does not enqueue recovery while another Assistant turn is active', () => {
    mocks.deckCoverage = {
      counts: { character: 0, world: 0, outline: 0 },
      complete: false,
    };
    render(<NovelWorkspace novelId="novel-a" initialView="story-deck" />);

    act(() => mocks.agentPaneProps?.onRepairPhaseChange('failed'));
    act(() => mocks.agentPaneProps?.onStatusChange('streaming'));
    fireEvent.click(screen.getByRole('button', { name: 'Complete deck' }));
    expect(agentPane().getAttribute('data-repair-request')).toBe('0');

    act(() => mocks.agentPaneProps?.onStatusChange('ready'));
    fireEvent.click(screen.getByRole('button', { name: 'Complete deck' }));
    expect(agentPane().getAttribute('data-repair-request')).toBe('1');
  });
});
