// TXT / Markdown → RawDocument (W2-1). PURE, NO AI, NO native deps.
//
// Markdown: ATX headings (`#`, `##`, …) become heading blocks at their `#`
// depth; everything between blank lines is a paragraph. Setext headings
// (a line underlined by `===` / `---`) are also recognized. We deliberately do
// NOT render Markdown to HTML — the import target is plain-text prose, so inline
// emphasis/links are kept verbatim in the paragraph text (a future polish could
// strip them, but losing them silently is worse than keeping them).
//
// TXT: no heading syntax exists, so EVERY non-blank line group is a paragraph
// and the deterministic detector's volume/chapter regex does the splitting. We
// still pre-promote a whole-line volume/chapter marker to an inferred heading
// here so the detector and the docx path see a uniform block stream.
//
// Splitting is blank-line based. A run of consecutive non-blank lines is one
// paragraph (joined with newlines) — this preserves hard-wrapped prose as a
// single block, and treats a blank line as the paragraph separator.

import type { DocBlock, ImportSource, RawDocument } from '@/lib/import/types';
import { CHAPTER_REGEX, VOLUME_REGEX } from '@/lib/import/detect-chapters';

const ATX_HEADING = /^(#{1,6})\s+(.*\S)\s*#*\s*$/;
const SETEXT_UNDERLINE = /^\s*(=+|-+)\s*$/;

function isVolumeOrChapterLine(line: string): boolean {
  const t = line.trim();
  return VOLUME_REGEX.test(t) || CHAPTER_REGEX.test(t);
}

/**
 * Promote a plain text line that is *entirely* a volume/chapter marker to an
 * inferred heading block. Returns null when the line is ordinary prose.
 */
function inferredHeadingFor(line: string): DocBlock | null {
  const t = line.trim();
  if (!t) return null;
  if (VOLUME_REGEX.test(t)) {
    return { kind: 'heading', level: 1, text: t, inferred: true };
  }
  if (CHAPTER_REGEX.test(t)) {
    return { kind: 'heading', level: 2, text: t, inferred: true };
  }
  return null;
}

function parseMarkdown(text: string, filename: string): RawDocument {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join('\n').trim();
    paragraph = [];
    if (!joined) return;
    // A paragraph that is itself a bare volume/chapter marker is promoted so a
    // markdown doc that uses plain bold/centered titles instead of `#` still
    // splits.
    const inferred = inferredHeadingFor(joined);
    blocks.push(inferred ?? { kind: 'paragraph', text: joined });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atx = line.match(ATX_HEADING);
    if (atx) {
      flush();
      blocks.push({ kind: 'heading', level: atx[1].length, text: atx[2].trim() });
      continue;
    }
    // Setext: current paragraph is a single line and the next line underlines it.
    const next = lines[i + 1];
    if (
      paragraph.length === 1 &&
      paragraph[0].trim() &&
      next !== undefined &&
      SETEXT_UNDERLINE.test(next) &&
      line.trim()
    ) {
      const level = next.trim().startsWith('=') ? 1 : 2;
      blocks.push({ kind: 'heading', level, text: paragraph[0].trim() });
      paragraph = [];
      i++; // consume the underline line
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();

  return { source: 'md', filename, blocks };
}

function parsePlainText(text: string, filename: string): RawDocument {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join('\n').trim();
    paragraph = [];
    if (joined) blocks.push({ kind: 'paragraph', text: joined });
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    // A whole-line volume/chapter marker becomes its own inferred heading block
    // even when it isn't blank-line separated from surrounding prose (common in
    // dense Chinese .txt where the title line abuts the body).
    if (isVolumeOrChapterLine(line)) {
      flush();
      blocks.push(inferredHeadingFor(line)!);
      continue;
    }
    paragraph.push(line);
  }
  flush();

  return { source: 'txt', filename, blocks };
}

/**
 * Parse a TXT or Markdown string into a `RawDocument`. `source` decides the
 * heading strategy (markdown ATX/setext vs. pure regex heuristic). Markdown is
 * detected by extension upstream; pass it explicitly.
 */
export function parseText(text: string, filename: string, source: 'txt' | 'md'): RawDocument {
  const normalized = text.replace(/^﻿/, ''); // strip BOM
  return source === 'md'
    ? parseMarkdown(normalized, filename)
    : parsePlainText(normalized, filename);
}

/** Decide the import source from a filename extension. Defaults to txt. */
export function sourceFromFilename(filename: string): ImportSource {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'docx') return 'docx';
  return 'txt';
}
