/**
 * Single source of truth for export filename normalisation. Three call sites
 * used to ship slightly different rules — keep them aligned here so a tweak
 * never has to be made in three places.
 */

const SAFE_CHARS = /[^\p{L}\p{N} _-]/gu;
const HEADER_UNSAFE = /[^A-Za-z0-9 ._-]/g;
const FILESYSTEM_UNSAFE = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;
const MAX_FILENAME_BASE_LENGTH = 120;
const MAX_HEADER_FILENAME_LENGTH = 180;

/**
 * Drop filesystem-unsafe characters, collapse whitespace runs, and remove
 * pure-dot segments (".", ".."). Length capping and fallback are the caller's
 * job. Shared core for `sanitizeFilenameSegment` and the download/save path
 * (`lib/download.ts`) so the unsafe-character rule never diverges.
 */
export function normalizeFilenameWhitespace(value: string): string {
  return value
    .replace(FILESYSTEM_UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((part) => part && !/^\.+$/.test(part))
    .join(' ');
}

export function sanitizeFilenameSegment(
  value: string | null | undefined,
  fallback = 'file',
  maxLength = MAX_FILENAME_BASE_LENGTH
): string {
  const safe = normalizeFilenameWhitespace(value || '')
    .slice(0, maxLength)
    .trim();

  return safe || fallback;
}

export function exportFilenameBase(title: string | null | undefined): string {
  const safe = sanitizeFilenameSegment(title, 'novel')
    .replace(SAFE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FILENAME_BASE_LENGTH)
    .trim();
  return safe || 'novel';
}

function asciiOnlyName(value: string): string {
  // Re-run the segment sanitiser: slicing in `sanitizeFilenameSegment` can cut a
  // token mid-way and expose a trailing pure-dot fragment (e.g. "name ...") that
  // only a second normalisation pass strips. The previous implementation relied
  // on this double pass, so keep it to preserve the exact header output.
  const safe = sanitizeFilenameSegment(value, 'download', MAX_HEADER_FILENAME_LENGTH);
  const ascii = safe
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(HEADER_UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!ascii || ascii.startsWith('.')) {
    const extension = safe.match(/(\.[A-Za-z0-9]{1,12})$/)?.[1] ?? '';
    return `download${extension}`;
  }

  return ascii;
}

function encodeRFC5987(input: string): string {
  return encodeURIComponent(input).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build a `Content-Disposition: attachment` header value that supports both
 * legacy ASCII and UTF-8 filenames. `filename` is the desired display name
 * (CJK allowed); it is treated as untrusted because novel and chapter titles
 * can be user-controlled.
 */
export function exportFilenameForHeader(filename: string): string {
  const safe = sanitizeFilenameSegment(filename, 'download', MAX_HEADER_FILENAME_LENGTH);
  const ascii = asciiOnlyName(safe);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(safe)}`;
}

export function exportAttachmentHeaders(filename: string, contentType: string): HeadersInit {
  return {
    'Content-Type': contentType,
    'Content-Disposition': exportFilenameForHeader(filename),
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'X-Content-Type-Options': 'nosniff',
  };
}
