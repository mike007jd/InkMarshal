export const FLIPBOOK_LAYOUT = {
  pageWidth: 500,
  pageHeight: 850,
  minPageWidth: 260,
  maxPageWidth: 680,
  // page-flip writes this value as an inline min-height. Keep it non-zero for
  // the library validator but let the real viewport remain the sizing limit.
  minPageHeight: 1,
  landscapePages: 2,
} as const;

export interface FlipbookGeometry {
  pageWidth: number;
  pageHeight: number;
  spreadWidth: number;
  spreadPages: 1 | 2;
  left: number;
  top: number;
}

/**
 * Mirrors page-flip's stretch sizing against the real viewport. Keeping this
 * calculation shared with pagination prevents the rendered paper and its text
 * capacity from drifting when width, height, zoom, or orientation changes.
 */
export function computeFlipbookGeometry(
  containerWidth: number,
  containerHeight: number,
): FlipbookGeometry {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const height = Number.isFinite(containerHeight) ? Math.max(0, containerHeight) : 0;
  const spreadPages: 1 | 2 = width < FLIPBOOK_LAYOUT.minPageWidth * 2 ? 1 : 2;
  const pageAspectRatio = FLIPBOOK_LAYOUT.pageHeight / FLIPBOOK_LAYOUT.pageWidth;

  let pageWidth = Math.min(FLIPBOOK_LAYOUT.maxPageWidth, width / spreadPages);
  let pageHeight = pageWidth * pageAspectRatio;

  if (pageHeight > height) {
    pageHeight = height;
    pageWidth = pageHeight / pageAspectRatio;
  }

  const spreadWidth = pageWidth * spreadPages;
  return {
    pageWidth,
    pageHeight,
    spreadWidth,
    spreadPages,
    left: Math.max(0, (width - spreadWidth) / 2),
    top: Math.max(0, (height - pageHeight) / 2),
  };
}
