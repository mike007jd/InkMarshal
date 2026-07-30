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

import { crc32, inflateRawSync } from 'node:zlib';

import { MAX_IMPORT_RECONSTRUCTED_BYTES } from '@/lib/import/limits';
import type { DocBlock, RawDocument } from '@/lib/import/types';

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP64_VERSION = 45;
const ZIP_END_BYTES = 22;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

/** One OOXML part may be as large as the reconstructed-manuscript budget. */
const MAX_DOCX_ENTRY_UNCOMPRESSED_BYTES = MAX_IMPORT_RECONSTRUCTED_BYTES;
/**
 * The parsed prose remains capped at 64 MiB later in the pipeline. Allow
 * another 32 MiB here for styles, relationships, metadata, fonts, and media.
 */
const MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES =
  MAX_IMPORT_RECONSTRUCTED_BYTES + 32 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 4_096;

const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_REJECTED_FLAGS = 0x0001 | 0x0040;

interface ZipEntryRange {
  start: number;
  end: number;
}

interface ZipPayload {
  method: number;
  start: number;
  end: number;
  uncompressedSize: number;
  crc: number;
}

function unsafeDocxArchive(reason: string): never {
  throw new Error(`The DOCX archive is unsafe or malformed (${reason}).`);
}

function hasZip64ExtraField(extra: Buffer): boolean {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) unsafeDocxArchive('malformed extra field');
    const fieldId = extra.readUInt16LE(offset);
    const fieldLength = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldLength > extra.length) {
      unsafeDocxArchive('malformed extra field');
    }
    if (fieldId === ZIP64_EXTRA_FIELD_ID) return true;
    offset += fieldLength;
  }
  return false;
}

function safeEntryName(nameBytes: Buffer): string {
  const name = nameBytes.toString('utf8');
  if (!name || name.includes('\uFFFD') || name.includes('\0') || name.includes('\\')) {
    unsafeDocxArchive('invalid entry name');
  }
  if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) {
    unsafeDocxArchive('absolute entry path');
  }
  if (name.split('/').some(segment => segment === '.' || segment === '..')) {
    unsafeDocxArchive('unsafe entry path');
  }
  return name;
}

function dataDescriptorEnd(
  buffer: Buffer,
  start: number,
  upperBound: number,
  expectedCrc: number,
  expectedCompressedSize: number,
  expectedUncompressedSize: number,
): number {
  const matchesAt = (offset: number): boolean =>
    offset + 12 <= upperBound
    && buffer.readUInt32LE(offset) === expectedCrc
    && buffer.readUInt32LE(offset + 4) === expectedCompressedSize
    && buffer.readUInt32LE(offset + 8) === expectedUncompressedSize;

  if (
    start + 16 <= upperBound
    && buffer.readUInt32LE(start) === ZIP_DATA_DESCRIPTOR_SIGNATURE
    && matchesAt(start + 4)
  ) {
    return start + 16;
  }
  if (matchesAt(start)) return start + 12;
  return unsafeDocxArchive('invalid data descriptor');
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < ZIP_END_BYTES) unsafeDocxArchive('missing end record');
  const earliest = Math.max(0, buffer.length - ZIP_END_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = buffer.length - ZIP_END_BYTES; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + ZIP_END_BYTES + commentLength === buffer.length) return offset;
  }
  return unsafeDocxArchive('missing end record');
}

/**
 * Validate the complete non-ZIP64 central directory before Mammoth can inflate
 * any OOXML part. Local headers must repeat the same sizes and flags, so an
 * archive cannot hide an unbounded stream behind deferred or conflicting
 * metadata.
 */
function assertSafeDocxArchive(buffer: Buffer): void {
  const endOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    unsafeDocxArchive('multi-disk archive');
  }
  if (
    totalEntries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || (endOffset >= 20 && buffer.readUInt32LE(endOffset - 20) === 0x07064b50)
  ) {
    unsafeDocxArchive('ZIP64 archive');
  }
  if (totalEntries === 0 || totalEntries > MAX_DOCX_ENTRIES) {
    unsafeDocxArchive('entry count limit');
  }

  const centralEnd = centralOffset + centralSize;
  if (
    !Number.isSafeInteger(centralEnd)
    || centralOffset >= endOffset
    || centralEnd !== endOffset
  ) {
    unsafeDocxArchive('central directory bounds');
  }

  let cursor = centralOffset;
  let totalUncompressed = 0;
  const seenNames = new Set<string>();
  const localRanges: ZipEntryRange[] = [];
  const payloads: ZipPayload[] = [];

  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor + ZIP_CENTRAL_HEADER_BYTES > centralEnd
      || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE
    ) {
      unsafeDocxArchive('central directory entry');
    }

    const versionNeeded = buffer.readUInt16LE(cursor + 6);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const centralEntryEnd =
      cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;

    if (centralEntryEnd > centralEnd || nameLength === 0) {
      unsafeDocxArchive('central directory entry bounds');
    }
    if (
      versionNeeded >= ZIP64_VERSION
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff
      || diskStart === 0xffff
    ) {
      unsafeDocxArchive('ZIP64 entry');
    }
    if (diskStart !== 0) unsafeDocxArchive('multi-disk entry');
    if ((flags & ZIP_REJECTED_FLAGS) !== 0) {
      unsafeDocxArchive('encrypted entry');
    }
    if (method !== 0 && method !== 8) {
      unsafeDocxArchive('unsupported compression method');
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      unsafeDocxArchive('invalid stored entry sizes');
    }

    const nameStart = cursor + ZIP_CENTRAL_HEADER_BYTES;
    const nameBytes = buffer.subarray(nameStart, nameStart + nameLength);
    const name = safeEntryName(nameBytes);
    if (seenNames.has(name)) unsafeDocxArchive('duplicate entry name');
    seenNames.add(name);

    const extraStart = nameStart + nameLength;
    const centralExtra = buffer.subarray(extraStart, extraStart + extraLength);
    if (hasZip64ExtraField(centralExtra)) unsafeDocxArchive('ZIP64 extra field');

    if (uncompressedSize > MAX_DOCX_ENTRY_UNCOMPRESSED_BYTES) {
      unsafeDocxArchive('entry size limit');
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_DOCX_TOTAL_UNCOMPRESSED_BYTES) {
      unsafeDocxArchive('total size limit');
    }

    if (
      localOffset + ZIP_LOCAL_HEADER_BYTES > centralOffset
      || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE
    ) {
      unsafeDocxArchive('local header');
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + ZIP_LOCAL_HEADER_BYTES;
    const localExtraStart = localNameStart + localNameLength;
    const dataStart = localExtraStart + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    const usesDataDescriptor = (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;

    if (
      localFlags !== flags
      || localMethod !== method
      || localNameLength !== nameLength
      || dataEnd > centralOffset
      || !buffer.subarray(localNameStart, localExtraStart).equals(nameBytes)
    ) {
      unsafeDocxArchive('conflicting local header');
    }
    const localExtra = buffer.subarray(localExtraStart, dataStart);
    if (hasZip64ExtraField(localExtra)) unsafeDocxArchive('ZIP64 local extra field');
    let localEntryEnd = dataEnd;
    if (usesDataDescriptor) {
      if (
        (localCrc !== 0 && localCrc !== crc)
        || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)
      ) {
        unsafeDocxArchive('conflicting deferred local header');
      }
      localEntryEnd = dataDescriptorEnd(
        buffer,
        dataEnd,
        centralOffset,
        crc,
        compressedSize,
        uncompressedSize,
      );
    } else if (
      localCrc !== crc
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize
    ) {
      unsafeDocxArchive('conflicting local header');
    }
    localRanges.push({ start: localOffset, end: localEntryEnd });
    payloads.push({
      method,
      start: dataStart,
      end: dataEnd,
      uncompressedSize,
      crc,
    });

    cursor = centralEntryEnd;
  }

  if (cursor !== centralEnd) unsafeDocxArchive('central directory length');
  localRanges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      unsafeDocxArchive('overlapping entries');
    }
  }

  // Central-directory sizes are attacker-controlled. Verify every DEFLATE
  // stream with an output ceiling of its declared size + 1 before Mammoth sees
  // it, then require exact length and CRC. This catches a stream that lies in
  // both its central and local headers without retaining all archive output.
  for (const payload of payloads) {
    const compressed = buffer.subarray(payload.start, payload.end);
    let uncompressed: Buffer;
    if (payload.method === 0) {
      uncompressed = compressed;
    } else {
      try {
        uncompressed = inflateRawSync(compressed, {
          maxOutputLength: payload.uncompressedSize + 1,
        });
      } catch {
        unsafeDocxArchive('invalid or oversized compressed payload');
      }
    }
    if (
      uncompressed.byteLength !== payload.uncompressedSize
      || crc32(uncompressed) !== payload.crc
    ) {
      unsafeDocxArchive('payload size or checksum mismatch');
    }
  }
}

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
  assertSafeDocxArchive(buffer);
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
