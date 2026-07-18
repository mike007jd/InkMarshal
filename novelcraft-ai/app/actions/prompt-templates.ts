'use server';

// Server actions for the workflow & template editor (W3-2).
//
// All custom prompts live in the existing `prompt_templates` table (zero DDL):
//   - a custom template is a new row under an author-chosen `variant`
//   - a new version is `version + 1` for the same (stage, role, locale, variant)
//   - a rollback flips `active` to an older version (no physical delete)
// Every active-flag flip is wrapped in a transaction so the lookup
// (MAX(version) WHERE active = 1) never observes two active rows for a
// coordinate. Nothing here mutates the seeded `default` variant except through
// clone (which reads default and writes a NEW variant).

import { getUser } from '@/lib/local-auth';
import { getDb } from '@/lib/db/connection';
import { getActiveNovels, updateNovel, verifyNovelOwnership } from '@/lib/db/queries-novel';
import { nowIso } from '@/lib/utils';
import { applyGenrePack, listGenrePacks } from '@/lib/prompt-genre-packs';
import {
  KNOWN_STAGES,
  PROMPT_LOCALES,
  PROMPT_ROLES,
  MAX_TEMPLATE_TEXT_LEN,
  MAX_VARIABLES_SCHEMA_LEN,
  MAX_VARIANT_LEN,
  buildVariantPack,
  importVariantPack as importPackRows,
  parseVariantPack,
  serializeVariantPack,
  type KnownStage,
} from '@/lib/prompt-pack-io';

type Role = (typeof PROMPT_ROLES)[number];
type Locale = (typeof PROMPT_LOCALES)[number];

const knownStageSet: ReadonlySet<string> = new Set(KNOWN_STAGES);
const VARIANT_RE = /^[a-zA-Z0-9_.-]+$/;

async function requireUser(): Promise<string> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  return user.id;
}

function assertStage(stage: string): asserts stage is KnownStage {
  if (!knownStageSet.has(stage)) throw new Error(`Unknown stage: ${stage}`);
}

function assertRole(role: string): asserts role is Role {
  if (!(PROMPT_ROLES as readonly string[]).includes(role)) throw new Error(`Invalid role: ${role}`);
}

function assertLocale(locale: string): asserts locale is Locale {
  if (!(PROMPT_LOCALES as readonly string[]).includes(locale)) throw new Error(`Invalid locale: ${locale}`);
}

function assertVariant(variant: string, { allowDefault = false } = {}): void {
  if (!variant || variant.length > MAX_VARIANT_LEN || !VARIANT_RE.test(variant)) {
    throw new Error('Invalid variant');
  }
  if (!allowDefault && variant === 'default') {
    throw new Error('The default variant is read-only');
  }
}

function makeId(stage: string, role: string, locale: string, variant: string, version: number): string {
  const stamp = nowIso().replace(/[^0-9]/g, '').slice(0, 17);
  return `pt_${variant}_${stage}_${role}_${locale}_${version}_${stamp}`;
}

// ── Types returned to the client ─────────────────────────────────────────────

export interface TemplateRecord {
  id: string;
  stage: string;
  role: Role;
  locale: Locale;
  version: number;
  variant: string;
  templateText: string;
  variablesSchema: string;
  active: boolean;
  createdAt: string;
}

export interface TemplateGroup {
  stage: string;
  role: Role;
  /** Distinct variants that have at least one row for this (stage, role). */
  variants: string[];
}

interface TemplateRow {
  id: string;
  stage: string;
  role: Role;
  locale: Locale;
  version: number;
  variant: string;
  template_text: string;
  variables_schema: string;
  active: number;
  created_at: string;
}

function mapRow(r: TemplateRow): TemplateRecord {
  return {
    id: r.id,
    stage: r.stage,
    role: r.role,
    locale: r.locale,
    version: r.version,
    variant: r.variant,
    templateText: r.template_text,
    variablesSchema: r.variables_schema,
    active: r.active === 1,
    createdAt: r.created_at,
  };
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** The (stage, role) tree shown in the left rail, each with its variant list. */
export async function listTemplateGroups(): Promise<TemplateGroup[]> {
  await requireUser();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT DISTINCT stage, role, variant FROM prompt_templates ORDER BY stage, role, variant`,
    )
    .all() as Array<{ stage: string; role: Role; variant: string }>;

  const byKey = new Map<string, TemplateGroup>();
  for (const r of rows) {
    const key = `${r.stage}::${r.role}`;
    let group = byKey.get(key);
    if (!group) {
      group = { stage: r.stage, role: r.role, variants: [] };
      byKey.set(key, group);
    }
    if (!group.variants.includes(r.variant)) group.variants.push(r.variant);
  }
  // Keep `default` first in every variant list.
  for (const group of byKey.values()) {
    group.variants.sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
  }
  return Array.from(byKey.values());
}

/** All distinct variants in the table (for the per-novel selector / dedupe). */
export async function listVariants(): Promise<string[]> {
  await requireUser();
  const db = getDb();
  const rows = db
    .prepare(`SELECT DISTINCT variant FROM prompt_templates ORDER BY variant`)
    .all() as Array<{ variant: string }>;
  return rows
    .map((r) => r.variant)
    .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
}

/**
 * The resolved (active, latest-version) row for a coordinate. `locale` defaults
 * to `en`. Returns null when neither the variant nor the default has a row.
 */
export async function getTemplate(
  stage: string,
  role: string,
  variant: string,
  locale: string = 'en',
): Promise<TemplateRecord | null> {
  await requireUser();
  assertStage(stage);
  assertRole(role);
  assertLocale(locale);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM prompt_templates
        WHERE stage = ? AND role = ? AND locale = ? AND variant = ? AND active = 1
        ORDER BY version DESC LIMIT 1`,
    )
    .get(stage, role, locale, variant) as TemplateRow | undefined;
  return row ? mapRow(row) : null;
}

/** Full version history (all versions, all locales) for a (stage, role, variant). */
export async function listVersions(
  stage: string,
  role: string,
  variant: string,
): Promise<TemplateRecord[]> {
  await requireUser();
  assertStage(stage);
  assertRole(role);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM prompt_templates
        WHERE stage = ? AND role = ? AND variant = ?
        ORDER BY locale, version DESC`,
    )
    .all(stage, role, variant) as TemplateRow[];
  return rows.map(mapRow);
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Clone the default variant's active rows (all locales) for a (stage, role)
 * into a new author-chosen variant at version 1. Refuses to overwrite an
 * existing variant. Returns the created rows.
 */
export async function cloneAsVariant(
  stage: string,
  role: string,
  newVariant: string,
): Promise<TemplateRecord[]> {
  await requireUser();
  assertStage(stage);
  assertRole(role);
  assertVariant(newVariant);
  const db = getDb();

  const existing = db
    .prepare(`SELECT 1 FROM prompt_templates WHERE stage = ? AND role = ? AND variant = ? LIMIT 1`)
    .get(stage, role, newVariant);
  if (existing) throw new Error(`Variant "${newVariant}" already exists for this workflow`);

  const sources = db
    .prepare(
      `SELECT * FROM prompt_templates
        WHERE stage = ? AND role = ? AND variant = 'default' AND active = 1
        ORDER BY locale, version DESC`,
    )
    .all(stage, role) as TemplateRow[];
  if (sources.length === 0) throw new Error('No default template to clone from');

  // One active row per locale (the highest version), in case the default ever
  // carried multiple versions.
  const perLocale = new Map<string, TemplateRow>();
  for (const s of sources) if (!perLocale.has(s.locale)) perLocale.set(s.locale, s);

  const insert = db.prepare(
    `INSERT INTO prompt_templates
       (id, stage, role, locale, version, variant, template_text, variables_schema, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, ?)`,
  );
  const createdAt = nowIso();
  const created: TemplateRecord[] = [];
  const tx = db.transaction(() => {
    for (const s of perLocale.values()) {
      const id = makeId(stage, role, s.locale, newVariant, 1);
      insert.run(id, stage, role, s.locale, newVariant, s.template_text, s.variables_schema, createdAt);
      created.push({
        id,
        stage,
        role: role as Role,
        locale: s.locale,
        version: 1,
        variant: newVariant,
        templateText: s.template_text,
        variablesSchema: s.variables_schema,
        active: true,
        createdAt,
      });
    }
  });
  tx();
  return created;
}

/**
 * Overwrite the CURRENT active version's text/schema for a custom variant
 * coordinate in place (a draft save — no version bump). Use publishNewVersion
 * to snapshot a new version instead. Never touches the default variant.
 */
export async function saveVariantDraft(input: {
  stage: string;
  role: string;
  locale: string;
  variant: string;
  templateText: string;
  variablesSchema?: string;
}): Promise<TemplateRecord> {
  await requireUser();
  const { stage, role, locale, variant } = input;
  assertStage(stage);
  assertRole(role);
  assertLocale(locale);
  assertVariant(variant);
  validateBody(input.templateText, input.variablesSchema);

  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM prompt_templates
        WHERE stage = ? AND role = ? AND locale = ? AND variant = ? AND active = 1
        ORDER BY version DESC LIMIT 1`,
    )
    .get(stage, role, locale, variant) as TemplateRow | undefined;
  if (!row) throw new Error('No active template to save; clone the workflow first');

  db.prepare(
    `UPDATE prompt_templates SET template_text = ?, variables_schema = ? WHERE id = ?`,
  ).run(input.templateText, input.variablesSchema ?? row.variables_schema, row.id);

  return mapRow({ ...row, template_text: input.templateText, variables_schema: input.variablesSchema ?? row.variables_schema });
}

/**
 * Publish a new active version for a custom variant coordinate: insert
 * `MAX(version)+1` (active=1) and deactivate the previous active row, atomically.
 */
export async function publishNewVersion(input: {
  stage: string;
  role: string;
  locale: string;
  variant: string;
  templateText: string;
  variablesSchema?: string;
}): Promise<TemplateRecord> {
  await requireUser();
  const { stage, role, locale, variant } = input;
  assertStage(stage);
  assertRole(role);
  assertLocale(locale);
  assertVariant(variant);
  validateBody(input.templateText, input.variablesSchema);

  const db = getDb();
  const maxRow = db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS v FROM prompt_templates
        WHERE stage = ? AND role = ? AND locale = ? AND variant = ?`,
    )
    .get(stage, role, locale, variant) as { v: number };
  const nextVersion = (maxRow?.v ?? 0) + 1;
  const createdAt = nowIso();
  const id = makeId(stage, role, locale, variant, nextVersion);
  const schema = input.variablesSchema ?? '{}';

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE prompt_templates SET active = 0
        WHERE stage = ? AND role = ? AND locale = ? AND variant = ? AND active = 1`,
    ).run(stage, role, locale, variant);
    db.prepare(
      `INSERT INTO prompt_templates
         (id, stage, role, locale, version, variant, template_text, variables_schema, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, stage, role, locale, nextVersion, variant, input.templateText, schema, createdAt);
  });
  tx();

  return {
    id,
    stage,
    role: role as Role,
    locale: locale as Locale,
    version: nextVersion,
    variant,
    templateText: input.templateText,
    variablesSchema: schema,
    active: true,
    createdAt,
  };
}

/**
 * Flip the active version for a coordinate to `targetVersion` (rollback or
 * re-activate). Deactivates all other versions for that coordinate, atomically.
 * No row is physically deleted — history is preserved.
 */
export async function rollbackToVersion(input: {
  stage: string;
  role: string;
  locale: string;
  variant: string;
  targetVersion: number;
}): Promise<TemplateRecord> {
  await requireUser();
  const { stage, role, locale, variant, targetVersion } = input;
  assertStage(stage);
  assertRole(role);
  assertLocale(locale);
  assertVariant(variant);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) throw new Error('Invalid version');

  const db = getDb();
  const target = db
    .prepare(
      `SELECT * FROM prompt_templates
        WHERE stage = ? AND role = ? AND locale = ? AND variant = ? AND version = ?`,
    )
    .get(stage, role, locale, variant, targetVersion) as TemplateRow | undefined;
  if (!target) throw new Error('Target version not found');

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE prompt_templates SET active = 0
        WHERE stage = ? AND role = ? AND locale = ? AND variant = ?`,
    ).run(stage, role, locale, variant);
    db.prepare(`UPDATE prompt_templates SET active = 1 WHERE id = ?`).run(target.id);
  });
  tx();

  return mapRow({ ...target, active: 1 });
}

/** Alias of rollbackToVersion for the version-history "activate" affordance. */
export async function setActive(input: {
  stage: string;
  role: string;
  locale: string;
  variant: string;
  version: number;
}): Promise<TemplateRecord> {
  return rollbackToVersion({ ...input, targetVersion: input.version });
}

/**
 * Delete every row of a custom variant (all stages/roles/locales/versions).
 * Refuses to delete `default`, and refuses if any novel still references the
 * variant via `settings.promptVariant` / `settings.promptVariants`.
 */
export async function deleteVariant(variant: string): Promise<{ deleted: number }> {
  await requireUser();
  assertVariant(variant);

  // Re-check references AND delete inside ONE transaction so a novel cannot be
  // saved with this variant in the gap between the refs SELECT and the DELETE
  // (check-then-act window). The refs query is inlined so both run in the txn.
  const db = getDb();
  const deleted = db.transaction(() => {
    const refs = db
      .prepare(
        `SELECT id FROM novels
          WHERE settings IS NOT NULL
            AND (
              json_extract(settings, '$.promptVariant') = ?
              OR EXISTS (
                SELECT 1 FROM json_each(json_extract(settings, '$.promptVariants'))
                 WHERE json_each.value = ?
              )
            )`,
      )
      .all(variant, variant) as Array<{ id: string }>;
    if (refs.length > 0) {
      throw new Error(
        `Variant "${variant}" is still used by ${refs.length} novel(s); reassign them before deleting.`,
      );
    }
    return db.prepare(`DELETE FROM prompt_templates WHERE variant = ?`).run(variant).changes;
  })();
  return { deleted };
}

/** Titles of novels whose settings still point at `variant`. */
export async function novelsReferencingVariant(variant: string): Promise<Array<{ id: string; title: string }>> {
  const db = getDb();
  // Match either the whole-novel default or any per-stage override, via JSON.
  const rows = db
    .prepare(
      `SELECT id, title, settings FROM novels
        WHERE settings IS NOT NULL
          AND (
            json_extract(settings, '$.promptVariant') = ?
            OR EXISTS (
              SELECT 1 FROM json_each(json_extract(settings, '$.promptVariants'))
               WHERE json_each.value = ?
            )
          )`,
    )
    .all(variant, variant) as Array<{ id: string; title: string }>;
  return rows.map((r) => ({ id: r.id, title: r.title }));
}

// ── Per-novel variant binding ────────────────────────────────────────────────

/**
 * Point a novel's whole-novel default variant. `variant === ''` clears it back
 * to the seeded default. Per-stage overrides (`promptVariants`) are left intact.
 */
export async function setNovelVariant(novelId: string, variant: string): Promise<void> {
  const userId = await requireUser();
  const novel = await verifyNovelOwnership(novelId, userId);
  if (variant) assertVariant(variant);
  const settings = { ...(novel.settings ?? {}) };
  if (variant) settings.promptVariant = variant;
  else delete settings.promptVariant;
  await updateNovel(novelId, { settings });
}

// ── Pack import / export ─────────────────────────────────────────────────────

/** Serialise a variant's active rows to a JSON pack string (for file download). */
export async function exportVariantPack(variant: string, label?: string): Promise<string> {
  await requireUser();
  assertVariant(variant);
  return serializeVariantPack(buildVariantPack(variant, label));
}

/**
 * Import a pack from a JSON string. Strict zod validation (lib/prompt-pack-io)
 * rejects malformed/oversized/illegal rows; every row lands at a fresh version
 * under the pack's variant (or `overrideVariant`), never over `default`.
 */
export async function importVariantPack(
  json: string,
  overrideVariant?: string,
): Promise<{ variant: string; inserted: number; versionedOver: boolean }> {
  await requireUser();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('The selected file is not valid JSON');
  }
  const pack = parseVariantPack(raw); // throws on malformed input
  if (overrideVariant) assertVariant(overrideVariant);
  return importPackRows(pack, overrideVariant ? { overrideVariant } : undefined);
}

/**
 * Import a pack from a base64-encoded file (as returned by `readLocalFile`).
 * Decodes server-side — mirrors the manuscript-import action so the client
 * never needs a Buffer/atob polyfill.
 */
export async function importVariantPackFromBase64(
  contentsBase64: string,
  overrideVariant?: string,
): Promise<{ variant: string; inserted: number; versionedOver: boolean }> {
  await requireUser();
  let json: string;
  try {
    json = Buffer.from(contentsBase64 ?? '', 'base64').toString('utf-8');
  } catch {
    throw new Error('The selected file could not be read');
  }
  return importVariantPack(json, overrideVariant);
}

// ── genre packs ──────────────────────────────────────────────────────────────

export interface GenrePackInfo {
  id: string;
  variant: string;
  label: { en: string; 'zh-CN': string; 'zh-TW': string };
  description: { en: string; 'zh-CN': string; 'zh-TW': string };
}

export async function listGenrePackInfos(): Promise<GenrePackInfo[]> {
  await requireUser();
  return listGenrePacks().map((p) => ({
    id: p.id,
    variant: p.variant,
    label: p.label,
    description: p.description,
  }));
}

/** Apply a genre pack to a novel: land its variant rows + point the novel at it. */
export async function applyGenrePackToNovel(
  novelId: string,
  packId: string,
): Promise<{ variant: string; inserted: number }> {
  const userId = await requireUser();
  await verifyNovelOwnership(novelId, userId);
  const result = await applyGenrePack(novelId, packId);
  return { variant: result.variant, inserted: result.inserted };
}

// ── novel picker (for binding / packs) ───────────────────────────────────────

export interface NovelPick {
  id: string;
  title: string;
  promptVariant?: string;
}

/** Minimal novel list for the per-novel variant / genre-pack pickers. */
export async function listNovelsForWorkflows(): Promise<NovelPick[]> {
  const userId = await requireUser();
  const novels = await getActiveNovels(userId);
  return novels.map((n) => ({
    id: n.id,
    title: n.title,
    promptVariant: n.settings?.promptVariant,
  }));
}

// ── shared validation ────────────────────────────────────────────────────────

function validateBody(templateText: string, variablesSchema?: string): void {
  if (typeof templateText !== 'string' || templateText.trim().length === 0) {
    throw new Error('Template text is required');
  }
  if (templateText.length > MAX_TEMPLATE_TEXT_LEN) {
    throw new Error(`Template text exceeds ${MAX_TEMPLATE_TEXT_LEN} characters`);
  }
  if (variablesSchema !== undefined) {
    if (variablesSchema.length > MAX_VARIABLES_SCHEMA_LEN) {
      throw new Error('Variables schema is too large');
    }
    try {
      const parsed = JSON.parse(variablesSchema);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Variables schema must be a JSON object');
      }
    } catch {
      throw new Error('Variables schema must be valid JSON');
    }
  }
}
