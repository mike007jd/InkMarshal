// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { ProposalReviewPanel } from '@/components/ProposalReviewPanel';
import type { Novel } from '@/lib/db-types';

vi.mock('@/components/WritingModelStatusBar', () => ({
  useCapabilityBinding: () => ({
    mounted: true,
    resolved: { binding: null, conn: undefined },
  }),
}));

vi.mock('@/components/ReadyCompletionCard', () => ({
  ReadyCompletionCard: () => <div data-testid="ready-card" />,
}));

const NOVEL = {
  id: 'novel-1',
  userId: 'user-1',
  title: 'Novel A',
  genre: 'Fantasy',
  targetWords: 80_000,
  stage: 'ready_for_greenlight',
  progress: 0,
  storySummary: 'A summary.',
  characterSummary: '',
  arcSummary: '',
} as Novel;

function renderPanel(overrides: Partial<Parameters<typeof ProposalReviewPanel>[0]> = {}) {
  const props = {
    novel: NOVEL,
    counts: { character: 0, world: 0, outline: 3 },
    coverageLoading: false,
    onApprove: vi.fn(),
    onReviewDeck: vi.fn(),
    onAdjustProposal: vi.fn(),
    onCompleteDeck: vi.fn(),
    busy: false,
    ...overrides,
  };
  render(
    <LocaleProvider>
      <ProposalReviewPanel {...props} />
    </LocaleProvider>,
  );
  return props;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.cookie = 'locale=;path=/;max-age=0';
});

describe('ProposalReviewPanel incomplete Story Deck recovery', () => {
  it('names the missing card categories and completes the deck with the Assistant in one action', async () => {
    const props = renderPanel();

    const status = screen.getByRole('status');
    expect(status.textContent).toContain(
      'The approved plan is still missing: Characters · World.',
    );
    expect(status.textContent).not.toContain('Outline ·');
    const action = within(status).getByRole('button', {
      name: 'Complete Story Deck with Assistant',
    });
    await act(async () => {
      action.click();
    });
    expect(props.onCompleteDeck).toHaveBeenCalledTimes(1);
  });

  it('suppresses the incomplete state while coverage is still loading', () => {
    renderPanel({ coverageLoading: true });
    expect(
      screen.queryByRole('button', { name: /Complete Story Deck/ }),
    ).toBeNull();
  });

  it('disables the recovery action and shows the running state while the repair is in flight', () => {
    const props = renderPanel({ repairPhase: 'running' });

    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Assistant is completing the Story Deck…');
    const action = within(status).getByRole('button', {
      name: 'Assistant is completing the Story Deck…',
    });
    expect(action).toHaveProperty('disabled', true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(props.onCompleteDeck).not.toHaveBeenCalled();
  });

  it('shows a localized failure with a retry action after a failed repair', async () => {
    const props = renderPanel({ repairPhase: 'failed' });

    const status = screen.getByRole('status');
    expect(status.textContent).toContain(
      'The Assistant could not complete the Story Deck. Your chat and draft are unchanged.',
    );
    const retry = within(status).getByRole('button', { name: 'Retry' });
    expect(retry).toHaveProperty('disabled', false);
    await act(async () => {
      retry.click();
    });
    expect(props.onCompleteDeck).toHaveBeenCalledTimes(1);
  });

  it('disables failed-repair recovery while another Assistant turn is active', () => {
    renderPanel({ repairPhase: 'failed', busy: true });

    const retry = within(screen.getByRole('status')).getByRole('button', { name: 'Retry' });
    expect(retry).toHaveProperty('disabled', true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
  });

  it('localizes the recovery copy and action in zh-TW', async () => {
    document.cookie = 'locale=zh-TW;path=/';
    renderPanel();

    const action = await screen.findByRole('button', {
      name: '讓 Assistant 補齊故事卡組',
    });
    expect(action).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      '已確認的方案仍缺少：角色 · 世界觀。',
    );
  });
});
