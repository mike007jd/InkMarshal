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

/**
 * Aspect used when the book shape would compress below the readable floor.
 * Used only for pagination geometry — the live PageFlip instance always keeps
 * the canonical book constructor props (react-pageflip never re-applies them).
 */
const SHEET_ASPECT = {
  width: FLIPBOOK_LAYOUT.pageHeight,
  height: FLIPBOOK_LAYOUT.pageWidth,
  // Portrait until two full-measure sheets fit.
  minPageWidth: FLIPBOOK_LAYOUT.maxPageWidth,
} as const;

type FlipbookShape = 'book' | 'sheet';

export interface FlipbookGeometry {
  pageWidth: number;
  pageHeight: number;
  spreadWidth: number;
  spreadPages: 1 | 2;
  left: number;
  top: number;
  /** Layout mode: `sheet` parks PageFlip and shows a static single page. */
  shape: FlipbookShape;
}

/**
 * Mirrors page-flip@2.0.7 stretch sizing (`Render.calculateBoundsRect`):
 * portrait while the viewport is narrower than two minimum pages, capped at
 * maxWidth, then aspect-fit inside the viewport (height wins when it binds).
 */
function fitShape(
  width: number,
  height: number,
  shape: FlipbookShape,
) {
  const settings = shape === 'book'
    ? {
        width: FLIPBOOK_LAYOUT.pageWidth,
        height: FLIPBOOK_LAYOUT.pageHeight,
        minPageWidth: FLIPBOOK_LAYOUT.minPageWidth,
      }
    : SHEET_ASPECT;
  const spreadPages: 1 | 2 = width < settings.minPageWidth * 2 ? 1 : 2;
  // page-flip stores ratio as width/height; we keep height/width for the
  // same arithmetic used by the pagination overlay.
  const pageAspectRatio = settings.height / settings.width;

  let pageWidth = Math.min(FLIPBOOK_LAYOUT.maxPageWidth, width / spreadPages);
  let pageHeight = pageWidth * pageAspectRatio;

  if (pageHeight > height) {
    pageHeight = height;
    pageWidth = pageHeight / pageAspectRatio;
  }

  return { pageWidth, pageHeight, spreadPages };
}

/**
 * Mirrors page-flip's stretch sizing against the real viewport. Keeping this
 * calculation shared with pagination prevents the rendered paper and its text
 * capacity from drifting when width, height, zoom, or orientation changes.
 *
 * A height-bound book page narrower than the readable floor wraps CJK to a
 * few characters per line (the declared 768×720 minimum window produced
 * ~190px pages). Below the floor the reader switches to sheet layout mode:
 * one honest page that fits the viewport. The PageFlip instance stays mounted
 * with book props; sheet mode parks it and overlays a static page.
 */
export function computeFlipbookGeometry(
  containerWidth: number,
  containerHeight: number,
): FlipbookGeometry {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const height = Number.isFinite(containerHeight) ? Math.max(0, containerHeight) : 0;

  let shape: FlipbookShape = 'book';
  let fit = fitShape(width, height, shape);
  if (width > 0 && height > 0 && fit.pageWidth < FLIPBOOK_LAYOUT.minPageWidth) {
    shape = 'sheet';
    fit = fitShape(width, height, shape);
  }

  const spreadWidth = fit.pageWidth * fit.spreadPages;
  return {
    pageWidth: fit.pageWidth,
    pageHeight: fit.pageHeight,
    spreadWidth,
    spreadPages: fit.spreadPages,
    left: Math.max(0, (width - spreadWidth) / 2),
    top: Math.max(0, (height - fit.pageHeight) / 2),
    shape,
  };
}
