/**
 * Schema-only fragment for the known dual-marker legacy shape that shipped
 * PUBLISHED_SCHEMA_18_DDL plus an obsolete `review_items` table. Recognition
 * and recovery fixtures must use this exact DDL; do not invent alternate forms.
 *
 * String literals are quoted for SQLite CHECK/DEFAULT contracts.
 */
export const KNOWN_LEGACY_REVIEW_ITEMS_DDL = `
CREATE TABLE review_items (
  id              TEXT PRIMARY KEY,
  novel_id        TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  source          TEXT NOT NULL
                  CHECK (source IN (
                    'chapter_quality','unification','deterministic',
                    'ai_rewrite','author_todo','editor_note'
                  )),
  chapter_number  INTEGER,
  scene_ref       TEXT,
  kind            TEXT,
  severity        TEXT NOT NULL DEFAULT 'minor'
                  CHECK (severity IN ('minor','major','critical','info')),
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','accepted','rejected','later')),
  original_text   TEXT,
  suggested_text  TEXT,
  rationale       TEXT,
  resolution_note TEXT,
  origin_ref      TEXT,
  payload         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  resolved_at     TEXT
);
CREATE INDEX idx_review_items_filter ON review_items(novel_id, status, severity);
CREATE UNIQUE INDEX idx_review_items_origin ON review_items(novel_id, origin_ref);
`;
