// @vitest-environment jsdom

import React, { useEffect, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDynamicPagination } from '@/hooks/useDynamicPagination';
import { applySettingsToDocument, readManuscriptTypographyFromDocument } from '@/lib/settings';

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

function Probe({
  paddingY = 64,
  paddingX,
  averageCharWidth,
  lineHeight = 32,
}: {
  paddingY?: number;
  paddingX?: number;
  averageCharWidth?: number;
  lineHeight?: number;
}) {
  const { containerRef, charsPerPage, geometry } = useDynamicPagination({
    paddingY,
    paddingX,
    averageCharWidth,
    lineHeight,
    charsPerLine: 28,
  });
  return (
    <div>
      <div ref={containerRef} data-testid="viewport" />
      <span data-testid="chars-per-page">{charsPerPage}</span>
      <span data-testid="shape">{geometry.shape}</span>
      <span data-testid="page-width">{geometry.pageWidth}</span>
    </div>
  );
}

function SettingsAwareProbe() {
  const [typography, setTypography] = useState(readManuscriptTypographyFromDocument);
  useEffect(() => {
    const refresh = () => setTypography(readManuscriptTypographyFromDocument());
    window.addEventListener('inkmarshal:settings-changed', refresh);
    return () => window.removeEventListener('inkmarshal:settings-changed', refresh);
  }, []);

  const { containerRef, charsPerPage, geometry } = useDynamicPagination({
    paddingY: 56,
    paddingX: 72,
    averageCharWidth: typography.fontSizePx,
    lineHeight: typography.lineHeightPx,
    charsPerLine: 28,
  });

  return (
    <div>
      <div ref={containerRef} data-testid="viewport" />
      <span data-testid="chars-per-page">{charsPerPage}</span>
      <span data-testid="shape">{geometry.shape}</span>
      <span data-testid="line-height">{typography.lineHeightPx}</span>
      <span data-testid="font-size">{typography.fontSizePx}</span>
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
    document.documentElement.style.removeProperty('--manuscript-font-size');
    document.documentElement.style.removeProperty('--manuscript-line-height');
    vi.unstubAllGlobals();
  });

  it('converges charsPerPage from fallback/stale capacity to the safe minimum when pageHeight - paddingY <= 0', () => {
    render(<Probe paddingY={64} />);
    const viewport = screen.getByTestId('viewport');

    // Establish a real capacity first so a buggy early-return would keep it.
    setClientSize(viewport, 1040, 900);
    act(() => fireResize());
    const largeCapacity = Number(screen.getByTestId('chars-per-page').textContent);
    expect(largeCapacity).toBeGreaterThan(100);

    // Tiny viewport: geometry.pageHeight (40) - paddingY (64) <= 0.
    setClientSize(viewport, 400, 40);
    act(() => fireResize());
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBe(100);
  });

  it('replaces the initial 800 fallback on the first tiny viewport measurement', () => {
    render(<Probe paddingY={64} />);
    const viewport = screen.getByTestId('viewport');

    // jsdom mounts at 0×0 → pageHeight - paddingY <= 0; capacity must not stay 800.
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBe(100);

    setClientSize(viewport, 300, 20);
    act(() => fireResize());
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBe(100);
  });

  it('sizes one lg+relaxed CJK sheet page honestly at the 740×340 minimum window', () => {
    // 768×720 minimum window reader viewport (~740×340), lg font (19px) ×
    // relaxed line-height (2.0 → 38px), full-em CJK, reader padding.
    render(
      <Probe paddingY={56} paddingX={72} averageCharWidth={19} lineHeight={38} />,
    );
    const viewport = screen.getByTestId('viewport');
    setClientSize(viewport, 740, 340);
    act(() => fireResize());

    expect(screen.getByTestId('shape').textContent).toBe('sheet');
    const pageWidth = Number(screen.getByTestId('page-width').textContent);
    expect(pageWidth).toBeGreaterThanOrEqual(260);
    expect(pageWidth).toBeLessThanOrEqual(680);

    const charsPerLine = Math.max(8, Math.floor((pageWidth - 72) / 19));
    const lines = Math.max(0, Math.floor((340 - 56) / 38));
    const expected = Math.max(100, lines * charsPerLine);
    expect(expected).toBe(182);
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBe(182);
  });

  it('recalculates capacity when manuscript settings change', () => {
    applySettingsToDocument({ theme: 'system', fontSize: 'md', lineSpacing: 'normal' }, 'en');
    render(<SettingsAwareProbe />);
    const viewport = screen.getByTestId('viewport');
    setClientSize(viewport, 740, 340);
    act(() => fireResize());

    const mdNormal = Number(screen.getByTestId('chars-per-page').textContent);
    expect(Number(screen.getByTestId('font-size').textContent)).toBe(17);
    expect(Number(screen.getByTestId('line-height').textContent)).toBeCloseTo(17 * 1.75);
    expect(mdNormal).toBeGreaterThan(182);

    act(() => {
      applySettingsToDocument({ theme: 'system', fontSize: 'lg', lineSpacing: 'relaxed' }, 'en');
      window.dispatchEvent(new Event('inkmarshal:settings-changed'));
    });
    act(() => fireResize());

    expect(Number(screen.getByTestId('font-size').textContent)).toBe(19);
    expect(Number(screen.getByTestId('line-height').textContent)).toBe(38);
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBe(182);
    expect(Number(screen.getByTestId('chars-per-page').textContent)).toBeLessThan(mdNormal);
  });
});
