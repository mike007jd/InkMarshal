import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { Locale } from '@/lib/i18n';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Keyboard focus ring for bare interactive elements (standalone `<Link>`s,
 * logos, nav items) that don't go through the `Button` component. Mirrors the
 * Button's focus-visible treatment (`ring-ring` = book gold) so keyboard users
 * get a consistent, visible focus indicator. Links already wrapped in
 * `Button asChild` inherit the ring and must NOT add this.
 *
 * No `rounded-*` is baked in: the ring (a box-shadow) follows the element's own
 * border radius, so a `rounded-lg` button gets a `rounded-lg` ring without the
 * constant fighting the call site's radius class.
 */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/** Unified CJK character regex: CJK Unified Ideographs, Extension A, Compatibility Ideographs. */
const CJK_CHAR_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const CJK_CHAR_REGEX_G = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

/** Count words with CJK support: each CJK character counts as one word. */
export function countWords(text: string): number {
  const cjk = text.match(CJK_CHAR_REGEX_G)?.length ?? 0;
  const words = text.replace(CJK_CHAR_REGEX_G, ' ').split(/\s+/).filter(Boolean).length;
  return cjk + words;
}

/** Detect language from message content (checks for CJK characters) */
export function detectLanguage(contents: string[]): Locale {
  return contents.some(c => CJK_CHAR_REGEX.test(c)) ? 'zh-CN' : 'en';
}

export { estimateTokens } from '@/lib/token-budget';

/** Returns a shallow copy of `obj` with `key` removed. */
export function omitKey<T extends object>(obj: T, key: string): T {
  const clone = { ...obj } as Record<string, unknown>;
  delete clone[key];
  return clone as T;
}

/** Map DB messages to ChatMessage history for AI calls.
 *  Keeps only the most recent messages to avoid exceeding context window limits.
 *  Roughly targets ~60k characters (~15k tokens) to leave room for system prompts. */
const MAX_HISTORY_CHARS = 60_000;

export function toChatHistory(messages: { role: string; content: string }[]) {
  const mapped = messages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }));

  // Trim from the front if total content exceeds limit
  let totalChars = mapped.reduce((sum, m) => sum + m.content.length, 0);
  let start = 0;
  while (totalChars > MAX_HISTORY_CHARS && start < mapped.length - 2) {
    totalChars -= mapped[start].content.length;
    start++;
  }

  return start > 0 ? mapped.slice(start) : mapped;
}

const DEFAULT_JSON_BODY_MAX_BYTES = 1_000_000;

class RequestBodyTooLargeError extends Error {}

async function readRequestTextWithLimit(request: Request, maxBytes: number): Promise<string> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError();
  }

  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Safely parse JSON from a Request, returning either data or an error Response. */
export async function safeParseJson<T = unknown>(
  request: Request,
  options: { maxBytes?: number } = {},
): Promise<{ data: T; error: null } | { data: null; error: Response }> {
  try {
    const text = await readRequestTextWithLimit(request, options.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES);
    return { data: JSON.parse(text) as T, error: null };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { data: null, error: Response.json({ error: 'JSON body too large' }, { status: 413 }) };
    }
    return { data: null, error: Response.json({ error: 'Invalid JSON' }, { status: 400 }) };
  }
}

export async function safeParseJsonObject<T extends object = Record<string, unknown>>(
  request: Request,
  options: { maxBytes?: number; errorMessage?: string } = {},
): Promise<{ data: T; error: null } | { data: null; error: Response }> {
  const parsed = await safeParseJson<unknown>(request, options);
  if (parsed.error) return parsed;
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return {
      data: null,
      error: Response.json(
        { error: options.errorMessage ?? 'JSON body must be an object' },
        { status: 400 },
      ),
    };
  }
  return { data: parsed.data as T, error: null };
}

/** Format a relative time string (e.g. "3 minutes ago") with i18n support. */
export function formatRelativeTime(date: Date | number | string, t: Record<string, string>): string {
  const now = Date.now();
  const then = typeof date === 'number' ? date : new Date(date).getTime();
  const diff = Math.max(0, now - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t.timeJustNow;
  if (mins < 60) return t.timeMinutesAgo.replace('{n}', String(mins));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t.timeHoursAgo.replace('{n}', String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return t.timeDaysAgo.replace('{n}', String(days));
  return new Date(then).toLocaleDateString();
}

export function sanitizeError(err: unknown, fallback = 'An unexpected error occurred'): string {
  return err instanceof Error ? err.message : fallback;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate that a string is a UUID (v1-v5 hex form). */
export function isUuid(val: unknown): val is string {
  return typeof val === 'string' && UUID_REGEX.test(val);
}

/** Coerce a `string | number | Date` timestamp to ms since epoch. */
export function parseTimestamp(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'string') return new Date(raw).getTime();
  return 0;
}

/** ISO timestamp shorthand for DB `created_at` / `updated_at` writes. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parse a JSON-ish DB column that may already be an object, with a fallback.
 *
 * Pass `isValid` to also reject parsed values of the wrong shape (e.g. a `data`
 * column that parsed to an array when an object was expected) — the fallback is
 * returned for both unparseable strings and shape mismatches. Without it, any
 * successfully-parsed value is returned as-is.
 */
export function parseJsonField<T>(
  value: unknown,
  fallback: T,
  isValid?: (parsed: unknown) => boolean,
): T {
  const accept = (parsed: unknown): T => (isValid && !isValid(parsed) ? fallback : (parsed as T));
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return accept(JSON.parse(value));
    } catch {
      return fallback;
    }
  }
  return accept(value);
}
