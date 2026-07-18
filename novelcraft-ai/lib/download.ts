import { isTauriRuntime } from '@/lib/desktop-runtime';
import { normalizeFilenameWhitespace } from '@/lib/exporters/filename';

export function parseDownloadFilename(
  contentDisposition: string | null,
  fallbackFilename: string,
) {
  const fallback = sanitizeDownloadFilename(fallbackFilename, 'download');
  if (!contentDisposition) {
    return fallback;
  }

  const encodedFilenameMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedFilenameMatch?.[1]) {
    try {
      return sanitizeDownloadFilename(decodeURIComponent(encodedFilenameMatch[1]), fallback);
    } catch {
      return fallback;
    }
  }

  const filenameMatch = contentDisposition.match(/filename="([^"]+)"/i);
  if (filenameMatch?.[1]) {
    return sanitizeDownloadFilename(filenameMatch[1], fallback);
  }

  return fallback;
}

export function sanitizeDownloadFilename(
  filename: string | null | undefined,
  fallbackFilename = 'download',
): string {
  // Shared with the export path (sanitizeFilenameSegment) so the
  // unsafe-character + whitespace rule never diverges. FILESYSTEM_UNSAFE's
  // control-char range already covers \\r\\n\\t\\f\\v, so this is behaviour-neutral.
  // Cap length on the stem only, not the file extension — otherwise a long
  // Chinese title turns `Title-of-the-Manuscript.zip` into
  // `Title-of-the-Manus`, eating the `.zip` and breaking double-click
  // associations on most OSes.
  const MAX_LEN = 180;
  const splitExt = (name: string): [string, string] => {
    const dot = name.lastIndexOf('.');
    if (dot <= 0 || dot >= name.length - 1) return [name, ''];
    const ext = name.slice(dot);
    // Cap the extension to a sane length so a stray middle dot
    // ("Project.v2.notes") doesn't treat ".v2.notes" as the extension.
    if (ext.length > 12) return [name, ''];
    return [name.slice(0, dot), ext];
  };
  const fallback = normalizeFilenameWhitespace(fallbackFilename || 'download');
  const normalized = normalizeFilenameWhitespace(filename || '');
  const [stem, ext] = splitExt(normalized);
  const maxStem = Math.max(1, MAX_LEN - ext.length);
  // Slice the stem to the available budget but DON'T trim its tail — the
  // normalize step above preserves intentional spaces (e.g. when an unsafe
  // segment like `..` was filtered out, the surrounding gap stays as a
  // single space). Trimming the slice would silently lose that signal.
  const safe = (stem.slice(0, maxStem) + ext);
  return safe || fallback || 'download';
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = downloadUrl;
  link.download = sanitizeDownloadFilename(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // BI-13: a 0ms revoke can race the download the synthetic click() kicks off
  // on slower webviews and cancel it. Delay the revoke so the fetch completes.
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

/** Base64-encode a blob's bytes for IPC transfer to the Rust save command. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunked btoa avoids "Maximum call stack size exceeded" on large exports.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * E2: deliver an export to the user. The `<a download>` + blob trick is
 * unreliable in the Tauri/wry webview (wry #349), so under Tauri we route
 * through the native save dialog via the `save_export_file` Rust command;
 * elsewhere we fall back to the browser anchor download.
 *
 * Returns the saved path on desktop (or `null` if the user cancelled the
 * dialog); resolves to `undefined` on the browser fallback path.
 */
export async function saveBlob(
  blob: Blob,
  filename: string,
): Promise<string | null | undefined> {
  const defaultFileName = sanitizeDownloadFilename(filename);

  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const contentsBase64 = await blobToBase64(blob);
    return invoke<string | null>('save_export_file', {
      defaultFileName,
      contentsBase64,
    });
  }

  triggerBrowserDownload(blob, defaultFileName);
  return undefined;
}
