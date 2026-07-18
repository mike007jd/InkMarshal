/**
 * Loader for the bundled CJK/Unicode PDF font (Noto Serif SC).
 *
 * The same exporter code runs in two runtimes:
 *  - the desktop webview / browser (client export) → fetch from /fonts/…
 *  - the Next.js API route (submission bundle)     → read from public/fonts/…
 *
 * The font bytes are cached per process; pdf-lib embeds a subset of the
 * glyphs actually used, so shipping the full ~23 MB face does not bloat the
 * produced PDFs.
 */

const UNICODE_FONT_RELATIVE_PATH = 'fonts/NotoSerifSC-Regular.otf';
const UNICODE_FONT_PUBLIC_PATH = `/${UNICODE_FONT_RELATIVE_PATH}`;

let cachedBytes: Uint8Array | null = null;
let inflight: Promise<Uint8Array> | null = null;

export async function loadUnicodeFontBytes(): Promise<Uint8Array> {
  if (cachedBytes) return cachedBytes;
  inflight ??= (async () => {
    const bytes = typeof window === 'undefined'
      ? await loadFromFilesystem()
      : await loadFromNetwork();
    cachedBytes = bytes;
    return bytes;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function loadFromNetwork(): Promise<Uint8Array> {
  const res = await fetch(UNICODE_FONT_PUBLIC_PATH);
  if (!res.ok) {
    throw new Error(`Failed to load PDF font (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function loadFromFilesystem(): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // process.cwd() is the project root in dev and the standalone dir in the
  // packaged desktop app — build-tauri-web.mjs copies public/ into both the
  // standalone root and standalone/server (belt and suspenders).
  try {
    const buffer = await readFile(join(process.cwd(), 'public', UNICODE_FONT_RELATIVE_PATH));
    return new Uint8Array(buffer);
  } catch (publicDirError) {
    try {
      const buffer = await readFile(join(process.cwd(), UNICODE_FONT_RELATIVE_PATH));
      return new Uint8Array(buffer);
    } catch (standaloneRootError) {
      throw new Error(
        `Failed to load PDF font from disk: ${String(standaloneRootError || publicDirError)}`,
      );
    }
  }
}
