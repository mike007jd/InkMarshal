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

  it('marks approval current once the story is ready', () => {
    const steps = buildStageBarSteps('ready_for_greenlight', LABELS);
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'current', 'upcoming']);
  });

  it('marks writing current during autonomous writing', () => {
    const steps = buildStageBarSteps('autonomous_writing', LABELS);
    expect(steps.map(step => step.state)).toEqual(['done', 'done', 'done', 'current']);
  });

  it('marks every step done once the book is finished', () => {
    for (const stage of ['whole_book_unification', 'completed'] as const) {
      const steps = buildStageBarSteps(stage, LABELS);
      expect(steps.every(step => step.state === 'done')).toBe(true);
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
  });

  it('keeps the narrow-window pill toggle keyboard-reachable with aria state', () => {
    expect(bar).toContain('data-shape="stage-pill"');
    expect(bar).toContain('aria-expanded={stepsOpen}');
    expect(bar).toContain('aria-controls={stepsId}');
  });
});
