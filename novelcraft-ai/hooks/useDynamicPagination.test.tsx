// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDynamicPagination } from '@/hooks/useDynamicPagination';

const observers = new Set<ResizeObserverMock>();

class ResizeObserverMock {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {
    observers.delete(this);
  }
}

function setClientSize(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
}

function fireResize() {
  for (const observer of observers) {
    observer.callback([], observer as unknown as ResizeObserver);
  }
}

function Probe({ paddingY = 64 }: { paddingY?: number }) {
  const { containerRef, charsPerPage } = useDynamicPagination({
    paddingY,
    lineHeight: 32,
    charsPerLine: 28,
  });
  return (
    <div>
      <div ref={containerRef} data-testid="viewport" />
      <span data-testid="chars-per-page">{charsPerPage}</span>
    </div>
  );
}

describe('useDynamicPagination', () => {
  beforeEach(() => {
    observers.clear();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('converges charsPerPage from fallback/stale capacity to the safe minimum when pageHeight - paddingY <= 0', () => {
    render(<Probe paddingY={64} />);
    const viewport = screen.getByTestId('viewport');

    // Establish a real capacity first so a buggy early-return would keep it.
    setClientSize(viewport, 1040, 900);
    act(() => fireResize());
    const largeCapacity = Number(screen.getByTestId('chars-per-page').textContent);
    expect(largeCapacity).toBeGreaterThan(200);

    // Tiny viewport: geometry.pageHeight (40) - paddingY (64) <= 0.
    setClientSize(viewport, 400, 40);
    act(() => fireResize());
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBe(200);
  });

  it('replaces the initial 800 fallback on the first tiny viewport measurement', () => {
    render(<Probe paddingY={64} />);
    const viewport = screen.getByTestId('viewport');

    // jsdom mounts at 0×0 → pageHeight - paddingY <= 0; capacity must not stay 800.
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBe(200);

    setClientSize(viewport, 300, 20);
    act(() => fireResize());
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBe(200);
  });
});
