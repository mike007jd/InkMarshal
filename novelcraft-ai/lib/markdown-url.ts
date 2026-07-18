const MAX_MARKDOWN_HREF_LENGTH = 2048;
const SAFE_ABSOLUTE_PROTOCOLS = new Set(['http:', 'https:']);
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export function sanitizeMarkdownHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;

  const value = href.trim();
  if (!value || value.length > MAX_MARKDOWN_HREF_LENGTH) return null;
  if (CONTROL_CHAR_RE.test(value)) return null;
  if (value.startsWith('//') || value.startsWith('\\\\')) return null;

  const schemeMatch = value.match(SCHEME_RE);
  if (!schemeMatch) return value;

  const protocol = schemeMatch[0].toLowerCase();
  return SAFE_ABSOLUTE_PROTOCOLS.has(protocol) ? value : null;
}
