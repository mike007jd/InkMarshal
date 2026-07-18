// hooks/useDynamicPagination.ts
import { useState, useEffect, useRef, useCallback } from 'react';

interface UseDynamicPaginationOptions {
  lineHeight?: number;     // default 32 (2rem)
  charsPerLine?: number;   // default 28 for zh, 60 for en
  titleReserveLines?: number; // default 3
  paddingY?: number;       // vertical padding in px, default 64 (py-8)
  heightReserve?: number;  // extra safety space for controls/shadows/clipping
  pageAspectRatio?: number;
  pagesPerSpread?: number;
  paddingX?: number;
  averageCharWidth?: number;
  minPageWidth?: number;
  maxPageWidth?: number;
}

const FALLBACK_CHARS = 800;

export function useDynamicPagination(options: UseDynamicPaginationOptions = {}) {
  const {
    lineHeight = 32,
    charsPerLine = 28,
    titleReserveLines = 3,
    paddingY = 64,
    heightReserve = 0,
    pageAspectRatio,
    pagesPerSpread = 2,
    paddingX = 0,
    averageCharWidth,
    minPageWidth = 260,
    maxPageWidth = 680,
  } = options;

  const containerRef = useRef<HTMLDivElement>(null);
  const [charsPerPage, setCharsPerPage] = useState(FALLBACK_CHARS);
  const [titleReserve, setTitleReserve] = useState(titleReserveLines * charsPerLine);

  const calculate = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const heightFromContainer = el.clientHeight;
    const pageWidth = pageAspectRatio
      ? Math.min(
          maxPageWidth,
          Math.max(minPageWidth, el.clientWidth / pagesPerSpread)
        )
      : el.clientWidth;
    const heightFromWidth = pageAspectRatio
      ? pageWidth * pageAspectRatio
      : heightFromContainer;
    const availableHeight = Math.min(heightFromContainer, heightFromWidth) - paddingY - heightReserve;
    if (availableHeight <= 0) return;
    const lines = Math.floor(availableHeight / lineHeight);
    const effectiveCharsPerLine = averageCharWidth
      ? Math.max(20, Math.floor((pageWidth - paddingX) / averageCharWidth))
      : charsPerLine;
    const chars = Math.max(200, lines * effectiveCharsPerLine);
    setCharsPerPage(chars);
    setTitleReserve(titleReserveLines * effectiveCharsPerLine);
  }, [
    lineHeight,
    charsPerLine,
    titleReserveLines,
    paddingY,
    heightReserve,
    pageAspectRatio,
    pagesPerSpread,
    paddingX,
    averageCharWidth,
    minPageWidth,
    maxPageWidth,
  ]);

  useEffect(() => {
    calculate();
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => calculate());
    observer.observe(el);
    return () => observer.disconnect();
  }, [calculate]);

  return { containerRef, charsPerPage, titleReserve };
}
