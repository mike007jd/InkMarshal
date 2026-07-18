// Wave 2 commit B — minimal YAML frontmatter parser + serializer.
//
// Why hand-rolled instead of pulling `gray-matter` + `js-yaml`?
//   1. Our frontmatter shape is tightly constrained (string keys, scalar +
//      string-array + small inline object/list values). A full YAML parser is
//      overkill and adds 100kb to the bundle.
//   2. The user can edit vault `.md` in Obsidian; we want behavior that
//      precisely matches what Obsidian writes, which is a strict subset of
//      YAML. Generic parsers introduce edge cases (anchors, refs, dates) we
//      don't want.
//   3. No external dep == no Node/browser compatibility footgun.
//
// Grammar we support:
//   document   := '---\n' lines '---\n' body
//   line       := key ':' value      | key ':\n' (list_item | object_item)*
//   value      := scalar             | inline_list   | inline_object
//   scalar     := single-line string (number/bool/null auto-detected)
//   list_item  := '  - ' scalar
//   object_item:= '  ' key ':' scalar
//   inline_list   := '[a, b, "c d"]'
//   inline_object := '{a: 1, b: "x"}'  (used for `relations:` shorthand only)
//
// NOT supported (deliberately — these are emitted into `warnings`, never
// silently coerced): multi-line / folded scalars (`>` / `|`), nested maps
// deeper than one level, quoted keys, anchors / refs / tags, dates.
//
// Special case: a bare wikilink scalar (`target: [[Lin Shen]]`) is invalid YAML
// — Obsidian itself requires it quoted (`"[[Lin Shen]]"`). We recognise the
// bare form, return it as the string it clearly is (not an inline list), and
// push a warning so callers can prompt the user to quote it.
//
// Anything weirder is emitted into the `warnings` array so the caller can
// surface it without dropping the file silently.

import type { ParsedEntryFile, VaultFrontmatter } from '@/lib/vault/types';

const FRONTMATTER_DELIM = '---';
const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
// A scalar value that is a single bare Obsidian wikilink: `[[Target]]` or
// `[[Target|alias]]`. The inner text may not contain `[` or `]` so we don't
// confuse a genuine inline list (`[a, b]`) for a wikilink.
const BARE_WIKILINK_REGEX = /^\[\[[^[\]]+\]\]$/;

export function parseFrontmatter(raw: string): ParsedEntryFile {
  const warnings: string[] = [];
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return {
      frontmatter: {} as VaultFrontmatter,
      body: raw,
      warnings: ['No YAML frontmatter found'],
    };
  }
  const yamlBlock = match[1];
  const body = raw.slice(match[0].length);
  const fm = parseYamlBlock(yamlBlock, warnings);
  return { frontmatter: fm as unknown as VaultFrontmatter, body, warnings };
}

export function serializeFrontmatter(fm: VaultFrontmatter, body: string): string {
  const lines: string[] = [FRONTMATTER_DELIM];
  for (const [key, value] of Object.entries(fm as unknown as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    appendYamlEntry(lines, key, value);
  }
  lines.push(FRONTMATTER_DELIM);
  // Always end with a single newline after the closing delim. Body is appended
  // verbatim (caller manages its own trailing newline).
  return lines.join('\n') + '\n' + body;
}

// --- YAML scalar parsing (tiny subset) -------------------------------------

function parseYamlBlock(block: string, warnings: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    // Top-level key must start at column 0.
    if (/^\s/.test(line)) {
      warnings.push(`Unexpected indented line at YAML top level: "${line}"`);
      i++;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      warnings.push(`No colon found in YAML line: "${line}"`);
      i++;
      continue;
    }
    const key = line.slice(0, colon).trim();
    if (isUnsafeObjectKey(key)) {
      warnings.push(`Unsafe YAML key skipped: "${key}"`);
      i++;
      continue;
    }
    const rest = line.slice(colon + 1).trim();
    if (rest.length === 0) {
      // Multi-line block — either an indented list or an indented map.
      const { value, consumed } = consumeBlock(lines, i + 1, warnings);
      out[key] = value;
      i = i + 1 + consumed;
      continue;
    }
    out[key] = parseScalar(rest, warnings);
    i++;
  }
  return out;
}

function consumeBlock(
  lines: string[],
  start: number,
  warnings: string[],
): { value: unknown; consumed: number } {
  let i = start;
  const list: unknown[] = [];
  const obj: Record<string, unknown> = Object.create(null);
  let mode: 'list' | 'object' | null = null;

  while (i < lines.length) {
    const line = lines[i];
    if (line === '' || /^[^\s]/.test(line)) {
      // Either blank or dedent → block ended.
      break;
    }
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.startsWith('- ')) {
      if (mode === 'object') {
        warnings.push(`Mixed list/map in YAML block; stopping at "${line}"`);
        break;
      }
      mode = 'list';
      const valuePart = trimmed.slice(2).trim();
      if (valuePart.startsWith('{')) {
        list.push(parseInlineObject(valuePart, warnings));
      } else {
        list.push(parseScalar(valuePart, warnings));
      }
      i++;
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon >= 0) {
      if (mode === 'list') {
        warnings.push(`Mixed list/map in YAML block; stopping at "${line}"`);
        break;
      }
      mode = 'object';
      const k = trimmed.slice(0, colon).trim();
      if (isUnsafeObjectKey(k)) {
        warnings.push(`Unsafe YAML block key skipped: "${k}"`);
        i++;
        continue;
      }
      const v = trimmed.slice(colon + 1).trim();
      obj[k] = parseScalar(v, warnings);
      i++;
      continue;
    }
    warnings.push(`Unrecognised YAML block line: "${line}"`);
    i++;
  }
  return {
    value: mode === 'list' ? list : obj,
    consumed: i - start,
  };
}

function parseScalar(raw: string, warnings: string[]): unknown {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Bare wikilink scalar — `target: [[Lin Shen]]`. This is technically invalid
  // YAML (Obsidian itself warns it breaks parsing and must be quoted as
  // `"[[Lin Shen]]"`), and a naive parser mis-reads it as an inline list
  // `["[Lin Shen]"]`, silently mangling a human-authored relation. Treat it as
  // the wikilink string it obviously is, and warn so the caller can nudge the
  // user to quote it.
  if (BARE_WIKILINK_REGEX.test(v)) {
    warnings.push(
      `Bare wikilink in frontmatter should be quoted ("${v}"): "${v}"`,
    );
    return v;
  }
  // Inline list
  if (v.startsWith('[') && v.endsWith(']')) {
    return parseInlineList(v, warnings);
  }
  // Inline object — only used by `relations:` shorthand.
  if (v.startsWith('{') && v.endsWith('}')) {
    return parseInlineObject(v, warnings);
  }
  // Quoted string
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return unquote(v);
  }
  // Number?
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    return Number(v);
  }
  // Bare string
  return v;
}

function parseInlineList(raw: string, warnings: string[]): unknown[] {
  // Strip outer brackets.
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  const tokens = splitTopLevel(inner, ',');
  return tokens.map(t => parseScalar(t, warnings));
}

function parseInlineObject(raw: string, warnings: string[]): Record<string, unknown> {
  // {key: value, key2: "val"}
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return {};
  const out: Record<string, unknown> = Object.create(null);
  for (const pair of splitTopLevel(inner, ',')) {
    const colon = pair.indexOf(':');
    if (colon < 0) {
      warnings.push(`No colon in inline object pair: "${pair}"`);
      continue;
    }
    const k = pair.slice(0, colon).trim();
    if (isUnsafeObjectKey(k)) {
      warnings.push(`Unsafe inline object key skipped: "${k}"`);
      continue;
    }
    const v = pair.slice(colon + 1).trim();
    out[k] = parseScalar(v, warnings);
  }
  return out;
}

function isUnsafeObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

function unquote(s: string): string {
  const quote = s[0];
  const inner = s.slice(1, -1);
  // YAML 1.2 §7.3.3: inside single-quoted strings, a single quote is escaped
  // by doubling it (`''`). Backslash is literal. This is the standard
  // Obsidian alias spelling — e.g. `aliases: ['don''t worry']` becomes
  // ["don't worry"].
  if (quote === "'") {
    return inner.replace(/''/g, "'");
  }
  // Double-quoted strings allow backslash escapes — minimally `\\`, `\"`,
  // `\n` (preserve the rest verbatim).
  return inner.replace(/\\(.)/g, (_m, c) => (c === 'n' ? '\n' : c));
}

/** Split on `sep` but respect quotes + bracket nesting. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = '';
  for (const ch of s) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '[' || ch === '{') {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === ']' || ch === '}') {
      depth--;
      buf += ch;
      continue;
    }
    if (depth === 0 && ch === sep) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(buf.trim());
  return out;
}

// --- Serialization ---------------------------------------------------------

function appendYamlEntry(out: string[], key: string, value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${key}: []`);
      return;
    }
    // If every item is a plain scalar (string/number/bool), prefer inline list
    // because it round-trips through Obsidian unchanged.
    if (value.every(v => isScalar(v))) {
      out.push(`${key}: ${formatInlineList(value)}`);
      return;
    }
    out.push(`${key}:`);
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        out.push(`  - ${formatInlineObject(item as Record<string, unknown>)}`);
      } else {
        out.push(`  - ${formatScalar(item)}`);
      }
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    out.push(`${key}:`);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(`  ${k}: ${formatScalar(v)}`);
    }
    return;
  }
  out.push(`${key}: ${formatScalar(value)}`);
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  // Strings: quote if they contain special chars; otherwise emit bare.
  const s = String(v);
  if (s === '') return '""';
  if (/[:#\[\]{}",'\n]/.test(s) || /^[\s]/.test(s) || /[\s]$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function formatInlineList(items: unknown[]): string {
  return `[${items.map(formatScalar).join(', ')}]`;
}

function formatInlineObject(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => `${k}: ${formatScalar(v)}`);
  return `{${parts.join(', ')}}`;
}
