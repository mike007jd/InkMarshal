#!/usr/bin/env node

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { zipSync, strToU8 } from 'fflate';

const outputDir = process.argv[2];
if (!outputDir || !path.isAbsolute(outputDir)) {
  throw new Error('Pass an absolute output directory.');
}
mkdirSync(outputDir, { recursive: true });

const MIB = 1024 * 1024;
const sizes = [2, 10, 25];

function writeSizedText(filename, prefix, targetBytes, fill) {
  const prefixBytes = Buffer.byteLength(prefix);
  if (prefixBytes >= targetBytes) throw new Error(`Prefix exceeds ${filename} target.`);
  const bytes = Buffer.concat([
    Buffer.from(prefix),
    Buffer.alloc(targetBytes - prefixBytes, fill),
  ]);
  writeFileSync(path.join(outputDir, filename), bytes);
}

function documentXml(bodyChars) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter 1</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">${'D'.repeat(bodyChars)}</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;
}

function buildDocx(bodyChars) {
  return zipSync({
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
    'word/document.xml': strToU8(documentXml(bodyChars)),
  }, { level: 0 });
}

function writeSizedDocx(filename, targetBytes) {
  let bodyChars = Math.max(1, targetBytes - 2_048);
  let bytes = buildDocx(bodyChars);
  bodyChars -= bytes.byteLength - targetBytes;
  bytes = buildDocx(bodyChars);
  if (bytes.byteLength > targetBytes || targetBytes - bytes.byteLength > 64) {
    throw new Error(
      `${filename} could not converge to the target: ${bytes.byteLength}/${targetBytes}`,
    );
  }
  writeFileSync(path.join(outputDir, filename), bytes);
}

for (const sizeMiB of sizes) {
  const targetBytes = sizeMiB * MIB;
  writeSizedText(`${sizeMiB}MiB.txt`, 'Chapter 1\n\n', targetBytes, 0x54);
  writeSizedText(`${sizeMiB}MiB.md`, '# Chapter 1\n\n', targetBytes, 0x4d);
  writeSizedDocx(`${sizeMiB}MiB.docx`, targetBytes);
}

for (const sizeMiB of sizes) {
  for (const extension of ['txt', 'md', 'docx']) {
    const filename = `${sizeMiB}MiB.${extension}`;
    const bytes = statSync(path.join(outputDir, filename)).size;
    process.stdout.write(`${filename}\t${bytes}\n`);
  }
}
