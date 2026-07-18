// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider, useToast } from '@/components/Toast';

function ToastHarness() {
  const { toast } = useToast();

  return (
    <>
      <button type="button" onClick={() => toast('Saved', 'success')}>Show toast</button>
      <button
        type="button"
        onClick={() => {
          for (let index = 1; index <= 6; index += 1) toast(`Toast ${index}`, 'info');
        }}
      >
        Show six
      </button>
    </>
  );
}

function toastElement(message: string): HTMLElement {
  const element = screen.getByText(message).parentElement;
  if (!element) throw new Error(`Missing toast container for ${message}`);
  return element;
}

function finishExit(element: HTMLElement) {
  // jsdom exposes WebkitAnimation on style but no AnimationEvent constructor,
  // so React registers the prefixed event in this test environment.
  fireEvent(element, new Event('webkitAnimationEnd', { bubbles: true }));
}

describe('ToastProvider motion lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps a dismissed toast mounted through exit motion, then removes it on animation end', () => {
    render(<ToastProvider><ToastHarness /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));

    const toast = toastElement('Saved');
    expect(toast.className).toContain('animate-toast-in');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('Saved')).not.toBeNull();
    const leavingToast = toastElement('Saved');
    expect(leavingToast.className).toContain('animate-toast-out');
    expect(leavingToast.className).toContain('pointer-events-none');

    act(() => finishExit(leavingToast));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('routes timeout dismissal through the same exit lifecycle', () => {
    render(<ToastProvider><ToastHarness /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));

    act(() => vi.advanceTimersByTime(5000));
    const leavingToast = toastElement('Saved');
    expect(leavingToast.className).toContain('animate-toast-out');

    act(() => finishExit(leavingToast));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('pauses timeout dismissal while the toast is hovered', () => {
    render(<ToastProvider><ToastHarness /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));

    const toast = toastElement('Saved');
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(6000));
    expect(toastElement('Saved').className).toContain('animate-toast-in');

    fireEvent.mouseLeave(toast);
    act(() => vi.advanceTimersByTime(5000));
    expect(toastElement('Saved').className).toContain('animate-toast-out');
  });

  it('evicts beyond the five-toast cap immediately', () => {
    render(<ToastProvider><ToastHarness /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show six' }));

    expect(screen.queryByText('Toast 1')).toBeNull();
    expect(screen.getByText('Toast 6')).not.toBeNull();
    expect(screen.getAllByText(/^Toast \d$/)).toHaveLength(5);
  });

  it('falls back to the fixed container when the routed anchor is detached', () => {
    const anchor = document.createElement('div');
    anchor.id = 'toast-anchor';
    document.body.appendChild(anchor);

    render(<ToastProvider><ToastHarness /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    expect(anchor.contains(screen.getByText('Saved'))).toBe(true);

    anchor.remove();
    fireEvent.click(screen.getByRole('button', { name: 'Show six' }));

    const fixedList = screen.getByText('Toast 6').closest('.fixed');
    expect(fixedList).not.toBeNull();
    expect(document.body.contains(fixedList)).toBe(true);
  });

  it('portals into the replacement anchor after a routed layout remount', () => {
    const staleAnchor = document.createElement('div');
    staleAnchor.id = 'toast-anchor';
    document.body.appendChild(staleAnchor);

    render(<ToastProvider><ToastHarness /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    expect(staleAnchor.contains(screen.getByText('Saved'))).toBe(true);

    staleAnchor.remove();
    const currentAnchor = document.createElement('div');
    currentAnchor.id = 'toast-anchor';
    document.body.appendChild(currentAnchor);
    fireEvent.click(screen.getByRole('button', { name: 'Show six' }));

    expect(currentAnchor.contains(screen.getByText('Toast 6'))).toBe(true);
    expect(staleAnchor.childElementCount).toBe(0);
  });
});
