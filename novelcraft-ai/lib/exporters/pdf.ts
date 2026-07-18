import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFPage, StandardFonts } from 'pdf-lib';

import type { ExportChapterLike, ExportNovelLike } from '@/lib/exporters/text';
import { loadUnicodeFontBytes } from '@/lib/exporters/unicode-font';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_TOP = 752;
const MARGIN_BOTTOM = 50;
const MARGIN_LEFT = 50;
const MAX_TEXT_WIDTH = 512;

const PDF_CJK_UNSUPPORTED_MESSAGE =
  'PDF export does not support some characters in this manuscript (a script outside the bundled fonts, e.g. Arabic or Hebrew). Please use DOCX or TXT export instead.';

/**
 * Thrown when content contains a character neither the WinAnsi StandardFonts
 * nor the bundled Noto Serif SC face can render — emitting it would silently
 * corrupt the manuscript with tofu boxes. Name kept for back-compat with the
 * export route's / bundle's `.name` checks.
 */
export class CJKNotSupportedError extends Error {
  constructor() {
    super(PDF_CJK_UNSUPPORTED_MESSAGE);
    this.name = 'CJKNotSupportedError';
  }
}

interface DrawContext {
  pdf: PDFDocument;
  page: PDFPage;
  y: number;
}

/** Per-font draw kit: regular + bold face and the text sanitizer to apply. */
interface FontKit {
  font: PDFFont;
  boldFont: PDFFont;
  sanitize: (text: string) => string;
}

export async function buildNovelPdfBuffer(
  novel: ExportNovelLike,
  chapters: ExportChapterLike[]
): Promise<Uint8Array<ArrayBufferLike>> {
  const textsToCheck = [
    novel.title,
    novel.genre ?? '',
    novel.storySummary ?? '',
    novel.characterSummary ?? '',
    novel.arcSummary ?? '',
    ...chapters.flatMap((ch) => [ch.title, ch.content]),
  ];
  const needsUnicodeFont = textsToCheck.some(hasWinAnsiUnsupportedChar);

  const pdf = await PDFDocument.create();
  let kit: FontKit;
  if (needsUnicodeFont) {
    pdf.registerFontkit(fontkit);
    const fontBytes = await loadUnicodeFontBytes();
    assertUnicodeFontCoverage(textsToCheck, fontBytes);
    // subset:true embeds only the glyphs actually drawn, so the produced PDF
    // stays small even though the source face is ~23 MB.
    const font = await pdf.embedFont(fontBytes, { subset: true });
    kit = { font, boldFont: font, sanitize: stripInvisibleFormatChars };
  } else {
    kit = {
      font: await pdf.embedFont(StandardFonts.TimesRoman),
      boldFont: await pdf.embedFont(StandardFonts.TimesRomanBold),
      sanitize: toPdfSafeText,
    };
  }

  const ctx = newPage(pdf);

  drawLine(ctx, novel.title, 24, kit.boldFont, kit);

  if (novel.genre) {
    ctx.y -= 8;
    drawLine(ctx, `Genre: ${novel.genre}`, 12, kit.font, kit);
  }

  drawFrontMatterSection(ctx, 'Story Summary', novel.storySummary, kit);
  drawFrontMatterSection(ctx, 'Character Summary', novel.characterSummary, kit);
  drawFrontMatterSection(ctx, 'Plot Arc', novel.arcSummary, kit);

  for (const chapter of chapters) {
    ctx.y -= 20;
    ensureSpace(ctx, 40);
    drawLine(
      ctx,
      `Chapter ${chapter.chapterNumber}: ${chapter.title}`,
      16,
      kit.boldFont,
      kit
    );

    for (const line of chapter.content.split('\n')) {
      ctx.y -= 8;
      drawWrappedLine(ctx, line, 12, kit.font, kit);
    }
  }

  return pdf.save();
}

function drawFrontMatterSection(
  ctx: DrawContext,
  heading: string,
  text: string | null | undefined,
  kit: FontKit
): void {
  if (!text) return;

  ctx.y -= 12;
  drawLine(ctx, heading, 12, kit.boldFont, kit);
  for (const line of text.split('\n')) {
    drawWrappedLine(ctx, line, 12, kit.font, kit);
  }
}

/** Create a new page and return a fresh draw context pointing to it. */
function newPage(pdf: PDFDocument): DrawContext {
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  return { pdf, page, y: MARGIN_TOP };
}

/** If remaining space is less than `needed`, start a new page. */
function ensureSpace(ctx: DrawContext, needed: number): void {
  if (ctx.y - needed < MARGIN_BOTTOM) {
    const next = newPage(ctx.pdf);
    ctx.page = next.page;
    ctx.y = next.y;
  }
}

function drawLine(
  ctx: DrawContext,
  text: string,
  size: number,
  font: PDFFont,
  kit: FontKit
): void {
  ensureSpace(ctx, size + 4);
  ctx.page.drawText(kit.sanitize(text), {
    x: MARGIN_LEFT,
    y: ctx.y,
    size,
    font,
  });
  ctx.y -= size + 4;
}

function drawWrappedLine(
  ctx: DrawContext,
  text: string,
  size: number,
  font: PDFFont,
  kit: FontKit
): void {
  if (!text.trim()) {
    ensureSpace(ctx, size);
    ctx.y -= size;
    return;
  }

  const flush = (line: string) => {
    ensureSpace(ctx, size + 4);
    ctx.page.drawText(line, {
      x: MARGIN_LEFT,
      y: ctx.y,
      size,
      font,
    });
    ctx.y -= size + 4;
  };

  // Width is accumulated incrementally (word widths + one space width) so a
  // long paragraph wraps in O(n) instead of re-measuring the growing line on
  // every word — measurable on multi-thousand-character CJK paragraphs.
  const spaceWidth = font.widthOfTextAtSize(' ', size);
  let currentLine = '';
  let currentWidth = 0;

  // CJK prose typically has NO spaces, so `text.split(/\s+/)` collapses an entire
  // paragraph into one giant "word" that defeats the incremental-width fast path
  // below (one O(n) widthOfTextAtSize over the whole string, no early breaks).
  // When the text is mostly CJK (no spaces), split directly into per-character
  // pieces so the fast path applies line-by-line instead of measuring the whole
  // paragraph up front. Latin/prose with spaces still uses the word split.
  const looksCjk = !/\s/.test(text) && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
  const tokens = looksCjk ? [...text] : text.split(/\s+/);
  for (const word of tokens) {
    for (const piece of splitPdfWord(kit.sanitize(word), size, font)) {
      const pieceWidth = piece.width;
      // CJK pieces have no inter-word space; Latin words are joined by one.
      const joinedWidth = looksCjk
        ? (currentLine ? currentWidth + pieceWidth : pieceWidth)
        : (currentLine ? currentWidth + spaceWidth + pieceWidth : pieceWidth);

      if (joinedWidth > MAX_TEXT_WIDTH && currentLine) {
        flush(currentLine);
        currentLine = piece.text;
        currentWidth = pieceWidth;
      } else {
        currentLine = looksCjk
          ? (currentLine ? `${currentLine}${piece.text}` : piece.text)
          : (currentLine ? `${currentLine} ${piece.text}` : piece.text);
        currentWidth = joinedWidth;
      }
    }
  }

  if (currentLine) flush(currentLine);
}

interface MeasuredPiece {
  text: string;
  width: number;
}

/**
 * Split an over-wide "word" (typically an unspaced CJK run) into line-width
 * pieces. Char widths are summed incrementally — kerning drift is negligible
 * for wrapping purposes and the incremental sum keeps this O(n).
 */
function splitPdfWord(word: string, size: number, font: PDFFont): MeasuredPiece[] {
  const total = font.widthOfTextAtSize(word, size);
  if (total <= MAX_TEXT_WIDTH) return [{ text: word, width: total }];
  const parts: MeasuredPiece[] = [];
  let current = '';
  let currentWidth = 0;
  for (const char of word) {
    const charWidth = font.widthOfTextAtSize(char, size);
    if (current && currentWidth + charWidth > MAX_TEXT_WIDTH) {
      parts.push({ text: current, width: currentWidth });
      current = char;
      currentWidth = charWidth;
    } else {
      current += char;
      currentWidth += charWidth;
    }
  }
  if (current) parts.push({ text: current, width: currentWidth });
  return parts;
}

/** Common Unicode → ASCII mappings for characters StandardFonts can't render. */
const UNICODE_TO_ASCII: Record<string, string> = {
  '\u2018': "'", // left single quote
  '\u2019': "'", // right single quote
  '\u201C': '"', // left double quote
  '\u201D': '"', // right double quote
  '\u2013': '-', // en-dash
  '\u2014': '--', // em-dash
  '\u2026': '...', // ellipsis
  '\u00A0': ' ', // non-breaking space
  '\u2012': '-', // figure dash
  '\u2015': '--', // horizontal bar
  '\u2032': "'", // prime
  '\u2033': '"', // double prime
  '\u00AB': '<<', // left guillemet
  '\u00BB': '>>', // right guillemet
  '\u2039': '<', // single left guillemet
  '\u203A': '>', // single right guillemet
  '\u00B7': '.', // middle dot
  '\u2022': '*', // bullet
  '\u00A9': '(c)', // copyright
  '\u00AE': '(R)', // registered
  '\u2122': '(TM)', // trademark
};

function toPdfSafeText(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, (ch) => UNICODE_TO_ASCII[ch] ?? '?');
}

/**
 * Characters that are formatting metadata rather than visible text. They have
 * no glyph in most faces and would render as tofu — stripping them is
 * lossless for print output.
 */
const INVISIBLE_FORMAT_CHARS = /[\u200B-\u200F\u2060\uFEFF\uFE00-\uFE0F]/g;

function stripInvisibleFormatChars(text: string): string {
  return text.replace(INVISIBLE_FORMAT_CHARS, '');
}

/**
 * True if `text` contains any character `toPdfSafeText` would replace with the
 * `?` sentinel — i.e. a non-ASCII char outside the curated `UNICODE_TO_ASCII`
 * map. Such content routes to the embedded Unicode font instead of WinAnsi.
 */
function hasWinAnsiUnsupportedChar(text: string): boolean {
  const sentinels = (toPdfSafeText(text).match(/\?/g) ?? []).length;
  const originals = (text.match(/\?/g) ?? []).length;
  return sentinels > originals;
}

/**
 * Verify every visible character has a glyph in the bundled face. Anything
 * uncovered (Arabic, Hebrew, emoji, …) would silently render as tofu — throw
 * the export-level error instead so the UI can steer the user to DOCX/TXT.
 */
// Parsing the ~23 MB face is the expensive part of the coverage check — cache
// it per process. Glyph-coverage answers are cached across exports too (the
// face is immutable, so a codepoint's coverage never changes).
let cachedCoverageFace: ReturnType<typeof fontkit.create> | null = null;
const coverageByCodePoint = new Map<number, boolean>();

function assertUnicodeFontCoverage(texts: readonly string[], fontBytes: Uint8Array): void {
  cachedCoverageFace ??= fontkit.create(toFontkitBuffer(fontBytes));
  const face = cachedCoverageFace;
  const checked = coverageByCodePoint;
  for (const text of texts) {
    for (const char of stripInvisibleFormatChars(text)) {
      // Whitespace (incl. newlines) is layout, not a drawn glyph.
      if (/\s/.test(char)) continue;
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined) continue;
      let covered = checked.get(codePoint);
      if (covered === undefined) {
        covered = face.hasGlyphForCodePoint(codePoint);
        checked.set(codePoint, covered);
      }
      if (!covered) throw new CJKNotSupportedError();
    }
  }
}

/** fontkit's TS types want a Node Buffer; hand it one when available, else the
 *  raw bytes (its runtime accepts any Uint8Array in the browser bundle). */
function toFontkitBuffer(bytes: Uint8Array): Buffer {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes);
  return bytes as unknown as Buffer;
}
