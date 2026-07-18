// Template-pack import/export (W3-2, server-only).
//
// A "variant pack" is the set of `prompt_templates` rows that share one variant
// — the author's customised workflow. Export serialises the active rows for a
// variant into a portable JSON document; import validates that document with a
// strict zod schema and INSERTs each row under a fresh `version` (it never
// overwrites the seeded `default` variant or any existing row).
//
// The strict schema is the security boundary: a hand-edited or hostile pack
// must not be able to pollute `prompt_templates` with an unknown stage, an
// illegal role/locale (which would also violate the table CHECK constraints and
// throw mid-transaction), or a multi-megabyte body. We reject the whole pack
// before touching the DB.

import { z } from 'zod';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db/connection';
import { nowIso } from '@/lib/utils';

/**
 * The canonical prompt stages, mirrored from `lib/prompt-seed.ts`'s SEED_ROWS.
 * A pack referencing any other stage is rejected — an unknown stage would never
 * be resolved by any ai/* call site, so it is dead-or-malicious data.
 */
export const KNOWN_STAGES = [
  'greenlight_pack',
  'book_blueprint',
  'chapter_write',
  'chapter_continuation',
  'chapter_summarize',
  'chapter_validate',
  'unification',
  'chapter_edit',
  'interview_system',
  'chapter_ralph_revise',
] as const;

export type KnownStage = (typeof KNOWN_STAGES)[number];

export const PROMPT_ROLES = ['user', 'system'] as const;
export const PROMPT_LOCALES = ['en', 'zh-CN', 'zh-TW'] as const;

/** Hard cap on a single template body. Generous for prose-shaped prompts but
 *  closes the "ship a 50MB row" pollution vector. */
export const MAX_TEMPLATE_TEXT_LEN = 20_000;
/** Cap on the serialised variables_schema JSON blob. */
export const MAX_VARIABLES_SCHEMA_LEN = 8_000;
/** Cap on rows per pack — 10 stages × 2 roles × 3 locales = 60 is the natural
 *  ceiling for a full variant; allow some slack, reject anything absurd. */
export const MAX_PACK_ROWS = 200;
export const MAX_VARIANT_LEN = 64;
export const MAX_PACK_LABEL_LEN = 120;

const knownStageSet: ReadonlySet<string> = new Set(KNOWN_STAGES);

const packRowSchema = z
  .object({
    stage: z
      .string()
      .refine((s): s is KnownStage => knownStageSet.has(s), { message: 'unknown stage' }),
    role: z.enum(PROMPT_ROLES),
    locale: z.enum(PROMPT_LOCALES),
    templateText: z.string().min(1).max(MAX_TEMPLATE_TEXT_LEN),
    // Accept a JSON string (the column stores text) and bound its size. We also
    // verify it parses to an object so a downstream form reader never chokes.
    variablesSchema: z
      .string()
      .max(MAX_VARIABLES_SCHEMA_LEN)
      .optional()
      .default('{}')
      .refine(
        (raw) => {
          if (!raw) return true;
          try {
            const parsed = JSON.parse(raw);
            return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
          } catch {
            return false;
          }
        },
        { message: 'variablesSchema must be a JSON object' },
      ),
  })
  .strict();

export const variantPackSchema = z
  .object({
    formatVersion: z.literal(1),
    variant: z
      .string()
      .min(1)
      .max(MAX_VARIANT_LEN)
      // The variant string is written verbatim into a table column and echoed in
      // filenames — keep it to a safe identifier-ish charset.
      .regex(/^[a-zA-Z0-9_.-]+$/, { message: 'variant must be alphanumeric/_/-/.' })
      .refine((v) => v !== 'default', { message: 'cannot import over the default variant' }),
    label: z.string().max(MAX_PACK_LABEL_LEN).optional(),
    exportedAt: z.string().optional(),
    rows: z.array(packRowSchema).min(1).max(MAX_PACK_ROWS),
  })
  .strict();

export type VariantPackRow = z.infer<typeof packRowSchema>;
export type VariantPack = z.infer<typeof variantPackSchema>;

export interface TemplateRowDb {
  stage: string;
  role: 'user' | 'system';
  locale: 'en' | 'zh-CN' | 'zh-TW';
  template_text: string;
  variables_schema: string;
}

/**
 * Build the export document for a variant: the active, latest-version row for
 * every (stage, role, locale) under that variant. Throws if the variant has no
 * rows (nothing to export).
 */
export function buildVariantPack(variant: string, label?: string): VariantPack {
  if (variant === 'default') {
    throw new Error('Refusing to export the built-in default variant');
  }
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT stage, role, locale, template_text, variables_schema
         FROM prompt_templates t
        WHERE variant = ?
          AND active = 1
          AND version = (
            SELECT MAX(version) FROM prompt_templates
             WHERE stage = t.stage AND role = t.role AND locale = t.locale
               AND variant = t.variant AND active = 1
          )
        ORDER BY stage, role, locale`,
    )
    .all(variant) as TemplateRowDb[];

  if (rows.length === 0) {
    throw new Error(`Variant "${variant}" has no active templates to export`);
  }

  const pack: VariantPack = {
    formatVersion: 1,
    variant,
    label,
    exportedAt: nowIso(),
    rows: rows.map((r) => ({
      stage: r.stage as KnownStage,
      role: r.role,
      locale: r.locale,
      templateText: r.template_text,
      variablesSchema: r.variables_schema || '{}',
    })),
  };
  // Round-trip through the schema so an export is always a valid import.
  return variantPackSchema.parse(pack);
}

export interface ImportResult {
  variant: string;
  inserted: number;
  /** True when rows already existed for this variant (we versioned up instead of clobbering). */
  versionedOver: boolean;
}

/**
 * Parse + validate a raw pack document. Throws a zod error on malformed input.
 * Exposed separately so callers can validate a file before deciding to import.
 */
export function parseVariantPack(raw: unknown): VariantPack {
  return variantPackSchema.parse(raw);
}

/**
 * Import a validated pack. Every row is INSERTed at `MAX(existing version)+1`
 * for its (stage, role, locale, variant) coordinate and marked active; any
 * prior active row for that coordinate is deactivated in the same transaction
 * so the lookup resolves to the imported text. The seeded `default` variant is
 * never touched (the schema already rejects `variant === 'default'`).
 *
 * Pass `overrideVariant` to land the pack under a different variant name than
 * the document declares (used when cloning/importing under an author-chosen id).
 */
export function importVariantPack(
  rawOrPack: unknown,
  opts?: { overrideVariant?: string },
): ImportResult {
  // Always re-validate through the strict schema, even for an already-typed
  // object — the security boundary is the parse, not the caller's claim.
  const pack = variantPackSchema.parse(rawOrPack);

  const variant = opts?.overrideVariant ?? pack.variant;
  if (variant === 'default') throw new Error('cannot import over the default variant');
  if (!/^[a-zA-Z0-9_.-]+$/.test(variant) || variant.length > MAX_VARIANT_LEN) {
    throw new Error('invalid target variant');
  }

  const db = getDb();
  return importPackInto(db, pack, variant);
}

function importPackInto(db: Database.Database, pack: VariantPack, variant: string): ImportResult {
  const nextVersionStmt = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v
       FROM prompt_templates
      WHERE stage = ? AND role = ? AND locale = ? AND variant = ?`,
  );
  const deactivateStmt = db.prepare(
    `UPDATE prompt_templates SET active = 0
      WHERE stage = ? AND role = ? AND locale = ? AND variant = ? AND active = 1`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO prompt_templates
       (id, stage, role, locale, version, variant, template_text, variables_schema, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  );
  const createdAt = nowIso();
  let inserted = 0;
  let versionedOver = false;

  const tx = db.transaction(() => {
    for (const row of pack.rows) {
      const existing = nextVersionStmt.get(row.stage, row.role, row.locale, variant) as { v: number };
      const nextVersion = (existing?.v ?? 0) + 1;
      if (existing.v > 0) versionedOver = true;
      deactivateStmt.run(row.stage, row.role, row.locale, variant);
      insertStmt.run(
        `pt_${variant}_${row.stage}_${row.role}_${row.locale}_${nextVersion}_${createdAt.replace(/[^0-9]/g, '').slice(0, 17)}`,
        row.stage,
        row.role,
        row.locale,
        nextVersion,
        variant,
        row.templateText,
        row.variablesSchema ?? '{}',
        createdAt,
      );
      inserted += 1;
    }
  });
  tx();

  return { variant, inserted, versionedOver };
}

/** Serialise a pack to a pretty JSON string for the export file. */
export function serializeVariantPack(pack: VariantPack): string {
  return JSON.stringify(pack, null, 2);
}
