// @vitest-environment jsdom

import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { ReadyCompletionCard } from '@/components/ReadyCompletionCard';

afterEach(cleanup);

describe('ReadyCompletionCard', () => {
  it('renders proposal summary, coverage counts and run details from props only', () => {
    render(
      <LocaleProvider>
        <ReadyCompletionCard
          proposalSummary="A cozy dungeon romp."
          characterCount={4}
          worldCount={2}
          outlineCount={12}
          run={{
            targetWords: 80000,
            planningModelLabel: 'Qwen3.5 9B',
            draftingModelLabel: 'Qwen3.6 27B',
            estimatedTimeLabel: 'About 5–20 min',
            estimatedCostLabel: 'No provider charge',
          }}
          onApprove={() => {}}
          onReviewDeck={() => {}}
          onAdjustProposal={() => {}}
        />
      </LocaleProvider>,
    );

    expect(screen.getByText('A cozy dungeon romp.')).toBeTruthy();
    expect(screen.getByText('Characters')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('80,000 words')).toBeTruthy();
    expect(screen.getByText('Qwen3.5 9B')).toBeTruthy();
    expect(screen.getByText('Qwen3.6 27B')).toBeTruthy();
    expect(screen.getByText('About 5–20 min')).toBeTruthy();
  });

  it('fires approve directly — one click, no confirmation step', () => {
    const onApprove = vi.fn();
    const onReviewDeck = vi.fn();
    const onAdjustProposal = vi.fn();
    render(
      <LocaleProvider>
        <ReadyCompletionCard
          proposalSummary={null}
          onApprove={onApprove}
          onReviewDeck={onReviewDeck}
          onAdjustProposal={onAdjustProposal}
        />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Approve & Begin Writing/ }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Review Story Deck' }));
    expect(onReviewDeck).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Adjust proposal' }));
    expect(onAdjustProposal).toHaveBeenCalledTimes(1);
  });

  it('disables approve while busy or explicitly disabled', () => {
    render(
      <LocaleProvider>
        <ReadyCompletionCard onApprove={() => {}} busy />
      </LocaleProvider>,
    );
    const button = screen.getByRole('button', { name: /Approve & Begin Writing/ });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});
