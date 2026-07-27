// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import {
  buildStageBarSteps,
  progressBarWidthClass,
  StageBar,
} from '@/components/StageBar';

const LABELS = {
  brainstorm: 'Brainstorm',
  storyReady: 'Story Ready',
  approval: 'Approval',
  writing: 'Writing',
};

afterEach(cleanup);

describe('buildStageBarSteps', () => {
  it('marks brainstorm current during the discovery interview', () => {
    const steps = buildStageBarSteps('discovery_interview', LABELS);
    expect(steps.map(step => step.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('marks approval current once the story is ready and the deck is complete', () => {
    const steps = buildStageBarSteps('ready_for_greenlight', LABELS);
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'current', 'upcoming']);
    const explicit = buildStageBarSteps('ready_for_greenlight', LABELS, { storyDeckComplete: true });
    expect(explicit.map(step => step.state)).toEqual(['done', 'done', 'current', 'upcoming']);
  });

  it('keeps story_ready current while the deck is incomplete at the ready stage', () => {
    const steps = buildStageBarSteps('ready_for_greenlight', LABELS, { storyDeckComplete: false });
    expect(steps.map(step => step.state)).toEqual(['done', 'current', 'upcoming', 'upcoming']);
  });

  it('marks writing current during autonomous writing', () => {
    const steps = buildStageBarSteps('autonomous_writing', LABELS);
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'done', 'current']);
    const withProjection = buildStageBarSteps('autonomous_writing', LABELS, { storyDeckComplete: false });
    expect(withProjection.map(step => step.state)).toEqual(['done', 'done', 'done', 'current']);
  });

  it('marks every step done once the book is finished', () => {
    for (const stage of ['whole_book_unification', 'completed'] as const) {
      const steps = buildStageBarSteps(stage, LABELS);
      expect(steps.every(step => step.state === 'done')).toBe(true);
    }
  });

  it('keeps step keys stable across the whole projection matrix', () => {
    const keys = ['brainstorm', 'story_ready', 'approval', 'writing'];
    const stages = ['discovery_interview', 'ready_for_greenlight', 'autonomous_writing', 'whole_book_unification', 'completed'] as const;
    for (const stage of stages) {
      for (const storyDeckComplete of [true, false]) {
        const steps = buildStageBarSteps(stage, LABELS, { storyDeckComplete });
        expect(steps.map(step => step.key)).toEqual(keys);
        expect(steps.filter(step => step.state === 'current').length).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('progressBarWidthClass', () => {
  it('clamps out-of-range progress', () => {
    expect(progressBarWidthClass(-10)).toBe('w-0');
    expect(progressBarWidthClass(140)).toBe('w-full');
  });

  it('buckets to five-percent steps', () => {
    expect(progressBarWidthClass(0)).toBe('w-0');
    expect(progressBarWidthClass(50)).toBe('w-1/2');
    expect(progressBarWidthClass(100)).toBe('w-full');
  });
});

describe('StageBar stage surface contract', () => {
  it('exposes the current step and performs the ready-stage action in one click', () => {
    const onApprove = vi.fn();
    render(
      <LocaleProvider>
        <StageBar
          stage="ready_for_greenlight"
          storyDeckComplete
          onApprove={onApprove}
          labels={{ navAriaLabel: 'Project status' }}
        />
      </LocaleProvider>,
    );

    const navigation = screen.getByRole('navigation', { name: 'Project status' });
    const currentSteps = navigation.querySelectorAll('[aria-current="step"]');
    expect(currentSteps).toHaveLength(1);
    expect(currentSteps[0]?.textContent).toContain('Approval');
    fireEvent.click(screen.getByRole('button', { name: /Approve & Begin Writing/ }));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it('offers Story Deck repair instead of approve until coverage is complete', () => {
    const onCompleteDeck = vi.fn();
    const onApprove = vi.fn();
    render(
      <LocaleProvider>
        <StageBar
          stage="ready_for_greenlight"
          storyDeckComplete={false}
          onCompleteDeck={onCompleteDeck}
          onApprove={onApprove}
        />
      </LocaleProvider>,
    );

    const currentStep = screen
      .getByRole('navigation')
      .querySelector('[aria-current="step"]');
    expect(currentStep?.textContent).toContain('Story Ready');
    expect(screen.queryByRole('button', { name: /Approve & Begin Writing/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Complete Story Deck/ }));
    expect(onCompleteDeck).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('keeps the narrow-window step disclosure keyboard-reachable with aria state', () => {
    render(
      <LocaleProvider>
        <StageBar stage="autonomous_writing" />
      </LocaleProvider>,
    );
    const toggle = screen.getByRole('button', { expanded: false });
    const controlledId = toggle.getAttribute('aria-controls');
    expect(controlledId).toBeTruthy();
    expect(document.getElementById(controlledId!)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});
