// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { WritingRunStatus } from '@/components/WritingRunStatus';
import type { WritingRunState } from '@/lib/writing-session';

const NOW = Date.parse('2026-07-21T12:00:00.000Z');

function run(overrides: Partial<WritingRunState> = {}): WritingRunState {
  return {
    phase: 'drafting',
    statusLabel: 'Drafting chapter',
    modelLabel: 'Qwen3.5 9B',
    chapterNumber: 3,
    chapterTitle: 'Storm',
    liveWordCount: 1234,
    completedChapters: 2,
    totalChapters: 10,
    progress: 27,
    startedAt: new Date(NOW - 200_000).toISOString(),
    lastActivityAt: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  };
}

function renderStatus(
  state: WritingRunState,
  options: {
    density?: 'panel' | 'bar';
    controls?: { onPause?: () => void; onResume?: () => void; onRetry?: () => void };
  } = {},
) {
  return render(
    <LocaleProvider>
      <WritingRunStatus
        density={options.density ?? 'panel'}
        state={state}
        controls={options.controls}
        nowMs={NOW}
      />
    </LocaleProvider>,
  );
}

afterEach(() => cleanup());

describe('WritingRunStatus panel density', () => {
  it('narrates a drafting run: status, model, chapter, words, counts, elapsed, last activity, progress', () => {
    renderStatus(run());
    expect(screen.getByText('Drafting chapter')).toBeTruthy();
    expect(screen.getByText('Qwen3.5 9B')).toBeTruthy();
    expect(screen.getByText('Ch.3 · Storm')).toBeTruthy();
    expect(screen.getByText('1,234 words')).toBeTruthy();
    expect(screen.getByText('2/10')).toBeTruthy();
    expect(screen.getByText('Elapsed 3m 20s')).toBeTruthy();
    expect(screen.getByText('Last activity 5s ago')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('27');
  });

  it('offers Pause while busy and routes it to the unchanged pause protocol', () => {
    const onPause = vi.fn();
    renderStatus(run(), { controls: { onPause } });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledOnce();
  });

  it('keeps Pause available during the between-chapter complete phase', () => {
    const onPause = vi.fn();
    renderStatus(run({ phase: 'chapter_complete' }), { controls: { onPause } });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledOnce();
  });

  it('offers Resume while paused (and no Pause)', () => {
    const onResume = vi.fn();
    renderStatus(run({ phase: 'paused', statusLabel: 'Writing paused' }), { controls: { onResume } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('replaces the status line with the failure summary and keeps the full error readable via title', () => {
    const onRetry = vi.fn();
    const error = 'Model connection dropped after 3 retries while streaming chapter 3.';
    renderStatus(run({ phase: 'failed', statusLabel: 'Writing failed', error }), {
      controls: { onRetry },
    });
    const statusEl = screen.getByText(error);
    expect(statusEl.getAttribute('title')).toBe(error);
    expect(screen.queryByText('Writing failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('replaces the status line with the slow-planning hint after 60s of planning', () => {
    renderStatus(run({
      phase: 'planning',
      statusLabel: 'Planning chapter blueprint',
      startedAt: new Date(NOW - 65_000).toISOString(),
    }));
    const hint = screen.getByText('Model still planning · waited 1m');
    expect(hint.getAttribute('title')).toBe('Planning chapter blueprint');
    // The original label is demoted to the tooltip, not stacked underneath.
    expect(screen.queryByText('Planning chapter blueprint')).toBeNull();
  });

  it('shows no run action once complete', () => {
    renderStatus(run({ phase: 'complete', statusLabel: 'All chapters written', progress: 100 }), {
      controls: { onPause: vi.fn(), onResume: vi.fn(), onRetry: vi.fn() },
    });
    expect(screen.getByText('All chapters written')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('WritingRunStatus bar density (narrow screens)', () => {
  it('is a single line with a static 40px height constraint', () => {
    renderStatus(run(), { density: 'bar' });
    const bar = screen.getByRole('status');
    expect(bar.className).toContain('h-10');
    expect(bar.className).toContain('max-h-10');
    expect(bar.className).toContain('whitespace-nowrap');
    expect(bar.className).toContain('overflow-hidden');
  });

  it('keeps only phase, chapter, progress and the primary action on the line', () => {
    const onPause = vi.fn();
    renderStatus(run(), { density: 'bar', controls: { onPause } });
    expect(screen.getByText('Drafting chapter')).toBeTruthy();
    expect(screen.getByText('Ch.3')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('27');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledOnce();
    // Details stay behind the disclosure by default — the line never grows.
    expect(screen.queryByText('Qwen3.5 9B')).toBeNull();
    expect(screen.queryByText('1,234 words')).toBeNull();
  });

  it('reveals the full detail set through the compact disclosure without changing the line', () => {
    renderStatus(run(), { density: 'bar' });
    fireEvent.click(screen.getByRole('button', { name: 'Writing run details' }));
    expect(screen.getByText('Qwen3.5 9B')).toBeTruthy();
    expect(screen.getByText('1,234 words')).toBeTruthy();
    expect(screen.getByText('2/10')).toBeTruthy();
    expect(screen.getByText('Elapsed 3m 20s')).toBeTruthy();
    expect(screen.getByText('Last activity 5s ago')).toBeTruthy();
    const bar = screen.getByRole('status');
    expect(bar.className).toContain('h-10');
  });

  it('points the disclosure toggle aria-controls at the details container it expands', () => {
    renderStatus(run(), { density: 'bar' });
    const toggle = screen.getByRole('button', { name: 'Writing run details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const controlsId = toggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    // Collapsed: the controlled container is not in the DOM yet.
    expect(document.getElementById(controlsId!)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = document.getElementById(controlsId!);
    expect(details).toBeTruthy();
    expect(details!.textContent).toContain('Qwen3.5 9B');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(controlsId!)).toBeNull();
  });
});
