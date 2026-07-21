import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildStageBarSteps, progressBarWidthClass } from '@/components/StageBar';

const LABELS = {
  brainstorm: 'Brainstorm',
  storyReady: 'Story Ready',
  approval: 'Approval',
  writing: 'Writing',
};

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
  const bar = readFileSync(join(process.cwd(), 'components/StageBar.tsx'), 'utf8');

  it('is an accessible step navigation with a single visible primary action', () => {
    // Native <nav> already exposes the navigation landmark; do not restate
    // role="navigation" (redundant ARIA on a semantic element).
    expect(bar).toContain('<nav');
    expect(bar).toContain('aria-label={labels?.navAriaLabel ?? t.projectStatus}');
    expect(bar).not.toContain('role="navigation"');
    expect(bar).toContain("aria-current={step.state === 'current' ? 'step' : undefined}");
    // Approve & Begin Writing renders inline at the ready stage — never
    // behind a popover/disclosure.
    expect(bar).toContain('{t.approveStart}');
    expect(bar).toContain('onClick={onApprove}');
    expect(bar).not.toContain('Popover');
    // The step projection honours deck completeness so a ready stage with an
    // incomplete deck stays on Story Ready instead of Approval.
    expect(bar).toContain('buildStageBarSteps(stage, stepLabels, { storyDeckComplete })');
    // WritingRunStatus is the single Pause owner at every density.
    expect(bar).not.toContain('onPauseWriting');
    expect(bar).not.toContain('StopStreamingButton');
  });

  it('keeps the narrow-window pill toggle keyboard-reachable with aria state', () => {
    expect(bar).toContain('data-shape="stage-pill"');
    expect(bar).toContain('aria-expanded={stepsOpen}');
    expect(bar).toContain('aria-controls={stepsId}');
  });
});
