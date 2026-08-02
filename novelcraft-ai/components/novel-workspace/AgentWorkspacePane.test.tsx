// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatStatus } from 'ai';

import { AgentWorkspacePane } from '@/components/novel-workspace/AgentWorkspacePane';
import { LocaleProvider } from '@/components/LanguageProvider';
import type { DeckCounts, StoryDeckRepairPhase } from '@/components/novel-workspace/types';
import type { Novel } from '@/lib/db-types';

const mocks = vi.hoisted(() => ({
  chatAreaProps: null as {
    autoSubmitRequest: number;
    onStatusChange: (status: ChatStatus) => void;
    completionContent: React.ReactNode;
  } | null,
  panelProps: null as {
    repairPhase: StoryDeckRepairPhase;
    onAdjustProposal: () => void;
  } | null,
}));

vi.mock('@/components/ChatArea', () => ({
  ChatArea: (props: {
    autoSubmitRequest: number;
    onStatusChange: (status: ChatStatus) => void;
    completionContent: React.ReactNode;
  }) => {
    mocks.chatAreaProps = props;
    return (
      <div data-testid="chat-area" data-repair-request={props.autoSubmitRequest}>
        {props.completionContent}
      </div>
    );
  },
}));
vi.mock('@/components/conversations/ConversationList', () => ({
  ConversationList: () => null,
}));
vi.mock('@/components/conversations/ConversationThread', () => ({
  ConversationThread: () => null,
}));
vi.mock('@/components/ProposalReviewPanel', () => ({
  ProposalReviewPanel: (props: {
    repairPhase: StoryDeckRepairPhase;
    onAdjustProposal: () => void;
  }) => {
    mocks.panelProps = props;
    return (
      <div data-testid="proposal-panel" data-repair-phase={props.repairPhase}>
        <button type="button" onClick={props.onAdjustProposal}>
          Adjust proposal
        </button>
      </div>
    );
  },
}));
vi.mock('@/components/ui/sheet', () => ({
  Sheet: () => null,
  SheetContent: () => null,
  SheetHeader: () => null,
  SheetTitle: () => null,
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

const NOVEL = {
  id: 'novel-1',
  title: 'Novel A',
  genre: 'Fantasy',
  stage: 'ready_for_greenlight',
  progress: 0,
  targetWords: 80_000,
  storySummary: 'A summary.',
} as Novel;

const INCOMPLETE_DECK: DeckCounts = { character: 0, world: 0, outline: 1 };

function renderPane(overrides: {
  storyDeckRepairRequest?: number;
  repairPhase?: StoryDeckRepairPhase;
} = {}) {
  return render(
    <LocaleProvider>
      <AgentWorkspacePane
        novelId="novel-1"
        novel={NOVEL}
        deckCounts={INCOMPLETE_DECK}
        deckLoading={false}
        activeConvId={null}
        setActiveConvId={vi.fn()}
        onCreateConversation={vi.fn()}
        onUpdate={vi.fn()}
        onStatusChange={vi.fn()}
        chatStatus="ready"
        onStartWriting={vi.fn()}
        onReviewDeck={vi.fn()}
        onCompleteDeck={vi.fn()}
        storyDeckRepairRequest={overrides.storyDeckRepairRequest ?? 0}
        repairPhase={overrides.repairPhase ?? 'idle'}
        onRepairPhaseChange={vi.fn()}
      />
    </LocaleProvider>,
  );
}

function rerenderPane(
  view: ReturnType<typeof renderPane>,
  overrides: {
    storyDeckRepairRequest?: number;
    repairPhase?: StoryDeckRepairPhase;
  },
) {
  view.rerender(
    <LocaleProvider>
      <AgentWorkspacePane
        novelId="novel-1"
        novel={NOVEL}
        deckCounts={INCOMPLETE_DECK}
        deckLoading={false}
        activeConvId={null}
        setActiveConvId={vi.fn()}
        onCreateConversation={vi.fn()}
        onUpdate={vi.fn()}
        onStatusChange={vi.fn()}
        chatStatus="ready"
        onStartWriting={vi.fn()}
        onReviewDeck={vi.fn()}
        onCompleteDeck={vi.fn()}
        storyDeckRepairRequest={overrides.storyDeckRepairRequest ?? 0}
        repairPhase={overrides.repairPhase ?? 'idle'}
        onRepairPhaseChange={vi.fn()}
      />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.chatAreaProps = null;
  mocks.panelProps = null;
});

describe('AgentWorkspacePane Story Deck repair recovery UI', () => {
  it('keeps the recovery panel mounted through queued, running, and failed repair states', () => {
    const view = renderPane();
    expect(screen.getByTestId('proposal-panel').getAttribute('data-repair-phase')).toBe('idle');

    // A changed repair request counter must NOT unmount the panel: the
    // recovery UI owns the queued/running/failed states.
    rerenderPane(view, { storyDeckRepairRequest: 1, repairPhase: 'queued' });
    expect(screen.getByTestId('proposal-panel').getAttribute('data-repair-phase')).toBe('queued');
    expect(screen.getByTestId('chat-area').getAttribute('data-repair-request')).toBe('1');

    rerenderPane(view, { storyDeckRepairRequest: 1, repairPhase: 'running' });
    expect(screen.getByTestId('proposal-panel').getAttribute('data-repair-phase')).toBe('running');

    rerenderPane(view, { storyDeckRepairRequest: 1, repairPhase: 'failed' });
    expect(screen.getByTestId('proposal-panel').getAttribute('data-repair-phase')).toBe('failed');

    // Retry: a new request while failed still keeps the panel visible.
    rerenderPane(view, { storyDeckRepairRequest: 2, repairPhase: 'queued' });
    expect(screen.getByTestId('proposal-panel').getAttribute('data-repair-phase')).toBe('queued');
    expect(screen.getByTestId('chat-area').getAttribute('data-repair-request')).toBe('2');
  });

  it('manual Adjust proposal still reveals the chat until the next turn settles', () => {
    renderPane();
    expect(screen.getByTestId('proposal-panel')).toBeTruthy();

    act(() => {
      screen.getByRole('button', { name: 'Adjust proposal' }).click();
    });
    expect(screen.queryByTestId('proposal-panel')).toBeNull();

    act(() => {
      mocks.chatAreaProps?.onStatusChange('streaming');
    });
    expect(screen.queryByTestId('proposal-panel')).toBeNull();

    act(() => {
      mocks.chatAreaProps?.onStatusChange('ready');
    });
    expect(screen.getByTestId('proposal-panel')).toBeTruthy();
  });

  it('a repair request during manual adjustment does not resurrect the panel prematurely', () => {
    const view = renderPane();
    act(() => {
      screen.getByRole('button', { name: 'Adjust proposal' }).click();
    });
    expect(screen.queryByTestId('proposal-panel')).toBeNull();

    rerenderPane(view, { storyDeckRepairRequest: 1, repairPhase: 'queued' });
    expect(screen.queryByTestId('proposal-panel')).toBeNull();

    act(() => {
      mocks.chatAreaProps?.onStatusChange('ready');
    });
    expect(screen.getByTestId('proposal-panel').getAttribute('data-repair-phase')).toBe('queued');
  });
});
