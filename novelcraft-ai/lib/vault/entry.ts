// Wave 2 commit B — entry assembly + (re)hydration between vault `.md` files
// and the in-memory `VaultEntry` shape.
//
// This module is the seam between "what the user sees in Obsidian" and "what
// the rest of the app calls a KnowledgeEntry". On write we produce a tidy YAML
// frontmatter + body that survives a round-trip through Obsidian unchanged.
// On read we tolerate sloppy human edits (missing fields, swapped key order,
// stray whitespace) and emit warnings rather than throwing.

import { parseFrontmatter, serializeFrontmatter } from '@/lib/vault/frontmatter';
import { collectOutgoingLinks } from '@/lib/vault/outgoing-links';
import type {
  KnowledgeType,
  OutgoingLink,
  ParsedEntryFile,
  VaultFrontmatter,
  KnowledgeEntryProjection,
} from '@/lib/vault/types';

export interface VaultEntry {
  id: string;
  novelId: string;
  type: KnowledgeType;
  path: string; // POSIX relative to vault root, e.g. characters/lin-shen.md
  frontmatter: VaultFrontmatter;
  body: string;
}

/** Type → vault subdirectory. Single source of truth for entry directories. */
const TYPE_DIRS: Record<KnowledgeType, string> = {
  character: 'characters',
  world: 'worlds',
  timeline: 'timeline',
  outline: 'outline',
  style_reference: 'styles',
};

/**
 * The set of vault subdirectories that hold knowledge entries, derived from
 * {@link TYPE_DIRS}. Reconcilers (live / snapshot / server-sync) must use this
 * instead of re-listing the dirs so adding a 6th entry type only touches
 * `TYPE_DIRS`. Mirrors Rust `VAULT_ENTRY_DIRS`.
 */
export const VAULT_ENTRY_DIRS: ReadonlySet<string> = new Set(Object.values(TYPE_DIRS));

/** Resolve the vault subdirectory for a knowledge type. Single source shared by
 *  path assignment and the SQLite→vault migration (was duplicated as a switch). */
function vaultDirFor(type: KnowledgeType): string {
  return TYPE_DIRS[type] ?? 'misc';
}

export function vaultTypeForDir(dir: string): KnowledgeType | null {
  for (const [type, entryDir] of Object.entries(TYPE_DIRS)) {
    if (entryDir === dir) return type as KnowledgeType;
  }
  return null;
}

export function vaultTypeForPath(path: string): KnowledgeType | null {
  return vaultTypeForDir(path.split('/')[0] ?? '');
}

/**
 * Max files processed per reconcile batch (live + snapshot reconcilers). Bounds
 * the IPC fan-out / memory when a large vault changes at once.
 */
export const VAULT_RECONCILE_BATCH = 64;

/**
 * True when `path` is a valid 2-segment entry path: `{entryDir}/{name}.md`,
 * POSIX-only (no backslashes), exactly one nesting level deep. This is the
 * shared "should this file map to a knowledge entry?" predicate the reconcilers
 * use; it is *not* a security boundary (Rust `vault.rs` is — see KV-11).
 */
export function isVaultEntryPath(path: string): boolean {
  if (!path.endsWith('.md') || path.includes('\\')) return false;
  const parts = path.split('/');
  if (parts.length !== 2) return false;
  const [dir, name] = parts;
  return VAULT_ENTRY_DIRS.has(dir) && Boolean(name);
}

export function vaultPathFor(type: KnowledgeType, filename: string): string {
  return `${vaultDirFor(type)}/${filename}`;
}

/** Serialize a `VaultEntry` to its on-disk markdown form. */
export function renderEntryToMarkdown(entry: VaultEntry): string {
  // Ensure the frontmatter "core" fields are always present + in a stable
  // order so a round-trip is byte-identical when nothing changes.
  const rest = stripCore(entry.frontmatter);
  const ordered: Record<string, unknown> = {
    id: entry.frontmatter.id ?? entry.id,
    type: entry.frontmatter.type ?? entry.type,
    title: entry.frontmatter.title ?? '',
    ...rest,
  };
  // Drop noisy `undefined` values so the YAML serializer doesn't emit `null`s
  // the user has to wonder about.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ordered)) {
    if (v === undefined) continue;
    cleaned[k] = v;
  }
  // Make sure the body ends with a newline so Obsidian-style editors don't
  // complain about a "missing final newline".
  const body = entry.body.endsWith('\n') ? entry.body : entry.body + '\n';
  return serializeFrontmatter(cleaned as unknown as VaultFrontmatter, body);
}

function stripCore(fm: VaultFrontmatter): Record<string, unknown> {
  const flat = { ...(fm as unknown as Record<string, unknown>) };
  delete flat.id;
  delete flat.type;
  delete flat.title;
  return flat;
}

function isTimelineEventImportance(value: unknown): boolean {
  return value === 'major' || value === 'minor';
}

/** Hydrate a markdown file into a `VaultEntry`. Lenient about missing fields. */
export function parseMarkdownToEntry(
  novelId: string,
  path: string,
  raw: string,
): { entry: VaultEntry; warnings: string[] } {
  const parsed: ParsedEntryFile = parseFrontmatter(raw);
  const fm = parsed.frontmatter;
  // Stable-but-derived `id` fallback (`path:…`) for hand-written files without an
  // `id:`, reproducible so the index doesn't churn on every walk.
  const entry: VaultEntry = {
    id: typeof fm.id === 'string' && fm.id ? fm.id : `path:${path}`,
    novelId,
    type: (fm.type as KnowledgeType) ?? vaultTypeForPath(path) ?? 'character',
    path,
    frontmatter: fm,
    body: parsed.body,
  };
  return { entry, warnings: parsed.warnings };
}

/** Extract wikilinks and structured relation targets for the index mirror. */
export function outgoingLinksFor(entry: VaultEntry): OutgoingLink[] {
  return collectOutgoingLinks({
    fields: entry.frontmatter as unknown as Record<string, unknown>,
    text: entry.body,
  });
}

// --- Projection back to the legacy `KnowledgeEntry` shape ------------------
//
// Existing code (KnowledgePanel, buildSummaryInjection, route handlers) reads
// `KnowledgeEntry` with `{ data, summary, sortOrder, tags, ... }`. The vault
// stores the same fields scattered across frontmatter + body. We project both
// directions through this single helper so the rest of the codebase doesn't
// need to learn about frontmatter.

export function projectEntryForLegacy(
  entry: VaultEntry,
  opts?: { summary?: string; sortOrder?: number },
): KnowledgeEntryProjection {
  const fm = entry.frontmatter;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'importance') {
      if (entry.type === 'timeline' && isTimelineEventImportance(v)) {
        data[k] = v;
      }
      continue;
    }
    if (k === 'id' || k === 'type' || k === 'title' || k === 'tags' || k === 'aliases' || k === 'createdAt' || k === 'updatedAt') {
      continue;
    }
    data[k] = v;
  }
  const summary = opts?.summary ?? extractSummary(entry.body, 240);
  const createdAt = parseTimestamp(fm.createdAt);
  const updatedAt = parseTimestamp(fm.updatedAt) ?? Date.now();
  return {
    id: entry.id,
    novelId: entry.novelId,
    type: entry.type,
    title: typeof fm.title === 'string' ? fm.title : '',
    summary,
    data,
    sortOrder: opts?.sortOrder ?? 0,
    tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
    createdAt: createdAt ?? updatedAt,
    updatedAt,
  };
}

function extractSummary(body: string, maxChars: number): string {
  // Strip wikilink brackets, headings, code fences. We want a one-liner.
  const flattened = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/\[\[([^\]\n[]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= maxChars) return flattened;
  return flattened.slice(0, maxChars - 1) + '…';
}

function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw) return null;
  const n = Date.parse(raw);
  return Number.isFinite(n) ? n : null;
}
