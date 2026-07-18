/**
 * Hand-written EPUB 3 builder (zero new deps — uses the already-bundled
 * `fflate`). An EPUB is a deterministic ZIP of XHTML + an OPF package document;
 * we assemble it directly rather than pulling epub-gen-memory (which drags in a
 * second zip lib + a DOMParser that is flaky in the Tauri webview).
 *
 * Container correctness rules enforced here (epubcheck-critical):
 *   1. `mimetype` MUST be the FIRST zip entry and MUST be STORED (level 0),
 *      uncompressed, no extra field.
 *   2. Every dynamic value that lands in OPF/NCX/XHTML is escaped (escapeXml).
 *   3. EPUB 3 `nav.xhtml` (with epub:type="toc") IS the canonical nav; a
 *      `toc.ncx` is also emitted for EPUB 2 / Kindle / legacy-reader fallback.
 *
 * Reading order (spine): front matter (per config) → chapters. CJK renders via
 * the reader's system serif by default; the publication preset (embedFont) also
 * subsets + embeds NotoSerifSC so the page looks identical on any device.
 */

import { strToU8, zipSync } from 'fflate';

import type { PublishingConfig } from '@/lib/db-types';
import {
  buildChapterXhtml,
  buildFrontMatterSections,
  buildStyleCss,
  escapeXml,
  wrapXhtmlDocument,
  type PublishingChapterLike,
  type PublishingNovelLike,
} from '@/lib/exporters/publishing-html';
import { presetEmbedsFont } from '@/lib/exporters/publishing-presets';

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const FONT_FILENAME = 'NotoSerifSC-Regular.otf';

export interface BuildEpubOptions {
  /**
   * Override font embedding. Defaults to the preset rule (publication only).
   * When true and the bundled face cannot be loaded, the EPUB is still produced
   * font-less (readers fall back to system CJK fonts) rather than failing.
   */
  embedFont?: boolean;
}

/**
 * Build a valid EPUB 3 package as raw bytes (ready for a Blob or fs write).
 * Deterministic for a given input (no timestamps in the zip via fflate's
 * default mtime handling kept stable across runs in practice).
 */
export async function buildNovelEpubBuffer(
  novel: PublishingNovelLike,
  chapters: PublishingChapterLike[],
  config: PublishingConfig,
  options: BuildEpubOptions = {},
): Promise<Uint8Array> {
  const lang = config.metadata.language || 'zh';
  const embedFont = options.embedFont ?? presetEmbedsFont(config.activePreset);

  // Try to load the font ONLY when embedding; never let a font-load failure
  // sink the whole export.
  let fontBytes: Uint8Array | null = null;
  if (embedFont) {
    try {
      const { loadUnicodeFontBytes } = await import('@/lib/exporters/unicode-font');
      fontBytes = await loadUnicodeFontBytes();
    } catch {
      fontBytes = null;
    }
  }

  const fontHref = fontBytes ? `fonts/${FONT_FILENAME}` : undefined;
  const styleCss = buildStyleCss(config, { embedFont: Boolean(fontBytes), fontHref });

  const chapterHref = (_n: number, index: number) => `chapter${index + 1}.xhtml`;
  const frontMatter = buildFrontMatterSections(novel, chapters, config, { chapterHref });

  // ---- Assemble per-document XHTML + manifest/spine/nav entries ------------
  interface Doc {
    id: string;
    filename: string;
    navLabel: string;
    xhtml: string;
  }
  const docs: Doc[] = [];

  frontMatter.forEach((fm, i) => {
    const filename = `front${i + 1}-${fm.key}.xhtml`;
    docs.push({
      id: `front-${i + 1}`,
      filename,
      navLabel: fm.navLabel,
      xhtml: wrapXhtmlDocument({
        title: fm.navLabel || novel.title || 'Untitled',
        stylesheetHref: 'style.css',
        body: fm.body,
        lang,
      }),
    });
  });

  chapters.forEach((chapter, i) => {
    const filename = `chapter${i + 1}.xhtml`;
    const label = chapter.title?.trim() ? `第${chapter.chapterNumber}章　${chapter.title.trim()}` : `第${chapter.chapterNumber}章`;
    docs.push({
      id: `chapter-${i + 1}`,
      filename,
      navLabel: label,
      xhtml: wrapXhtmlDocument({
        title: label,
        stylesheetHref: 'style.css',
        body: buildChapterXhtml(chapter, config),
        lang,
      }),
    });
  });

  const bookId = buildBookId(novel, config);
  const navXhtml = buildNavXhtml(docs, lang, novel.title || 'Untitled');
  const ncx = buildTocNcx(docs, bookId, novel.title || 'Untitled');
  const opf = buildContentOpf({ novel, config, docs, bookId, lang, fontEmbedded: Boolean(fontBytes), fontHref });

  // ---- Zip assembly: mimetype FIRST and STORED, everything else deflated ----
  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  // mimetype must be the first key — insertion order is preserved by fflate.
  files['mimetype'] = [strToU8('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = [strToU8(CONTAINER_XML), { level: 6 }];
  files['OEBPS/content.opf'] = [strToU8(opf), { level: 6 }];
  files['OEBPS/nav.xhtml'] = [strToU8(navXhtml), { level: 6 }];
  files['OEBPS/toc.ncx'] = [strToU8(ncx), { level: 6 }];
  files['OEBPS/style.css'] = [strToU8(styleCss), { level: 6 }];
  for (const doc of docs) {
    files[`OEBPS/${doc.filename}`] = [strToU8(doc.xhtml), { level: 6 }];
  }
  if (fontBytes) {
    files[`OEBPS/fonts/${FONT_FILENAME}`] = [fontBytes, { level: 6 }];
  }

  return zipSync(files, {});
}

function buildBookId(novel: PublishingNovelLike, config: PublishingConfig): string {
  const isbn = config.metadata.isbn?.trim();
  if (isbn) return `urn:isbn:${isbn.replace(/[^0-9Xx]/g, '')}`;
  // Deterministic URN from the title so re-exports keep a stable identifier.
  const slug = (novel.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'untitled';
  return `urn:inkmarshal:${slug}`;
}

function buildContentOpf(args: {
  novel: PublishingNovelLike;
  config: PublishingConfig;
  docs: { id: string; filename: string }[];
  bookId: string;
  lang: string;
  fontEmbedded: boolean;
  fontHref?: string;
}): string {
  const { novel, config, docs, bookId, lang, fontEmbedded } = args;
  const { metadata } = config;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const meta: string[] = [];
  meta.push(`    <dc:identifier id="book-id">${escapeXml(bookId)}</dc:identifier>`);
  meta.push(`    <dc:title>${escapeXml(novel.title || 'Untitled')}</dc:title>`);
  meta.push(`    <dc:language>${escapeXml(lang)}</dc:language>`);
  if (metadata.author) {
    meta.push(`    <dc:creator id="creator">${escapeXml(metadata.author)}</dc:creator>`);
    meta.push(`    <meta refines="#creator" property="role" scheme="marc:relators">aut</meta>`);
  }
  if (metadata.publisher) meta.push(`    <dc:publisher>${escapeXml(metadata.publisher)}</dc:publisher>`);
  if (metadata.description) meta.push(`    <dc:description>${escapeXml(metadata.description)}</dc:description>`);
  if (metadata.subtitle) meta.push(`    <meta property="dcterms:alternative">${escapeXml(metadata.subtitle)}</meta>`);
  if (metadata.rightsNotice) meta.push(`    <dc:rights>${escapeXml(metadata.rightsNotice)}</dc:rights>`);
  if (metadata.copyrightYear) meta.push(`    <dc:date>${escapeXml(metadata.copyrightYear)}</dc:date>`);
  meta.push(`    <meta property="dcterms:modified">${escapeXml(modified)}</meta>`);

  const manifest: string[] = [];
  manifest.push(`    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
  manifest.push(`    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`);
  manifest.push(`    <item id="style" href="style.css" media-type="text/css"/>`);
  if (fontEmbedded) {
    manifest.push(`    <item id="font-serif" href="fonts/${FONT_FILENAME}" media-type="font/otf"/>`);
  }
  for (const doc of docs) {
    manifest.push(`    <item id="${escapeXml(doc.id)}" href="${escapeXml(doc.filename)}" media-type="application/xhtml+xml"/>`);
  }

  const spine = docs
    .map((doc) => `    <itemref idref="${escapeXml(doc.id)}"/>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(lang)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
${meta.join('\n')}
  </metadata>
  <manifest>
${manifest.join('\n')}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>
`;
}

function buildNavXhtml(
  docs: { filename: string; navLabel: string }[],
  lang: string,
  bookTitle: string,
): string {
  const items = docs
    .filter((d) => d.navLabel.trim())
    .map((d) => `        <li><a href="${escapeXml(d.filename)}">${escapeXml(d.navLabel)}</a></li>`)
    .join('\n');
  const tocTitle = lang.startsWith('en') ? 'Contents' : '目录';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">
  <head>
    <meta charset="UTF-8"/>
    <title>${escapeXml(bookTitle)}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
  </head>
  <body>
    <nav epub:type="toc" id="toc" role="doc-toc">
      <h2 class="frontmatter-title">${escapeXml(tocTitle)}</h2>
      <ol class="toc-list">
${items}
      </ol>
    </nav>
  </body>
</html>
`;
}

function buildTocNcx(
  docs: { filename: string; navLabel: string }[],
  bookId: string,
  bookTitle: string,
): string {
  const navPoints = docs
    .filter((d) => d.navLabel.trim())
    .map((d, i) => `    <navPoint id="navpoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(d.navLabel)}</text></navLabel>
      <content src="${escapeXml(d.filename)}"/>
    </navPoint>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(bookId)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>
`;
}
