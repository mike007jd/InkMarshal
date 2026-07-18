// Wave 2 commit C — structured markdown renderers for AI prompt injection.
//
// Replaces the legacy `buildKnowledgeEntrySummary` "smash everything into one
// 500-char line" approach. The new shape gives the model a tidy, scannable
// bullet list per entry so it can pick out a character's motivation without
// running into a wall of `description; backstory; traits...` semicolons.
//
// All functions take a `VaultIndexRow` (the SQLite projection of the on-disk
// `.md` file) so we don't need to round-trip through the filesystem for the
// hot recall path. When the body of an entry is needed (summary fallback),
// the recall caller already has it and passes it in via `bodyExcerpt`.

import type { VaultIndexRow, RelationFrontmatter } from '@/lib/vault/types';
import type { Locale } from '@/lib/i18n';
import { isZhLocale } from '@/lib/i18n';

const CHAR_LABELS = {
  zh: {
    section: '角色',
    role: '角色定位',
    traits: '性格',
    motivation: '动机',
    arc: '弧光',
    relations: '关系',
    summary: '摘要',
    description: '简介',
    backstory: '背景',
  },
  en: {
    section: 'Character',
    role: 'Role',
    traits: 'Traits',
    motivation: 'Motivation',
    arc: 'Arc',
    relations: 'Relations',
    summary: 'Summary',
    description: 'Description',
    backstory: 'Backstory',
  },
} as const;

const WORLD_LABELS = {
  zh: { section: '世界设定', category: '类别', details: '细节', description: '简介' },
  en: { section: 'World', category: 'Category', details: 'Details', description: 'Description' },
} as const;

const TIMELINE_LABELS = {
  zh: { section: '时间线事件', date: '日期', type: '类型', description: '事件' },
  en: { section: 'Timeline event', date: 'Date', type: 'Type', description: 'Description' },
} as const;

const OUTLINE_LABELS = {
  zh: { section: '章节大纲', chapter: '第', synopsis: '梗概', keyEvents: '关键事件', pov: '视角', characters: '出场角色' },
  en: { section: 'Outline', chapter: 'Chapter', synopsis: 'Synopsis', keyEvents: 'Key events', pov: 'POV', characters: 'Characters' },
} as const;

function labels<L extends { zh: unknown; en: unknown }>(table: L, locale: Locale): L['zh'] | L['en'] {
  return isZhLocale(locale) ? table.zh : table.en;
}

function trim(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function trimList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => trim(v)).filter(Boolean);
}

function joinComma(parts: string[], locale: Locale): string {
  const sep = isZhLocale(locale) ? '、' : ', ';
  return parts.join(sep);
}

/** Render a single character entry's prompt block. */
export function renderCharacterBlock(
  entry: VaultIndexRow,
  opts?: { locale?: Locale; bodyExcerpt?: string; hop1?: VaultIndexRow[] },
): string {
  const locale = opts?.locale ?? 'en';
  const l = labels(CHAR_LABELS, locale);
  const fm = entry.data;
  const lines: string[] = [];
  const title = entry.title;
  const role = trim(fm.role);
  const heading = role
    ? `### ${l.section}: ${title} (${role})`
    : `### ${l.section}: ${title}`;
  lines.push(heading);

  const traits = trimList(fm.traits);
  if (traits.length > 0) lines.push(`- ${l.traits}: ${joinComma(traits, locale)}`);
  const motivation = trim(fm.motivation);
  if (motivation) lines.push(`- ${l.motivation}: ${motivation}`);
  const arc = trim(fm.arc);
  if (arc) lines.push(`- ${l.arc}: ${arc}`);

  const relations = renderRelationsLine(fm.relations, opts?.hop1, locale);
  if (relations) lines.push(`- ${l.relations}: ${relations}`);

  // Summary fallback chain: frontmatter description / backstory tail / body excerpt
  const description = trim(fm.description);
  const backstory = trim(fm.backstory);
  const summary = description || (opts?.bodyExcerpt ? trim(opts.bodyExcerpt) : '') || backstory;
  if (summary) {
    lines.push(`- ${l.summary}: ${trimToLength(summary, 320)}`);
  }

  return lines.join('\n');
}

/** Render a group of world entries sharing the same `data.category`. */
export function renderWorldGroup(
  category: string,
  entries: VaultIndexRow[],
  opts?: { locale?: Locale },
): string {
  if (entries.length === 0) return '';
  const locale = opts?.locale ?? 'en';
  const l = labels(WORLD_LABELS, locale);
  const head = category
    ? `### ${l.section} — ${l.category}: ${category}`
    : `### ${l.section}`;
  const lines: string[] = [head];
  for (const entry of entries) {
    const main = trim(entry.data.description);
    const details = renderDetails(entry.data.details, locale);
    const detailLine = details ? ` (${details})` : '';
    lines.push(`- **${entry.title}**: ${trimToLength(main, 220)}${detailLine}`);
  }
  return lines.join('\n');
}

/** Render a single timeline entry. */
export function renderTimelineBlock(entry: VaultIndexRow, opts?: { locale?: Locale }): string {
  const locale = opts?.locale ?? 'en';
  const l = labels(TIMELINE_LABELS, locale);
  const date = trim(entry.data.date);
  const eventType = trim(entry.data.eventType);
  const description = trim(entry.data.description);
  const parts: string[] = [];
  parts.push(`### ${l.section}: ${entry.title}`);
  if (date) parts.push(`- ${l.date}: ${date}`);
  if (eventType) parts.push(`- ${l.type}: ${eventType}`);
  if (description) parts.push(`- ${l.description}: ${trimToLength(description, 280)}`);
  return parts.join('\n');
}

/** Render an outline-neighbor entry (e.g. prior chapter outline for continuity). */
export function renderOutlineNeighbor(entry: VaultIndexRow, opts?: { locale?: Locale }): string {
  const locale = opts?.locale ?? 'en';
  const l = labels(OUTLINE_LABELS, locale);
  const n = typeof entry.data.chapterNumber === 'number' ? entry.data.chapterNumber : null;
  const head = n != null
    ? `### ${l.section} — ${l.chapter} ${n}: ${entry.title}`
    : `### ${l.section}: ${entry.title}`;
  const lines: string[] = [head];
  const synopsis = trim(entry.data.synopsis);
  if (synopsis) lines.push(`- ${l.synopsis}: ${trimToLength(synopsis, 320)}`);
  const keyEvents = trimList(entry.data.keyEvents);
  if (keyEvents.length > 0) lines.push(`- ${l.keyEvents}: ${joinComma(keyEvents, locale)}`);
  const pov = trim(entry.data.pov);
  if (pov) lines.push(`- ${l.pov}: ${pov}`);
  const chars = trimList(entry.data.characters);
  if (chars.length > 0) lines.push(`- ${l.characters}: ${joinComma(chars, locale)}`);
  return lines.join('\n');
}

// ── helpers ──────────────────────────────────────────────────────────────

function renderRelationsLine(
  raw: unknown,
  hop1: VaultIndexRow[] | undefined,
  locale: Locale,
): string {
  const fromFm: RelationFrontmatter[] = Array.isArray(raw)
    ? (raw as RelationFrontmatter[]).filter(r => r && typeof r.target === 'string')
    : [];
  const pieces: string[] = [];
  const seen = new Set<string>();
  for (const r of fromFm) {
    const key = `${r.target}|${r.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = r.label && r.label.trim()
      ? `${r.type} — ${r.label.trim()}`
      : r.type;
    pieces.push(`${r.target} (${tag})`);
  }
  if (hop1) {
    for (const e of hop1) {
      const key = `${e.title}|wikilink`;
      if (seen.has(key)) continue;
      seen.add(key);
      pieces.push(isZhLocale(locale) ? `${e.title}（正文链接）` : `${e.title} (wikilink)`);
    }
  }
  return pieces.join(isZhLocale(locale) ? '；' : '; ');
}

function renderDetails(raw: unknown, locale: Locale): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const sep = isZhLocale(locale) ? '；' : '; ';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = trim(value);
    if (!v) continue;
    parts.push(`${key}: ${v}`);
  }
  return parts.join(sep);
}

function trimToLength(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
