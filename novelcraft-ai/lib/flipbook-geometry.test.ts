import { describe, expect, it } from 'vitest';

import { computeFlipbookGeometry, FLIPBOOK_LAYOUT } from '@/lib/flipbook-geometry';

describe('computeFlipbookGeometry', () => {
  it('uses the 10:17 novel-page ratio and centers width-bound spreads', () => {
    const geometry = computeFlipbookGeometry(1040, 975);

    expect(FLIPBOOK_LAYOUT.pageHeight / FLIPBOOK_LAYOUT.pageWidth).toBe(1.7);
    expect(geometry.shape).toBe('book');
    expect(geometry.spreadPages).toBe(2);
    expect(geometry.pageWidth).toBe(520);
    expect(geometry.pageHeight).toBe(884);
    expect(geometry.left).toBe(0);
    expect(geometry.top).toBe(45.5);
  });

  it('shrinks page width when real viewport height is the binding dimension', () => {
    const geometry = computeFlipbookGeometry(1000, 500);

    expect(geometry.shape).toBe('book');
    expect(geometry.pageHeight).toBe(500);
    expect(geometry.pageWidth).toBeCloseTo(500 / 1.7);
    expect(geometry.spreadWidth).toBeCloseTo((500 / 1.7) * 2);
    expect(geometry.left).toBeCloseTo((1000 - geometry.spreadWidth) / 2);
    expect(geometry.top).toBe(0);
  });

  it('caps wide books at the canonical maximum page width', () => {
    const geometry = computeFlipbookGeometry(2000, 1200);

    expect(geometry.shape).toBe('book');
    expect(geometry.pageWidth).toBe(680);
    expect(geometry.pageHeight).toBe(1156);
    expect(geometry.spreadWidth).toBe(1360);
    expect(geometry.left).toBe(320);
    expect(geometry.top).toBe(22);
  });

  it('switches to one page below the two-page minimum-width threshold', () => {
    expect(computeFlipbookGeometry(519, 900)).toMatchObject({
      shape: 'book',
      spreadPages: 1,
      pageWidth: 519,
      pageHeight: 882.3,
      left: 0,
    });
    expect(computeFlipbookGeometry(520, 900).spreadPages).toBe(2);
  });

  it('returns finite empty geometry before the viewport mounts', () => {
    expect(computeFlipbookGeometry(0, 0)).toEqual({
      pageWidth: 0,
      pageHeight: 0,
      spreadWidth: 0,
      spreadPages: 1,
      left: 0,
      top: 0,
      shape: 'book',
    });
    expect(computeFlipbookGeometry(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      pageWidth: 0,
      pageHeight: 0,
      spreadWidth: 0,
      spreadPages: 1,
      left: 0,
      top: 0,
      shape: 'book',
    });
  });

  it('honours viewports shorter than the library default minimum height', () => {
    const geometry = computeFlipbookGeometry(800, 200);

    expect(FLIPBOOK_LAYOUT.minPageHeight).toBe(1);
    expect(geometry.shape).toBe('sheet');
    expect(geometry.pageHeight).toBe(200);
    expect(geometry.top).toBe(0);
    expect(geometry.spreadWidth).toBeLessThanOrEqual(800);
  });

  it('falls back to one readable sheet page at the declared minimum window reader viewport', () => {
    // 768×720 minimum window: the reader viewport below the toolbar measures
    // roughly 740×340. The book shape would compress the two-page spread to
    // ~200px pages (4–6 CJK chars per line).
    const geometry = computeFlipbookGeometry(740, 340);

    expect(geometry.shape).toBe('sheet');
    expect(geometry.spreadPages).toBe(1);
    expect(geometry.pageWidth).toBeGreaterThanOrEqual(FLIPBOOK_LAYOUT.minPageWidth);
    expect(geometry.pageHeight).toBe(340);
    expect(geometry.spreadWidth).toBeLessThanOrEqual(740);
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBe(0);
  });

  it('keeps the two-page book spread at comfortable desktop sizes', () => {
    const geometry = computeFlipbookGeometry(900, 640);

    expect(geometry.shape).toBe('book');
    expect(geometry.spreadPages).toBe(2);
    expect(geometry.pageWidth).toBeGreaterThanOrEqual(FLIPBOOK_LAYOUT.minPageWidth);
  });

  it('renders two sheet pages only when both earn the full measure', () => {
    const narrow = computeFlipbookGeometry(1000, 300);
    expect(narrow.shape).toBe('sheet');
    expect(narrow.spreadPages).toBe(1);
    expect(narrow.pageWidth).toBeLessThanOrEqual(FLIPBOOK_LAYOUT.maxPageWidth);

    const wide = computeFlipbookGeometry(1400, 300);
    expect(wide.shape).toBe('sheet');
    expect(wide.spreadPages).toBe(2);
    expect(wide.pageWidth).toBeGreaterThanOrEqual(FLIPBOOK_LAYOUT.minPageWidth);
    expect(wide.spreadWidth).toBeLessThanOrEqual(1400);
  });
});
