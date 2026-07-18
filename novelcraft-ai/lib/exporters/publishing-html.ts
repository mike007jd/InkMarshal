/**
 * Shared, side-effect-free HTML/CSS builders for the publishing workspace.
 *
 * SINGLE SOURCE OF TRUTH for the XHTML and CSS written by the EPUB exporter.
 *
 * Everything here is a pure string transform — no DOM, no fs, no fetch — so it
 * runs identically in the Node export path, the Tauri webview, and vitest.
 *
 * NOTE on lint/design-system: this is a `.ts` file returning CSS/XHTML strings
 * destined for the EPUB package and the preview iframes. The raw hex colors and
 * print units here are export-artifact content, NOT React component styling, so
 * they are intentionally literal and are not scanned by the design-system
 * contract test (which only reads `.tsx`/`.css`).
 */

import type { PublishingConfig, PublishingSection } from '@/lib/db-types';
import { normalizeLineEndings } from '@/lib/exporters/text';

export interface PublishingNovelLike {
  title: string;
  genre?: string;
}

export interface PublishingChapterLike {
  chapterNumber: number;
  title: string;
  content: string;
}

/**
 * Escape the five XML-significant characters for use in element text and
 * double-quoted attribute values. Used on EVERY dynamic value that lands in
 * OPF/NCX/XHTML — a single unescaped `&` or `<` fails epubcheck, so this must
 * not be bypassed.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Split plain text into paragraphs on blank lines, each line break kept as <br/>. */
function paragraphsToXhtml(raw: string): string {
  const text = normalizeLineEndings(raw).trim();
  if (!text) return '';
  return text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      const inner = para
        .split('\n')
        .map((line) => escapeXml(line.trim()))
        .join('<br/>');
      return `      <p>${inner}</p>`;
    })
    .join('\n');
}

/** CSS class for the configured chapter-start behaviour. */
function chapterStartClass(style: PublishingConfig['layout']['chapterStartStyle']): string {
  switch (style) {
    case 'newRecto':
      return 'chapter chapter-recto';
    case 'continuous':
      return 'chapter chapter-continuous';
    case 'newPage':
    default:
      return 'chapter chapter-newpage';
  }
}

/**
 * Build the page-break CSS rule for a chapter-start style. Exposed so both the
 * stylesheet builder and the unit test assert against the SAME mapping.
 */
export function chapterStartCss(style: PublishingConfig['layout']['chapterStartStyle']): string {
  switch (style) {
    case 'newRecto':
      // Force the chapter onto the next right-hand (recto) page.
      return '.chapter-recto { break-before: recto; page-break-before: right; }';
    case 'continuous':
      // Run straight on from the previous chapter — no forced break.
      return '.chapter-continuous { break-before: auto; page-break-before: auto; }';
    case 'newPage':
    default:
      return '.chapter-newpage { break-before: page; page-break-before: always; }';
  }
}

export interface BuildStyleOptions {
  /** When true, reference the embedded NotoSerifSC face via @font-face. */
  embedFont?: boolean;
  /** Path (relative to the stylesheet) of the embedded font, when embedFont. */
  fontHref?: string;
}

/**
 * The book stylesheet — the SAME CSS string drives the EPUB `style.css` and the
 * preview iframe `<style>`, guaranteeing visual parity. Margins/trim flow in
 * from the layout config; chapter-start behaviour is driven by the three
 * `chapter-*` classes.
 */
export function buildStyleCss(config: PublishingConfig, options: BuildStyleOptions = {}): string {
  const { layout } = config;
  const margin = Math.max(0, Math.min(60, Number(layout.marginsMm) || 0));
  const fontFace =
    options.embedFont && options.fontHref
      ? `@font-face {
  font-family: "Noto Serif SC";
  src: url("${options.fontHref}");
  font-weight: normal;
  font-style: normal;
}
`
      : '';
  const bodyFamily = options.embedFont
    ? `"Noto Serif SC", "Songti SC", "SimSun", "Source Han Serif", serif`
    : `"Songti SC", "SimSun", "Source Han Serif SC", "Source Han Serif", "Noto Serif CJK SC", serif`;

  return `${fontFace}html { font-size: 100%; }
body {
  margin: ${margin}mm;
  font-family: ${bodyFamily};
  line-height: 1.8;
  color: #1a1410;
  background: #ffffff;
  text-align: justify;
  -webkit-hyphens: auto;
  hyphens: auto;
}
h1, h2 { font-weight: 600; line-height: 1.3; color: #1a1410; }
h1.book-title { font-size: 2.2em; text-align: center; margin: 18% 0 0.4em; }
p.book-subtitle { font-size: 1.2em; text-align: center; color: #5a4a36; margin: 0 0 0.4em; font-style: italic; }
p.book-author { font-size: 1.05em; text-align: center; color: #3a2f22; margin: 1.2em 0 0; }
.chapter { margin: 0; }
.chapter-title { font-size: 1.5em; text-align: center; margin: 1.4em 0 1.2em; }
.chapter-number { display: block; font-size: 0.72em; letter-spacing: 0.18em; text-transform: uppercase; color: #8a7a5e; margin-bottom: 0.4em; }
.chapter p { margin: 0; text-indent: 2em; }
.chapter p:first-of-type { text-indent: 0; }
.frontmatter { margin: 0; }
.frontmatter-title { font-size: 1.5em; text-align: center; margin: 1.6em 0 1em; }
.frontmatter p { margin: 0 0 0.8em; text-indent: 0; }
.copyright-page { font-size: 0.9em; color: #3a2f22; }
.copyright-page p { margin: 0 0 0.6em; }
.dedication { text-align: center; font-style: italic; margin: 22% 0; color: #3a2f22; }
.toc-list { list-style: none; padding: 0; margin: 1em 0; }
.toc-list li { margin: 0.5em 0; }
.toc-list a { color: #1a1410; text-decoration: none; }
.running-header { text-align: center; font-size: 0.78em; color: #8a7a5e; letter-spacing: 0.08em; margin-bottom: 1.5em; }
.running-footer { text-align: center; font-size: 0.78em; color: #8a7a5e; letter-spacing: 0.08em; margin-top: 2em; }
${chapterStartCss('newPage')}
${chapterStartCss('newRecto')}
${chapterStartCss('continuous')}
`;
}

/** Wrap a body fragment in a minimal, valid XHTML5 document for the package. */
export function wrapXhtmlDocument(args: {
  title: string;
  bodyClass?: string;
  stylesheetHref: string;
  body: string;
  lang: string;
}): string {
  const bodyClassAttr = args.bodyClass ? ` class="${args.bodyClass}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(args.lang)}" xml:lang="${escapeXml(args.lang)}">
  <head>
    <meta charset="UTF-8"/>
    <title>${escapeXml(args.title)}</title>
    <link rel="stylesheet" type="text/css" href="${escapeXml(args.stylesheetHref)}"/>
  </head>
  <body${bodyClassAttr}>
${args.body}
  </body>
</html>
`;
}

export interface FrontMatterDoc {
  /** Stable id used in manifest/spine (e.g. `titlepage`). */
  key: string;
  /** Human title used in nav/ncx (empty string = omit from nav). */
  navLabel: string;
  /** Full XHTML body fragment (no <html>/<head> — see wrapXhtmlDocument). */
  body: string;
}

const FRONT_MATTER_KEYS = [
  'titlePage',
  'copyrightPage',
  'toc',
  'dedication',
  'acknowledgements',
  'authorBio',
] as const;
type FrontMatterKey = (typeof FRONT_MATTER_KEYS)[number];

function section(config: PublishingConfig, key: FrontMatterKey): PublishingSection {
  return config.frontMatter[key];
}

/**
 * Build every ENABLED front-matter document (title/copyright/toc/dedication/
 * acknowledgements/authorBio) as ordered body fragments. The TOC is special:
 * its links are generated from the chapter list (the body? field is ignored).
 *
 * Returned in canonical book order. Each item is later wrapped + added to the
 * spine before the chapters.
 */
export function buildFrontMatterSections(
  novel: PublishingNovelLike,
  chapters: PublishingChapterLike[],
  config: PublishingConfig,
  options: { chapterHref?: (chapterNumber: number, index: number) => string } = {},
): FrontMatterDoc[] {
  const out: FrontMatterDoc[] = [];
  const { metadata } = config;
  const lang = metadata.language || 'zh';

  if (section(config, 'titlePage').enabled) {
    const subtitle = metadata.subtitle
      ? `      <p class="book-subtitle">${escapeXml(metadata.subtitle)}</p>\n`
      : '';
    const author = metadata.author
      ? `      <p class="book-author">${escapeXml(metadata.author)}</p>\n`
      : '';
    out.push({
      key: 'titlepage',
      navLabel: '',
      body: `    <section class="frontmatter title-page" epub:type="titlepage">
      <h1 class="book-title">${escapeXml(novel.title || 'Untitled')}</h1>
${subtitle}${author}    </section>`,
    });
  }

  if (section(config, 'copyrightPage').enabled) {
    const custom = section(config, 'copyrightPage').body?.trim();
    const body = custom
      ? paragraphsToXhtml(custom)
      : buildDefaultCopyrightBody(novel, config);
    out.push({
      key: 'copyright',
      navLabel: '',
      body: `    <section class="frontmatter copyright-page" epub:type="copyright-page">
${body}
    </section>`,
    });
  }

  if (section(config, 'toc').enabled) {
    const hrefFor = options.chapterHref ?? ((_n, i) => `chapter${i + 1}.xhtml`);
    const items = chapters
      .map((ch, i) => {
        const label = ch.title?.trim()
          ? `${chapterDisplayNumber(ch.chapterNumber)}　${escapeXml(ch.title.trim())}`
          : chapterDisplayNumber(ch.chapterNumber);
        return `        <li><a href="${escapeXml(hrefFor(ch.chapterNumber, i))}">${label}</a></li>`;
      })
      .join('\n');
    out.push({
      key: 'toc-page',
      navLabel: tocLabel(lang),
      body: `    <section class="frontmatter toc-page" epub:type="toc">
      <h2 class="frontmatter-title">${escapeXml(tocLabel(lang))}</h2>
      <ol class="toc-list">
${items}
      </ol>
    </section>`,
    });
  }

  if (section(config, 'dedication').enabled && section(config, 'dedication').body?.trim()) {
    out.push({
      key: 'dedication',
      navLabel: '',
      body: `    <section class="frontmatter dedication" epub:type="dedication">
${paragraphsToXhtml(section(config, 'dedication').body ?? '')}
    </section>`,
    });
  }

  if (section(config, 'acknowledgements').enabled && section(config, 'acknowledgements').body?.trim()) {
    out.push({
      key: 'acknowledgements',
      navLabel: ackLabel(lang),
      body: `    <section class="frontmatter acknowledgements" epub:type="acknowledgments">
      <h2 class="frontmatter-title">${escapeXml(ackLabel(lang))}</h2>
${paragraphsToXhtml(section(config, 'acknowledgements').body ?? '')}
    </section>`,
    });
  }

  if (section(config, 'authorBio').enabled && section(config, 'authorBio').body?.trim()) {
    out.push({
      key: 'author-bio',
      navLabel: bioLabel(lang),
      body: `    <section class="frontmatter author-bio" epub:type="bodymatter">
      <h2 class="frontmatter-title">${escapeXml(bioLabel(lang))}</h2>
${paragraphsToXhtml(section(config, 'authorBio').body ?? '')}
    </section>`,
    });
  }

  return out;
}

function buildDefaultCopyrightBody(novel: PublishingNovelLike, config: PublishingConfig): string {
  const { metadata } = config;
  const lines: string[] = [];
  lines.push(escapeXml(novel.title || 'Untitled'));
  if (metadata.author) lines.push(`${copyrightWord(metadata.language)} ${escapeXml(metadata.copyrightYear || String(new Date().getFullYear()))} ${escapeXml(metadata.author)}`);
  else lines.push(`${copyrightWord(metadata.language)} ${escapeXml(metadata.copyrightYear || String(new Date().getFullYear()))}`);
  if (metadata.publisher) lines.push(escapeXml(metadata.publisher));
  if (metadata.isbn) lines.push(`ISBN ${escapeXml(metadata.isbn)}`);
  if (metadata.rightsNotice) lines.push(escapeXml(metadata.rightsNotice));
  return lines.map((l) => `      <p>${l}</p>`).join('\n');
}

/** Chapter body XHTML fragment — the shared chapter renderer. */
export function buildChapterXhtml(
  chapter: PublishingChapterLike,
  config: PublishingConfig,
): string {
  const cls = chapterStartClass(config.layout.chapterStartStyle);
  const header = config.layout.header?.trim()
    ? `      <p class="running-header">${escapeXml(config.layout.header.trim())}</p>\n`
    : '';
  const footer = config.layout.footer?.trim()
    ? `      <p class="running-footer">${escapeXml(config.layout.footer.trim())}</p>\n`
    : '';
  const title = chapter.title?.trim()
    ? `        <span class="chapter-number">${escapeXml(chapterDisplayNumber(chapter.chapterNumber))}</span>${escapeXml(chapter.title.trim())}`
    : escapeXml(chapterDisplayNumber(chapter.chapterNumber));
  const paras = paragraphsToXhtml(chapter.content) || '      <p></p>';
  return `    <section class="${cls}" epub:type="chapter">
${header}      <h2 class="chapter-title">
${title}
      </h2>
${paras}
${footer}    </section>`;
}

function chapterDisplayNumber(n: number): string {
  return `第${n}章`;
}

function tocLabel(lang: string): string {
  return lang.startsWith('en') ? 'Contents' : '目录';
}
function ackLabel(lang: string): string {
  return lang.startsWith('en') ? 'Acknowledgements' : '致谢';
}
function bioLabel(lang: string): string {
  return lang.startsWith('en') ? 'About the Author' : '作者简介';
}
function copyrightWord(lang?: string): string {
  return (lang || '').startsWith('en') ? 'Copyright ©' : '版权所有 ©';
}
