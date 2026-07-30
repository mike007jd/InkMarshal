// S10a regression: parseDocx's raw-text fallback must trigger not only when the
// HTML walk yields ZERO blocks, but also when it captures materially less prose
// than the raw text. Before the fix the regex tokenizer silently dropped
// paragraphs on malformed mammoth output (unclosed <p>, stray <), and the
// fallback only fired when blocks.length === 0 — so a partially-broken docx
// that yielded SOME blocks but lost others imported incomplete with no warning.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { strToU8, Zip, ZipDeflate, zipSync } from 'fflate';

const MIB = 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * MIB;

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter 1</w:t></w:r></w:p>
    <w:p><w:r><w:t>${body}</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;
}

function docxParts(body: string): Record<string, Uint8Array> {
  return {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`),
    'word/document.xml': strToU8(documentXml(body)),
  };
}

function buildDocx(body = 'A safe compressed paragraph.'): Buffer {
  return Buffer.from(zipSync(docxParts(body), { level: 9 }));
}

function buildDataDescriptorDocx(body = 'A safe streamed paragraph.'): Buffer {
  const chunks: Buffer[] = [];
  let archiveError: Error | null = null;
  const archive = new Zip((error, chunk) => {
    if (error) {
      archiveError = error;
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  for (const [name, bytes] of Object.entries(docxParts(body))) {
    const entry = new ZipDeflate(name, { level: 9 });
    archive.add(entry);
    entry.push(bytes, true);
  }
  archive.end();
  if (archiveError) throw archiveError;
  return Buffer.concat(chunks);
}

function buildStreamingCompressionBomb(uncompressedSize: number): Buffer {
  const chunks: Buffer[] = [];
  let archiveError: Error | null = null;
  const archive = new Zip((error, chunk) => {
    if (error) {
      archiveError = error;
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  const entry = new ZipDeflate('word/document.xml', { level: 9 });
  archive.add(entry);
  const repeatedChunk = Buffer.alloc(64 * 1024, 0x41);
  let remaining = uncompressedSize;
  while (remaining > 0) {
    const chunkLength = Math.min(remaining, repeatedChunk.byteLength);
    remaining -= chunkLength;
    entry.push(repeatedChunk.subarray(0, chunkLength), remaining === 0);
  }
  archive.end();
  if (archiveError) throw archiveError;
  return Buffer.concat(chunks);
}

function centralDirectoryOffset(bytes: Buffer): number {
  return bytes.readUInt32LE(endOfCentralDirectoryOffset(bytes) + 16);
}

function endOfCentralDirectoryOffset(bytes: Buffer): number {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const offset = bytes.lastIndexOf(signature);
  if (offset < 0) throw new Error('Test fixture has no end-of-central-directory record.');
  return offset;
}

function mutateFlags(bytes: Buffer, flag: number): Buffer {
  const mutated = Buffer.from(bytes);
  const centralOffset = centralDirectoryOffset(mutated);
  mutated.writeUInt16LE(mutated.readUInt16LE(6) | flag, 6);
  mutated.writeUInt16LE(mutated.readUInt16LE(centralOffset + 8) | flag, centralOffset + 8);
  return mutated;
}

function mutateFirstEntryUncompressedSize(bytes: Buffer, size: number): Buffer {
  const mutated = Buffer.from(bytes);
  const centralOffset = centralDirectoryOffset(mutated);
  mutated.writeUInt32LE(size, centralOffset + 24);
  const flags = mutated.readUInt16LE(6);
  if ((flags & 0x0008) === 0) {
    mutated.writeUInt32LE(size, 22);
    return mutated;
  }

  const compressedSize = mutated.readUInt32LE(centralOffset + 20);
  const nameLength = mutated.readUInt16LE(26);
  const extraLength = mutated.readUInt16LE(28);
  const descriptorOffset = 30 + nameLength + extraLength + compressedSize;
  const descriptorHasSignature = mutated.readUInt32LE(descriptorOffset) === 0x08074b50;
  mutated.writeUInt32LE(size, descriptorOffset + (descriptorHasSignature ? 12 : 8));
  return mutated;
}

function mutateAllEntryUncompressedSizes(bytes: Buffer, size: number): Buffer {
  const mutated = Buffer.from(bytes);
  const endOffset = endOfCentralDirectoryOffset(mutated);
  const entries = mutated.readUInt16LE(endOffset + 10);
  let cursor = mutated.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entries; index += 1) {
    const localOffset = mutated.readUInt32LE(cursor + 42);
    mutated.writeUInt32LE(size, localOffset + 22);
    mutated.writeUInt32LE(size, cursor + 24);
    cursor +=
      46
      + mutated.readUInt16LE(cursor + 28)
      + mutated.readUInt16LE(cursor + 30)
      + mutated.readUInt16LE(cursor + 32);
  }
  return mutated;
}

afterEach(() => {
  vi.doUnmock('mammoth');
  vi.resetModules();
});

describe('parseDocx — S10a raw-text fallback on under-capture', () => {
  it('falls back to raw text when the HTML walk captures materially less prose', async () => {
    // mammoth.convertToHtml returns HTML where one paragraph is wrapped in a
    // <div> — the regex tokenizer only matches h1-6/p/li, so the <div>-wrapped
    // paragraph is silently dropped. The old guard (blocks.length === 0) did not
    // fire because the <p> block was still captured, so ~half the prose was
    // lost with no warning. extractRawText returns the full text.
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn(async () => ({
          value: '<p>First captured paragraph here.</p><div>This div-wrapped paragraph is dropped by the regex tokenizer.</div>',
          messages: [],
        })),
        extractRawText: vi.fn(async () => ({
          value: 'First captured paragraph here.\n\nThis div-wrapped paragraph is dropped by the regex tokenizer.',
          messages: [],
        })),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    const doc = await parseDocx(buildDocx(), 'manuscript.docx');
    const allText = doc.blocks.map(b => b.text).join('\n');
    // The raw fallback captured BOTH paragraphs (the dropped div-wrapped one too).
    expect(allText).toContain('First captured paragraph here.');
    expect(allText).toContain('This div-wrapped paragraph is dropped by the regex tokenizer.');
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);

  });

  it('keeps the HTML walk when it captures essentially all the prose', async () => {
    // Well-formed HTML capturing everything — no fallback, heading inference
    // and bold-title detection survive.
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml: vi.fn(async () => ({
          value: '<h1>Title</h1><p>First paragraph here.</p><p>Second paragraph here.</p>',
          messages: [],
        })),
        extractRawText: vi.fn(async () => ({
          value: 'Title\n\nFirst paragraph here.\n\nSecond paragraph here.',
          messages: [],
        })),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    const doc = await parseDocx(buildDocx(), 'manuscript.docx');
    // The HTML walk kept the heading structure (not flattened to paragraphs).
    expect(doc.blocks.some(b => b.kind === 'heading' && b.text === 'Title')).toBe(true);
    expect(doc.blocks.some(b => b.kind === 'paragraph' && b.text === 'First paragraph here.')).toBe(true);

  });
});

describe('parseDocx — pre-inflate ZIP resource guard', () => {
  it('accepts a valid compressed DOCX before parsing it with Mammoth', async () => {
    const prose = 'Highly compressible but bounded prose. '.repeat(8_000);
    const bytes = buildDocx(prose);
    expect(bytes.byteLength).toBeLessThan(Buffer.byteLength(prose) / 10);

    const { parseDocx } = await import('@/lib/import/parse-docx');
    const doc = await parseDocx(bytes, 'compressed.docx');

    expect(doc.blocks.map(block => block.text).join('\n')).toContain(
      'Highly compressible but bounded prose.',
    );
  });

  it('rejects a small-on-disk compression bomb before Mammoth is loaded', async () => {
    const bomb = buildStreamingCompressionBomb(MAX_ENTRY_BYTES + 1);
    expect(bomb.byteLength).toBeLessThan(100_000);

    const convertToHtml = vi.fn();
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml,
        extractRawText: vi.fn(),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    await expect(parseDocx(bomb, 'bomb.docx')).rejects.toThrow('entry size limit');
    const concealedBomb = mutateFirstEntryUncompressedSize(bomb, MIB);
    await expect(parseDocx(concealedBomb, 'concealed-bomb.docx')).rejects.toThrow(
      'invalid or oversized compressed payload',
    );
    expect(convertToHtml).not.toHaveBeenCalled();
  });

  it.each([
    ['encrypted', 0x0001],
    ['strong-encryption', 0x0040],
  ])('rejects %s entries before Mammoth', async (_label, flag) => {
    const convertToHtml = vi.fn();
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml,
        extractRawText: vi.fn(),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    await expect(parseDocx(mutateFlags(buildDocx(), flag), 'unsafe.docx'))
      .rejects.toThrow('encrypted entry');
    expect(convertToHtml).not.toHaveBeenCalled();
  });

  it('accepts a valid streamed DOCX with signed data descriptors', async () => {
    const bytes = buildDataDescriptorDocx('LibreOffice-compatible streamed content.');
    expect(bytes.readUInt16LE(6) & 0x0008).toBe(0x0008);

    const { parseDocx } = await import('@/lib/import/parse-docx');
    const doc = await parseDocx(bytes, 'streamed.docx');

    expect(doc.blocks.map(block => block.text).join('\n')).toContain(
      'LibreOffice-compatible streamed content.',
    );
  });

  it('rejects a malformed data descriptor before Mammoth', async () => {
    const bytes = buildDataDescriptorDocx();
    const centralOffset = centralDirectoryOffset(bytes);
    const compressedSize = bytes.readUInt32LE(centralOffset + 20);
    const localNameLength = bytes.readUInt16LE(26);
    const localExtraLength = bytes.readUInt16LE(28);
    const descriptorOffset = 30 + localNameLength + localExtraLength + compressedSize;
    expect(bytes.readUInt32LE(descriptorOffset)).toBe(0x08074b50);
    bytes.writeUInt32LE(0, descriptorOffset + 4);

    const convertToHtml = vi.fn();
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml,
        extractRawText: vi.fn(),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    await expect(parseDocx(bytes, 'bad-descriptor.docx')).rejects.toThrow(
      'invalid data descriptor',
    );
    expect(convertToHtml).not.toHaveBeenCalled();
  });

  it('rejects ZIP64 entries before Mammoth', async () => {
    const bytes = buildDocx();
    const centralOffset = centralDirectoryOffset(bytes);
    bytes.writeUInt16LE(45, centralOffset + 6);

    const convertToHtml = vi.fn();
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml,
        extractRawText: vi.fn(),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    await expect(parseDocx(bytes, 'zip64.docx')).rejects.toThrow('ZIP64 entry');
    expect(convertToHtml).not.toHaveBeenCalled();
  });

  it('rejects an aggregate declared size above the package-overhead budget', async () => {
    const bytes = mutateAllEntryUncompressedSizes(buildDocx(), 40 * MIB);
    const convertToHtml = vi.fn();
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml,
        extractRawText: vi.fn(),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    await expect(parseDocx(bytes, 'aggregate-bomb.docx')).rejects.toThrow(
      'total size limit',
    );
    expect(convertToHtml).not.toHaveBeenCalled();
  });

  it('rejects an entry count above the OOXML package limit', async () => {
    const bytes = buildDocx();
    const endOffset = endOfCentralDirectoryOffset(bytes);
    bytes.writeUInt16LE(4_097, endOffset + 8);
    bytes.writeUInt16LE(4_097, endOffset + 10);

    const convertToHtml = vi.fn();
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml,
        extractRawText: vi.fn(),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    await expect(parseDocx(bytes, 'too-many-parts.docx')).rejects.toThrow(
      'entry count limit',
    );
    expect(convertToHtml).not.toHaveBeenCalled();
  });

  it('rejects conflicting local and central directory sizes before Mammoth', async () => {
    const bytes = buildDocx();
    bytes.writeUInt32LE(bytes.readUInt32LE(22) + 1, 22);

    const convertToHtml = vi.fn();
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml,
        extractRawText: vi.fn(),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    await expect(parseDocx(bytes, 'mismatch.docx')).rejects.toThrow(
      'conflicting local header',
    );
    expect(convertToHtml).not.toHaveBeenCalled();
  });

  it('rejects malformed archives without importing Mammoth', async () => {
    const bytes = buildDocx().subarray(0, -1);
    const convertToHtml = vi.fn();
    vi.doMock('mammoth', () => ({
      default: {
        convertToHtml,
        extractRawText: vi.fn(),
      },
    }));
    vi.resetModules();
    const { parseDocx } = await import('@/lib/import/parse-docx');

    await expect(parseDocx(bytes, 'truncated.docx')).rejects.toThrow(
      'missing end record',
    );
    expect(convertToHtml).not.toHaveBeenCalled();
  });
});
