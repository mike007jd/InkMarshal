// DOCX → RawDocument (W2-1). SERVER-ONLY (mammoth needs a Node Buffer).
//
// Strategy (locked decision, per 2026-06-26 mammoth docs): use mammoth's
// `convertToHtml` with a styleMap that maps Word's Heading1/2/3 paragraph
// styles to semantic <h1>/<h2>/<h3>, then walk the resulting HTML to recover a
// flat heading-level + paragraph block stream. We do NOT use mammoth's
// deprecated markdown output. `extractRawText` is used as a fallback when the
// document has no usable structure at all.
//
// Many Chinese manuscripts apply NO heading styles and instead bold/center a
// title line. mammoth emits those as `<p><strong>…</strong></p>`. We detect a
// paragraph whose entire run is bold + short and flag it `inferred` so the
// deterministic detector can still find the boundary (and the preview marks it
// "auto-detected").

import type { DocBlock, RawDocument } from '@/lib/import/types';

// Map Word heading styles (incl. localized "标题 1" via style id) to h1-h3. The
// style-id mappings (`Heading1`/`heading 1`) cover the EN + style-id forms;
// mammoth matches case-insensitively on the resolved style name.
const STYLE_MAP = [
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='heading 1'] => h1:fresh",
  "p[style-name='heading 2'] => h2:fresh",
  "p[style-name='heading 3'] => h3:fresh",
  "p[style-name='标题 1'] => h1:fresh",
  "p[style-name='标题 2'] => h2:fresh",
  "p[style-name='标题 3'] => h3:fresh",
  "p[style-name='Title'] => h1:fresh",
];

const MAX_INFERRED_TITLE_LEN = 40;

/** Decode the handful of HTML entities mammoth emits in text nodes. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).trim();
}

/**
 * True when a `<p>` is wholly a single bold run with no other text — the
 * hand-bolded-title pattern. We check that stripping `<strong>`/`<b>` wrappers
 * leaves the same text as stripping all tags (i.e. every visible char was bold).
 */
function isWhollyBold(innerHtml: string): boolean {
  const plain = stripTags(innerHtml);
  if (!plain) return false;
  const withoutBoldWrappers = innerHtml
    .replace(/<\/?(?:strong|b)>/gi, '')
    .replace(/<\/?em>|<\/?i>/gi, '');
  // If removing bold wrappers changed nothing, there was no bold at all.
  if (withoutBoldWrappers === innerHtml) return false;
  return stripTags(withoutBoldWrappers) === plain;
}

/**
 * Walk mammoth HTML into blocks. mammoth emits a flat sequence of block
 * elements (`<h1>`…`<h6>`, `<p>`, `<ul>`/`<ol>` we flatten to paragraphs). We
 * regex-scan the top-level elements in order — the output is shallow and well-
 * formed, so a tokenizing regex is sufficient and avoids a DOM dependency on
 * the server.
 */
export function htmlToBlocks(html: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const elementRe = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = elementRe.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const inner = match[2];
    const text = stripTags(inner);
    if (!text) continue;

    if (tag.startsWith('h')) {
      const level = Number(tag[1]);
      blocks.push({ kind: 'heading', level, text });
      continue;
    }

    // <p> / <li>. Detect a hand-bolded short standalone title.
    const bold = isWhollyBold(inner) && text.length <= MAX_INFERRED_TITLE_LEN;
    blocks.push(
      bold
        ? { kind: 'heading', level: 2, text, inferred: true }
        : { kind: 'paragraph', text },
    );
  }
  return blocks;
}

/**
 * Parse DOCX bytes into a `RawDocument`. `buffer` is the raw file bytes (Node
 * Buffer). On a structure-less document the heading walk yields only paragraphs
 * and the deterministic detector falls back to its regex heuristic.
 *
 * Throws only on a genuinely unreadable file (mammoth rejects) — the caller
 * surfaces that as an import error rather than a silent empty import.
 */
export async function parseDocx(buffer: Buffer, filename: string): Promise<RawDocument> {
  const mammoth = (await import('mammoth')).default;

  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    { styleMap: STYLE_MAP },
  );

  let blocks = htmlToBlocks(html);

  // Fallback when the HTML walk captured materially less prose than the raw
  // text. The regex tokenizer requires well-formed matching close tags, so
  // malformed mammoth output (unclosed `<p>`, stray `<`, mismatched nesting)
  // silently drops paragraphs — and the old guard only triggered when
  // blocks.length === 0, so a partially-broken docx that yielded SOME blocks
  // but lost others imported incomplete with no warning. Compare the captured
  // prose length against extractRawText and fall back when the walk captured
  // meaningfully less (arbitrary 90% threshold — generous so a few dropped
  // empty paragraphs don't trigger a wholesale fallback, but a real loss does).
  const capturedChars = blocks.reduce((n, b) => n + b.text.length, 0);
  const { value: raw } = await mammoth.extractRawText({ buffer });
  const rawChars = raw.replace(/\s+/g, '').length;
  const useRawFallback = blocks.length === 0 || (rawChars > 0 && capturedChars < rawChars * 0.9);
  if (useRawFallback) {
    blocks = raw
      .split(/\n{2,}/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(text => ({ kind: 'paragraph', text }) satisfies DocBlock);
  }

  return { source: 'docx', filename, blocks };
}
