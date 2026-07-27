// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManuscriptWorkspacePane } from '@/components/novel-workspace/ManuscriptWorkspacePane';
import type { ManuscriptSession } from '@/lib/use-manuscript-session';
import { IDLE_WRITING_RUN_STATE } from '@/lib/writing/writing-run-reducer';

vi.mock('@/components/LanguageProvider', () => ({
  useLanguage: () => ({
    t: {
      loading: 'Loading',
      errorLoadManuscript: 'Could not load manuscript',
      toastRetry: 'Retry load',
      writingBatchDone: 'Batch done at {chapter}',
      writingBatchRemaining: '{remaining} remaining',
      writingEditBlueprint: 'Edit blueprint',
      writingNextChapter: 'Next chapter',
      resumeWritingTitle: 'Resume writing',
      resumeWritingDesc: 'Continuing in {seconds}',
      resumeWritingPause: 'Paused',
      resumeWritingCancel: 'Cancel',
      resumeWritingNow: 'Resume now',
      untitledNovel: 'Untitled',
      writingPreviewModelPending: 'Resolving model',
    },
  }),
}));
vi.mock('@/components/WritingModelStatusBar', () => ({
  useCapabilityBinding: () => ({
    resolved: { binding: null, conn: null },
  }),
}));
vi.mock('@/components/ManuscriptShell', () => ({
  ManuscriptShell: ({
    writingRunControls,
  }: {
    writingRunControls: {
      onPause?: () => void;
      onResume?: () => void;
      onRetry?: () => void;
    };
  }) => (
    <div data-testid="manuscript-shell">
      {writingRunControls.onPause && (
        <button type="button" onClick={writingRunControls.onPause}>Pause run</button>
      )}
      {writingRunControls.onResume && (
        <button type="button" onClick={writingRunControls.onResume}>Resume run</button>
      )}
      {writingRunControls.onRetry && (
        <button type="button" onClick={writingRunControls.onRetry}>Retry run</button>
      )}
    </div>
  ),
}));

function session(
  overrides: Partial<ManuscriptSession> = {},
): ManuscriptSession {
  return {
    novel: {
      id: 'novel-a',
      title: 'Novel A',
      genre: 'Fantasy',
      stage: 'autonomous_writing',
      progress: 20,
      targetWords: 80_000,
      settings: {},
    } as ManuscriptSession['novel'],
    chapters: [],
    isLoading: false,
    statusLabel: '',
    didRequestAutostart: false,
    isStreaming: false,
    liveChapter: null,
    resumeCountdown: null,
    resumePromptVisible: false,
    batchDone: null,
    writingRunState: IDLE_WRITING_RUN_STATE,
    fetchNovel: vi.fn(),
    fetchChapters: vi.fn(),
    startWriting: vi.fn().mockResolvedValue(undefined),
    pauseWriting: vi.fn(),
    cancelResume: vi.fn(),
    dismissBatchDone: vi.fn(),
    patchNovelLocal: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe('ManuscriptWorkspacePane writing controls', () => {
  it('keeps Continue single-owned by the visible batch notice', () => {
    const current = session({
      batchDone: { completedChapter: 4, remaining: 8 },
      resumePromptVisible: true,
      writingRunState: {
        ...IDLE_WRITING_RUN_STATE,
        runId: 3,
        phase: 'paused',
      },
    });
    render(
      <ManuscriptWorkspacePane
        novelId="novel-a"
        manuscript={current}
        showUnification={false}
        onJumpToOutline={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Next chapter' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();
    expect(screen.queryByText('Resume writing')).toBeNull();

    const noticeInner = screen.getByText('Batch done at 4').closest('div');
    expect(noticeInner?.parentElement?.className).toContain('rounded-lg');
    expect(noticeInner?.parentElement?.className).not.toContain('rounded-full');

    fireEvent.click(screen.getByRole('button', { name: 'Next chapter' }));
    expect(current.dismissBatchDone).toHaveBeenCalledOnce();
    expect(current.startWriting).toHaveBeenCalledWith({ chapters: 1 });
  });

  it('routes pause and resume controls through the session owner', () => {
    const pauseWriting = vi.fn();
    const startWriting = vi.fn().mockResolvedValue(undefined);
    const busy = session({
      isStreaming: true,
      pauseWriting,
      startWriting,
      writingRunState: {
        ...IDLE_WRITING_RUN_STATE,
        runId: 4,
        phase: 'drafting',
      },
    });
    const { rerender } = render(
      <ManuscriptWorkspacePane
        novelId="novel-a"
        manuscript={busy}
        showUnification={false}
        onJumpToOutline={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pause run' }));
    expect(pauseWriting).toHaveBeenCalledOnce();

    rerender(
      <ManuscriptWorkspacePane
        novelId="novel-a"
        manuscript={session({
          startWriting,
          writingRunState: {
            ...IDLE_WRITING_RUN_STATE,
            runId: 4,
            phase: 'paused',
          },
        })}
        showUnification={false}
        onJumpToOutline={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume run' }));
    expect(startWriting).toHaveBeenCalledWith({ chapters: 1 });
  });
});
