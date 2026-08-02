import { sql as currentSchemaSql } from '@/lib/db/schema/0001_initial';
import { KNOWN_LEGACY_REVIEW_ITEMS_DDL } from '@/lib/db/schema/frozen/known-legacy-review-items.sql';
import { LEGACY_SCHEMA_1_DDL } from '@/lib/db/schema/frozen/legacy-schema-1.sql';
import { PUBLISHED_SCHEMA_18_DDL } from '@/lib/db/schema/frozen/published-schema-18.sql';
import { PUBLISHED_SCHEMA_19_DDL } from '@/lib/db/schema/frozen/published-schema-19.sql';
import { SCHEMA_20_DDL } from '@/lib/db/schema/frozen/schema-20.sql';
import { SCHEMA_21_DDL } from '@/lib/db/schema/frozen/schema-21.sql';
import {
  CURRENT_SCHEMA_DESCRIPTION,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/schema/version';

export {
  CURRENT_SCHEMA_DESCRIPTION,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/schema/version';

/** Exact dual-marker history for the known review_items legacy recovery path. */
export const KNOWN_LEGACY_REVIEW_ITEMS_MARKERS = [
  { version: 1, description: 'current_baseline' },
  { version: 18, description: 'baseline_epoch_v18' },
] as const;

/**
 * Current published on-disk schema epoch.
 *
 * Public macOS v0.1.0 / v0.1.1 stamped schema 18 (baseline without
 * `knowledge_vault_outbox`). Schema 19 added the durable outbox (with explicit
 * status). Some already-distributed interim builds incorrectly stamped the
 * pre-status outbox table set as schema 1; those are accepted and promoted.
 * Schema 20 adds an explicit chapter `processing_status` lifecycle.
 * Schema 21 adds durable ordinary-chat turn receipts (`chat_turns`),
 * import confirmation receipts, and durable brainstorm undo receipts.
 * Schema 22 adds `knowledge_index.mirror_content_hash` for conditional Vault
 * replacement against the last observed Markdown bytes.
 */
/** Exact published v0.1.0 / v0.1.1 schema marker. */
export const PUBLISHED_SCHEMA_18_VERSION = 18;

/** Exact schema-19 marker (outbox present; chapters lack processing_status). */
export const PUBLISHED_SCHEMA_19_VERSION = 19;

/** Exact schema-20 marker (processing_status present; no chat_turns). */
export const SCHEMA_20_VERSION = 20;

/** Exact schema-21 marker (chat_turns present; no mirror_content_hash). */
export const SCHEMA_21_VERSION = 21;

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
  'brainstorm_receipts',
  'chapter_chat_history',
  'chapters',
  'chat_turn_tool_snapshots',
  'chat_turns',
  'conversations',
  'import_confirmations',
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

/** Additive DDL applied when promoting published schema 18 → current. */
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
 * Promote legacy schema-1 outbox (no status / revision columns) to schema 19+.
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

/**
 * Additive DDL for schema 19 → 20. Existing rows default to `complete` because
 * prior completion state is unknowable; AI writers set `content_saved` on new
 * prose until post-processing commits.
 */
export const SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL = `
ALTER TABLE chapters
  ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'complete'
  CHECK (processing_status IN ('content_saved', 'complete'));
`;

/**
 * Additive DDL for schema 20 → 21. Ordinary-chat turns gain a durable receipt
 * so concurrent/sequential retries cannot invoke the model twice. Import
 * confirmation and brainstorm undo receipts are also durable SQLite state.
 */
export const SCHEMA_21_CHAT_TURNS_DDL = `
CREATE TABLE IF NOT EXISTS chat_turns (
  novel_id              TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_message_id       TEXT NOT NULL,
  request_hash          TEXT NOT NULL,
  assistant_message_id  TEXT NOT NULL,
  status                TEXT NOT NULL
                        CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  brainstorm_receipt_id TEXT,
  response_text         TEXT,
  error_code            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (novel_id, user_message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_turns_novel_status ON chat_turns(novel_id, status);

CREATE TABLE IF NOT EXISTS chat_turn_tool_snapshots (
  novel_id        TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  tool_key        TEXT NOT NULL,
  snapshot_key    TEXT NOT NULL,
  payload         TEXT NOT NULL,
  payload_sha256  TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (novel_id, user_message_id, tool_key, snapshot_key),
  FOREIGN KEY (novel_id, user_message_id)
    REFERENCES chat_turns(novel_id, user_message_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS import_confirmations (
  session_token TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  status        TEXT NOT NULL
                CHECK (status IN ('pending', 'succeeded')),
  result_json   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brainstorm_receipts (
  id                 TEXT PRIMARY KEY,
  novel_id           TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  created_at_ms      INTEGER NOT NULL,
  expires_at_ms      INTEGER NOT NULL,
  consumed_at_ms     INTEGER,
  undo_expires_at_ms INTEGER,
  undone             INTEGER NOT NULL DEFAULT 0
                     CHECK (undone IN (0, 1)),
  profile_json       TEXT,
  entries_json       TEXT NOT NULL DEFAULT '[]',
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_brainstorm_receipts_novel
  ON brainstorm_receipts(novel_id, created_at_ms DESC);
`;

/**
 * Additive DDL for schema 21 → 22. Existing rows keep NULL mirror hashes
 * (unknown baseline: refuse replacing divergent existing Markdown). Successful
 * mirror I/O and matching imports populate the hash for later conditional replaces.
 */
export const SCHEMA_22_MIRROR_CONTENT_HASH_DDL = `
ALTER TABLE knowledge_index
  ADD COLUMN mirror_content_hash TEXT;
`;

export {
  currentSchemaSql,
  KNOWN_LEGACY_REVIEW_ITEMS_DDL,
  LEGACY_SCHEMA_1_DDL,
  PUBLISHED_SCHEMA_18_DDL,
  PUBLISHED_SCHEMA_19_DDL,
  SCHEMA_20_DDL,
  SCHEMA_21_DDL,
};
