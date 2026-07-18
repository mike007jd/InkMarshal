import { sql as initial } from '@/lib/db/schema/0001_initial';

export interface Migration {
  version: number;
  description: string;
  sql: string;
  /**
   * DB-02: marks a migration that drops/rewrites data or columns (not a pure
   * additive `CREATE TABLE/INDEX ... IF NOT EXISTS`). A destructive step must
   * NOT run without a verified pre-migration backup — see runMigrations.
   */
  destructive?: boolean;
}

/**
 * Logical schema epoch for the collapsed baseline.
 *
 * InkMarshal publicly shipped macOS v0.1.0 with schema 18 (18 incremental
 * migrations 0001–0018). Those migrations were later collapsed into this single
 * `0001_initial` baseline, so the CURRENT product shape IS logical schema 18. We
 * therefore stamp the baseline as version 18 (not 1): a released-v0.1.0 database
 * already sits at 18, and a fresh install lands on the same epoch, so both share
 * one version line and the NEXT migration is 19 for everyone. Numbering the
 * baseline 1 would have let a future `version: 2` run on fresh installs while
 * silently skipping on every shipped v18 database.
 */
export const BASELINE_SCHEMA_VERSION = 18;

/** The next migration to author must use this version (append to `migrations`). */
export const NEXT_SCHEMA_VERSION = BASELINE_SCHEMA_VERSION + 1;

export const migrations: Migration[] = [
  { version: BASELINE_SCHEMA_VERSION, description: 'baseline_epoch_v18', sql: initial },
];
