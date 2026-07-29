import * as upstreamFontkit from 'fontkit';
import type { PDFDocument } from 'pdf-lib';

/**
 * pdf-lib's `registerFontkit` expects a factory with the shape of the abandoned
 * `@pdf-lib/fontkit@1.1.1` fork. That fork's CFF/TrueType subsetter emits
 * invalid embedded fonts for CJK OTFs (poppler: "Embedded font file may be
 * invalid"; macOS Quick Look renders corrupted glyphs). Upstream `fontkit@2.x`
 * subsets correctly; the only API gap is `subset.encodeStream()` (a Node-style
 * event stream) vs synchronous `subset.encode(): Uint8Array`.
 *
 * This adapter bridges that gap with a tiny one-shot stream so pdf-lib can keep
 * `embedFont(..., { subset: true })` without pulling Node's `stream` module into
 * the desktop webview bundle.
 */

type PdfLibFontkit = Parameters<PDFDocument['registerFontkit']>[0];

type EncodeStreamLike = {
  on(
    event: 'data' | 'end' | 'error',
    cb: (...args: unknown[]) => void
  ): EncodeStreamLike;
};

type SubsetLike = {
  encode?: () => Uint8Array;
  encodeStream?: () => EncodeStreamLike;
};

type FontLike = {
  createSubset?: () => SubsetLike;
  __pdfLibEncodeStreamPatched?: boolean;
  hasGlyphForCodePoint: (codePoint: number) => boolean;
};

function bytesToEncodeStream(bytes: Uint8Array): EncodeStreamLike {
  const listeners: Partial<
    Record<'data' | 'end' | 'error', Array<(...args: unknown[]) => void>>
  > = {};
  const stream: EncodeStreamLike = {
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
      return stream;
    },
  };
  queueMicrotask(() => {
    try {
      for (const cb of listeners.data ?? []) cb(bytes);
      for (const cb of listeners.end ?? []) cb();
    } catch (err) {
      for (const cb of listeners.error ?? []) cb(err);
    }
  });
  return stream;
}

function patchSubsetEncodeStream(font: FontLike): FontLike {
  if (typeof font.createSubset !== 'function' || font.__pdfLibEncodeStreamPatched) {
    return font;
  }
  const originalCreateSubset = font.createSubset.bind(font);
  font.createSubset = () => {
    const subset = originalCreateSubset();
    if (
      typeof subset.encodeStream !== 'function' &&
      typeof subset.encode === 'function'
    ) {
      const encode = subset.encode.bind(subset);
      subset.encodeStream = () => bytesToEncodeStream(encode());
    }
    return subset;
  };
  font.__pdfLibEncodeStreamPatched = true;
  return font;
}

function toFontData(fontData: Uint8Array | ArrayBuffer): Uint8Array {
  return fontData instanceof Uint8Array ? fontData : new Uint8Array(fontData);
}

/**
 * fontkit factory compatible with pdf-lib's `registerFontkit` and with the
 * glyph-coverage probe in the PDF exporter (`hasGlyphForCodePoint`).
 */
export const pdfLibFontkit = {
  create(fontData: Uint8Array | ArrayBuffer, postscriptName?: string) {
    const font = upstreamFontkit.create(
      toFontData(fontData) as Buffer,
      postscriptName
    ) as unknown as FontLike;
    return patchSubsetEncodeStream(font);
  },
} as unknown as PdfLibFontkit & {
  create(
    fontData: Uint8Array | ArrayBuffer,
    postscriptName?: string
  ): FontLike;
};
