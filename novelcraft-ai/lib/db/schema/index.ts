import { sql as currentSchemaSql } from '@/lib/db/schema/0001_initial';
import { LEGACY_SCHEMA_1_DDL } from '@/lib/db/schema/frozen/legacy-schema-1.sql';
import { PUBLISHED_SCHEMA_18_DDL } from '@/lib/db/schema/frozen/published-schema-18.sql';

/**
 * Current published on-disk schema epoch.
 *
 * Public macOS v0.1.0 / v0.1.1 stamped schema 18 (baseline without
 * `knowledge_vault_outbox`). This build adds the durable outbox (with explicit
 * status) as epoch 19. Some already-distributed interim builds incorrectly
 * stamped the pre-status outbox table set as schema 1; those are accepted and
 * promoted to 19.
 */
export const CURRENT_SCHEMA_VERSION = 19;

/** Exact published v0.1.0 / v0.1.1 schema marker. */
export const PUBLISHED_SCHEMA_18_VERSION = 18;

/**
 * Mis-stamped interim builds that already carry the pre-status-column outbox
 * table set but recorded version 1.
 */
export const MISSTAMPED_CURRENT_SHAPE_VERSION = 1;

export const PUBLISHED_SCHEMA_18_TABLES = [
  '_schema_version',
  'activity_events',
  'ai_runs',
  'app_settings',
  'chapter_chat_history',
  'chapters',
  'conversations',
  'knowledge_embeddings',
  'knowledge_entries',
  'knowledge_index',
  'knowledge_relations',
  'messages',
  'novels',
  'prompt_templates',
  'series',
  'users',
  'writing_jobs',
] as const;

export const CURRENT_SCHEMA_TABLES = [
  '_schema_version',
  'activity_events',
  'ai_runs',
  'app_settings',
  'chapter_chat_history',
  'chapters',
  'conversations',
  'knowledge_embeddings',
  'knowledge_entries',
  'knowledge_index',
  'knowledge_relations',
  'knowledge_vault_outbox',
  'messages',
  'novels',
  'prompt_templates',
  'series',
  'users',
  'writing_jobs',
] as const;

/**
 * Evidence oracles from exact tagged / pre-wave DDL + `_schema_version`
 * (JSON.stringify of non-internal sqlite_schema rows). Used in tests; runtime
 * recognition prefers the semantic structural fingerprint.
 */
export const PUBLISHED_SCHEMA_18_SQL_ORACLE =
  'da2fa6ed73e7641b7b2a6a7b75852d2d85937ae19e1cd8e66e3b6707ff343763';
export const PUBLISHED_SCHEMA_18_SQL_ORACLE_OBJECT_COUNT = 42;
export const LEGACY_SCHEMA_1_SQL_ORACLE =
  '917a3bf0d26166eeb777976660a308f167481656778bd40906f0e26e9531a4e5';
export const LEGACY_SCHEMA_1_SQL_ORACLE_OBJECT_COUNT = 44;

/** Additive DDL applied when promoting published schema 18 → 19. */
export const SCHEMA_19_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS knowledge_vault_outbox (
  entry_id         TEXT PRIMARY KEY,
  novel_id         TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  operation        TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  rel_path         TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'completed', 'dead_letter')),
  intent_revision  INTEGER NOT NULL DEFAULT 1,
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_vault_outbox_novel
  ON knowledge_vault_outbox(novel_id, operation);
`;

/**
 * Promote legacy schema-1 outbox (no status / revision columns) to schema 19.
 * Every legacy intent remains pending: the old row shape cannot distinguish a
 * completed delete tombstone from a delete that replaced an upsert immediately
 * before a crash. Replaying delete is idempotent; guessing completed could
 * resurrect data from the still-present Vault file. intent_revision starts at
 * 1 so CAS completion matches the first drain attempt for preserved rows.
 */
export const SCHEMA_19_OUTBOX_STATUS_PROMOTION_DDL = `
ALTER TABLE knowledge_vault_outbox
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'completed', 'dead_letter'));

ALTER TABLE knowledge_vault_outbox
  ADD COLUMN intent_revision INTEGER NOT NULL DEFAULT 1;
`;

export {
  currentSchemaSql,
  LEGACY_SCHEMA_1_DDL,
  PUBLISHED_SCHEMA_18_DDL,
};
