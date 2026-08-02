// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatArea } from '@/components/ChatArea';
import { LocaleProvider } from '@/components/LanguageProvider';
import type {
  NovelChatRuntimeArgs,
  NovelChatTurnOutcome,
} from '@/components/assistant-ui/useNovelChatRuntime';

const mocks = vi.hoisted(() => ({
  status: 'ready' as 'submitted' | 'streaming' | 'ready' | 'error',
  loading: false,
  retryKind: 'ordinary' as 'history' | 'ordinary' | 'repair' | 'stopped',
  retry: vi.fn(async () => {}),
  sendMessage: vi.fn(async (_text: string, _body?: Record<string, unknown>) => {}),
  onSavingChange: null as ((saving: boolean) => void) | null,
  runtimeArgs: null as NovelChatRuntimeArgs | null,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@assistant-ui/react', () => ({
  AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/assistant-ui/thread', () => ({
  NovelThread: ({ composerControls, onRetry }: { composerControls?: React.ReactNode; onRetry?: () => void }) => (
    <div data-testid="novel-thread">
      {composerControls}
      <button type="button" onClick={onRetry}>Retry chat</button>
    </div>
  ),
}));
vi.mock('@/components/assistant-ui/useNovelChatRuntime', () => ({
  stoppedPersistenceLabel: () => '<!-- INKMARSHAL_CHAT_STOPPED_V1 -->\n[Stopped]',
  useNovelChatRuntime: (args: NovelChatRuntimeArgs) => {
    mocks.runtimeArgs = args;
    return {
      runtime: {},
      status: mocks.status,
      messages: [],
      loading: mocks.loading,
      errorMessage: null,
      retryKind: mocks.retryKind,
      retry: mocks.retry,
      refresh: vi.fn(),
      sendMessage: mocks.sendMessage,
    };
  },
}));
vi.mock('@/components/writing/CreativityPicker', () => ({
  CreativityPicker: () => null,
}));
vi.mock('@/components/writing/ChatModelPicker', () => ({
  ChatModelPicker: ({ onSavingChange }: { onSavingChange: (saving: boolean) => void }) => {
    mocks.onSavingChange = onSavingChange;
    return null;
  },
}));
vi.mock('@/components/EmptyChatInterviewGuide', () => ({
  EmptyChatInterviewGuide: () => null,
}));
vi.mock('@/hooks/useNovelCreativity', () => ({
  useNovelCreativity: () => ({
    creativity: 'balanced',
    setCreativity: vi.fn(),
    syncFailed: false,
  }),
}));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function renderChatArea(props: {
  autoSubmitRequest?: number;
  onRepairPhaseChange?: (phase: 'running' | 'succeeded' | 'failed') => void;
} = {}) {
  return render(
    <LocaleProvider>
      <ChatArea
        novelId="novel-1"
        onUpdate={vi.fn()}
        autoSubmitRequest={props.autoSubmitRequest ?? 0}
        autoSubmitText="Repair the deck"
        onRepairPhaseChange={props.onRepairPhaseChange}
      />
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.status = 'ready';
  mocks.loading = false;
  mocks.retryKind = 'ordinary';
  mocks.onSavingChange = null;
  mocks.runtimeArgs = null;
});

function finishTurn(outcome: NovelChatTurnOutcome) {
  act(() => {
    mocks.runtimeArgs?.onTurnFinish?.(outcome);
  });
}

describe('ChatArea Story Deck repair auto-submit', () => {
  it('sends exactly one repairStoryDeck turn when a repair request arrives', async () => {
    const onRepairPhaseChange = vi.fn();
    renderChatArea({ autoSubmitRequest: 1, onRepairPhaseChange });

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    expect(mocks.sendMessage).toHaveBeenCalledWith('Repair the deck', { repairStoryDeck: true });
    expect(onRepairPhaseChange).toHaveBeenCalledWith('running');
  });

  it('does not resend the same request across rerenders', async () => {
    const view = renderChatArea({ autoSubmitRequest: 1 });
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));

    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
        />
      </LocaleProvider>,
    );
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
        />
      </LocaleProvider>,
    );
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('waits while the chat is busy or history is loading, then sends once ready', async () => {
    mocks.status = 'streaming';
    const view = renderChatArea({ autoSubmitRequest: 1 });
    await act(async () => {});
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    mocks.status = 'ready';
    mocks.loading = true;
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
        />
      </LocaleProvider>,
    );
    await act(async () => {});
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    mocks.loading = false;
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
        />
      </LocaleProvider>,
    );
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
  });

  it('defers the repair while model selection is saving, then sends exactly once', async () => {
    const view = renderChatArea();
    expect(mocks.onSavingChange).toBeTruthy();
    act(() => mocks.onSavingChange?.(true));

    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
        />
      </LocaleProvider>,
    );
    await act(async () => {});
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    act(() => mocks.onSavingChange?.(false));
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
  });

  it('reports succeeded only from a successful finish outcome for the repair turn', async () => {
    const onRepairPhaseChange = vi.fn();
    const view = renderChatArea({ autoSubmitRequest: 1, onRepairPhaseChange });
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    expect(onRepairPhaseChange.mock.calls.map(([phase]) => phase)).toEqual(['running']);

    // Status churn alone must never settle the repair turn.
    mocks.status = 'streaming';
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );
    mocks.status = 'ready';
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );
    await act(async () => {});
    expect(onRepairPhaseChange.mock.calls.map(([phase]) => phase)).toEqual(['running']);

    finishTurn('succeeded');
    expect(onRepairPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
      'running',
      'succeeded',
    ]);
  });

  it('reports failed on a failed finish outcome and lets the next request retry the repair', async () => {
    const onRepairPhaseChange = vi.fn();
    const view = renderChatArea({ autoSubmitRequest: 1, onRepairPhaseChange });
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));

    mocks.status = 'error';
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );
    finishTurn('failed');
    expect(onRepairPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
      'running',
      'failed',
    ]);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

    // Retry: a fresh request is accepted even though the status is `error`
    // (sendMessage clears the error before the new turn starts).
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={2}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));
    expect(mocks.sendMessage).toHaveBeenLastCalledWith('Repair the deck', { repairStoryDeck: true });
  });

  it('re-enters the repair lifecycle when generic chat Retry regenerates a failed repair', async () => {
    const onRepairPhaseChange = vi.fn();
    const view = renderChatArea({ autoSubmitRequest: 1, onRepairPhaseChange });
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));

    finishTurn('failed');
    mocks.status = 'error';
    mocks.retryKind = 'repair';
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry chat' }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(onRepairPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
      'running',
      'failed',
      'running',
    ]);

    mocks.status = 'streaming';
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry chat' }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);

    finishTurn('succeeded');
    expect(onRepairPhaseChange).toHaveBeenLastCalledWith('succeeded');
  });

  it('reports failed — never succeeded — when the repair turn is aborted (Stop)', async () => {
    const onRepairPhaseChange = vi.fn();
    const view = renderChatArea({ autoSubmitRequest: 1, onRepairPhaseChange });
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));

    // The SDK returns to `ready` after an abort, exactly like a success.
    mocks.status = 'streaming';
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );
    mocks.status = 'ready';
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={1}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );
    finishTurn('aborted');

    expect(onRepairPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
      'running',
      'failed',
    ]);

    // The aborted turn is settled: a later finish outcome must not re-settle,
    // and the next repair request still runs.
    finishTurn('succeeded');
    expect(onRepairPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
      'running',
      'failed',
    ]);
    view.rerender(
      <LocaleProvider>
        <ChatArea
          novelId="novel-1"
          onUpdate={vi.fn()}
          autoSubmitRequest={2}
          autoSubmitText="Repair the deck"
          onRepairPhaseChange={onRepairPhaseChange}
        />
      </LocaleProvider>,
    );
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(2));
  });

  it('ignores finish outcomes for turns that are not the repair turn', async () => {
    const onRepairPhaseChange = vi.fn();
    renderChatArea({ autoSubmitRequest: 0, onRepairPhaseChange });

    finishTurn('succeeded');
    finishTurn('aborted');
    finishTurn('failed');
    expect(onRepairPhaseChange).not.toHaveBeenCalled();
  });

  it('reports failed when the send itself rejects before the turn starts', async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error('transport down'));
    const onRepairPhaseChange = vi.fn();
    renderChatArea({ autoSubmitRequest: 1, onRepairPhaseChange });

    await waitFor(() =>
      expect(onRepairPhaseChange.mock.calls.map(([phase]) => phase)).toEqual([
        'running',
        'failed',
      ]),
    );
  });
});
