// hooks/useDynamicPagination.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { computeFlipbookGeometry, type FlipbookGeometry } from '@/lib/flipbook-geometry';

interface UseDynamicPaginationOptions {
  lineHeight?: number;     // default 32 (2rem)
  charsPerLine?: number;   // default 28 for zh, 60 for en
  titleReserveLines?: number; // default 3
  paddingY?: number;       // vertical padding in px, default 64 (py-8)
  paddingX?: number;
  averageCharWidth?: number;
  onContainerResize?: () => void;
}

const FALLBACK_CHARS = 800;

export function useDynamicPagination(options: UseDynamicPaginationOptions = {}) {
  const {
    lineHeight = 32,
    charsPerLine = 28,
    titleReserveLines = 3,
    paddingY = 64,
    paddingX = 0,
    averageCharWidth,
    onContainerResize,
  } = options;

  const containerRef = useRef<HTMLDivElement>(null);
  const [charsPerPage, setCharsPerPage] = useState(FALLBACK_CHARS);
  const [titleReserve, setTitleReserve] = useState(titleReserveLines * charsPerLine);
  const [geometry, setGeometry] = useState<FlipbookGeometry>(() => computeFlipbookGeometry(0, 0));

  const calculate = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nextGeometry = computeFlipbookGeometry(el.clientWidth, el.clientHeight);
    setGeometry(current => (
      current.pageWidth === nextGeometry.pageWidth
      && current.pageHeight === nextGeometry.pageHeight
      && current.spreadWidth === nextGeometry.spreadWidth
      && current.spreadPages === nextGeometry.spreadPages
      && current.left === nextGeometry.left
      && current.top === nextGeometry.top
        ? current
        : nextGeometry
    ));
    const availableHeight = nextGeometry.pageHeight - paddingY;
    if (availableHeight <= 0) return;
    const lines = Math.floor(availableHeight / lineHeight);
    const effectiveCharsPerLine = averageCharWidth
      ? Math.max(20, Math.floor((nextGeometry.pageWidth - paddingX) / averageCharWidth))
      : charsPerLine;
    const chars = Math.max(200, lines * effectiveCharsPerLine);
    setCharsPerPage(chars);
    setTitleReserve(titleReserveLines * effectiveCharsPerLine);
  }, [
    lineHeight,
    charsPerLine,
    titleReserveLines,
    paddingY,
    paddingX,
    averageCharWidth,
  ]);

  useEffect(() => {
    calculate();
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      calculate();
      onContainerResize?.();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [calculate, onContainerResize]);

  return { containerRef, charsPerPage, titleReserve, geometry };
}
