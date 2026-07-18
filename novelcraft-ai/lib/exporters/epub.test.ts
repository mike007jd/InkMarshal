import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import type { PublishingConfig } from '@/lib/db-types';
import { buildNovelEpubBuffer } from '@/lib/exporters/epub';
import { chapterStartCss } from '@/lib/exporters/publishing-html';
import { resolvePublishingConfig } from '@/lib/exporters/publishing-presets';

const NOVEL = { title: '测试小说 The Test & <Novel>', genre: '玄幻' };
const CHAPTERS = [
  { chapterNumber: 1, title: '初临', content: '林动睁开了眼睛。\n\n这是一个全新的世界。' },
  { chapterNumber: 2, title: '觉醒', content: '第二章正文。\n\n包含 CJK 与 ASCII 混排 mixed content.' },
  { chapterNumber: 3, title: '试炼 & "引号"', content: '含特殊字符 < > & " \' 的正文。' },
];

function config(preset: PublishingConfig['activePreset'] = 'editorial'): PublishingConfig {
  return resolvePublishingConfig({ publishing: undefined }, preset);
}

/** Read the raw central-directory order + per-entry compression bytes from a zip. */
function rawZipEntries(buf: Uint8Array): { name: string; method: number }[] {
  const entries: { name: string; method: number; offset: number }[] = [];
  // Walk local file headers (PK\x03\x04). Good enough for our small, known zips.
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      const method = buf[i + 8] | (buf[i + 9] << 8);
      const nameLen = buf[i + 26] | (buf[i + 27] << 8);
      const extraLen = buf[i + 28] | (buf[i + 29] << 8);
      const compLen = buf[i + 18] | (buf[i + 19] << 8) | (buf[i + 20] << 16) | (buf[i + 21] << 24);
      const name = strFromU8(buf.slice(i + 30, i + 30 + nameLen));
      entries.push({ name, method, offset: i });
      i = i + 30 + nameLen + extraLen + compLen;
    } else {
      break;
    }
  }
  return entries.map((e) => ({ name: e.name, method: e.method }));
}

describe('buildNovelEpubBuffer — container structure', () => {
  it('emits mimetype as the FIRST entry and STORED (uncompressed)', async () => {
    const buf = await buildNovelEpubBuffer(NOVEL, CHAPTERS, config());
    const entries = rawZipEntries(buf);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].name).toBe('mimetype');
    // method 0 = stored. Any other value (8 = deflate) fails epubcheck.
    expect(entries[0].method).toBe(0);

    const files = unzipSync(buf);
    expect(strFromU8(files['mimetype'])).toBe('application/epub+zip');
  });

  it('ships the OCF container pointing at OEBPS/content.opf', async () => {
    const buf = await buildNovelEpubBuffer(NOVEL, CHAPTERS, config());
    const files = unzipSync(buf);
    const container = strFromU8(files['META-INF/container.xml']);
    expect(container).toContain('full-path="OEBPS/content.opf"');
    expect(container).toContain('media-type="application/oebps-package+xml"');
    expect(files['OEBPS/content.opf']).toBeDefined();
  });

  it('produces an EPUB3 nav.xhtml AND an EPUB2 toc.ncx fallback', async () => {
    const buf = await buildNovelEpubBuffer(NOVEL, CHAPTERS, config());
    const files = unzipSync(buf);
    const nav = strFromU8(files['OEBPS/nav.xhtml']);
    const ncx = strFromU8(files['OEBPS/toc.ncx']);
    expect(nav).toContain('epub:type="toc"');
    expect(ncx).toContain('<navMap>');
    // Both reference the chapters.
    expect(nav).toContain('chapter1.xhtml');
    expect(ncx).toContain('chapter1.xhtml');
  });
});

describe('buildNovelEpubBuffer — spine + manifest', () => {
  it('lists every chapter in the spine (front matter + chapters)', async () => {
    const buf = await buildNovelEpubBuffer(NOVEL, CHAPTERS, config('publication'));
    const files = unzipSync(buf);
    const opf = strFromU8(files['OEBPS/content.opf']);

    // One chapter xhtml per input chapter, all present in the manifest + spine.
    for (let i = 1; i <= CHAPTERS.length; i++) {
      expect(files[`OEBPS/chapter${i}.xhtml`]).toBeDefined();
      expect(opf).toContain(`id="chapter-${i}"`);
      expect(opf).toContain(`idref="chapter-${i}"`);
    }

    // Spine chapter itemrefs === input chapter count.
    const chapterItemrefs = [...opf.matchAll(/idref="chapter-\d+"/g)];
    expect(chapterItemrefs).toHaveLength(CHAPTERS.length);
  });

  it('escapes XML-significant characters in all dynamic metadata/titles', async () => {
    const buf = await buildNovelEpubBuffer(NOVEL, CHAPTERS, config());
    const files = unzipSync(buf);
    const opf = strFromU8(files['OEBPS/content.opf']);
    // Title contains & and <Novel> — must be escaped, never raw.
    expect(opf).toContain('&amp;');
    expect(opf).toContain('&lt;Novel&gt;');
    expect(opf).not.toMatch(/<dc:title>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/);

    const ch3 = strFromU8(files['OEBPS/chapter3.xhtml']);
    // Special chars in body/title escaped, no naked unescaped ampersand.
    expect(ch3).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
  });
});

describe('buildNovelEpubBuffer — CJK rendering', () => {
  it('preserves CJK codepoints verbatim (no tofu / mojibake substitution)', async () => {
    const buf = await buildNovelEpubBuffer(NOVEL, CHAPTERS, config());
    const files = unzipSync(buf);
    const ch1 = strFromU8(files['OEBPS/chapter1.xhtml']);
    // Exact CJK text survives the pipeline untouched.
    expect(ch1).toContain('林动睁开了眼睛');
    expect(ch1).toContain('这是一个全新的世界');
    // No replacement char (U+FFFD) and no PDF-style '?' tofu sentinel.
    expect(ch1).not.toContain('�');
  });

  it('embeds the CJK font for the publication preset only', async () => {
    const pub = unzipSync(await buildNovelEpubBuffer(NOVEL, CHAPTERS, config('publication')));
    const sub = unzipSync(await buildNovelEpubBuffer(NOVEL, CHAPTERS, config('submission')));
    // Publication embeds the face + references it; submission does not.
    expect(pub['OEBPS/fonts/NotoSerifSC-Regular.otf']).toBeDefined();
    expect(strFromU8(pub['OEBPS/content.opf'])).toContain('font-serif');
    expect(strFromU8(pub['OEBPS/style.css'])).toContain('@font-face');

    expect(sub['OEBPS/fonts/NotoSerifSC-Regular.otf']).toBeUndefined();
    expect(strFromU8(sub['OEBPS/content.opf'])).not.toContain('font-serif');
  });
});

describe('buildNovelEpubBuffer — chapter-start styles', () => {
  it('maps each chapterStartStyle to the correct page-break CSS', () => {
    expect(chapterStartCss('newPage')).toContain('break-before: page');
    expect(chapterStartCss('newPage')).toContain('page-break-before: always');
    expect(chapterStartCss('newRecto')).toContain('break-before: recto');
    expect(chapterStartCss('newRecto')).toContain('page-break-before: right');
    expect(chapterStartCss('continuous')).toContain('break-before: auto');
  });

  it.each([
    ['newPage', 'chapter-newpage'],
    ['newRecto', 'chapter-recto'],
    ['continuous', 'chapter-continuous'],
  ] as const)('applies the %s class to chapter sections', async (style, expectedClass) => {
    const cfg = config('editorial');
    cfg.layout.chapterStartStyle = style;
    const files = unzipSync(await buildNovelEpubBuffer(NOVEL, CHAPTERS, cfg));
    const ch1 = strFromU8(files['OEBPS/chapter1.xhtml']);
    expect(ch1).toContain(`class="chapter ${expectedClass}"`);
    // The stylesheet always carries all three rules; the section picks one.
    const css = strFromU8(files['OEBPS/style.css']);
    expect(css).toContain(chapterStartCss(style).split('{')[0].trim());
  });
});
