export const sql = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS series (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL DEFAULT 'local-user',
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  vault_path   TEXT,
  settings     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS novels (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  series_id                TEXT REFERENCES series(id) ON DELETE SET NULL,
  title                    TEXT NOT NULL DEFAULT 'Untitled Draft',
  genre                    TEXT NOT NULL DEFAULT '',
  target_words             INTEGER NOT NULL DEFAULT 80000,
  stage                    TEXT NOT NULL DEFAULT 'discovery_interview'
                           CHECK (stage IN (
                             'discovery_interview',
                             'ready_for_greenlight',
                             'autonomous_writing',
                             'whole_book_unification',
                             'completed'
                           )),
  progress                 INTEGER NOT NULL DEFAULT 0,
  story_summary            TEXT NOT NULL DEFAULT '',
  character_summary        TEXT NOT NULL DEFAULT '',
  arc_summary              TEXT NOT NULL DEFAULT '',
  interview_state          TEXT,
  interview_state_v        INTEGER DEFAULT NULL,
  writing_lock_token       TEXT,
  writing_lock_expires_at  TEXT,
  unification_report       TEXT,
  unification_report_v     INTEGER DEFAULT NULL,
  volume_summaries         TEXT DEFAULT NULL,
  settings                 TEXT DEFAULT NULL,
  vault_path               TEXT,
  vault_version            INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  novel_id          TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL DEFAULT 'local-user',
  topic             TEXT NOT NULL DEFAULT 'general'
                    CHECK (topic IN ('plot', 'characters', 'worldbuilding', 'chapter_editing', 'general')),
  title             TEXT NOT NULL DEFAULT '',
  parent_message_id TEXT,
  is_archived       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  novel_id        TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  role            TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id                TEXT PRIMARY KEY,
  novel_id          TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_number    INTEGER NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  content           TEXT NOT NULL DEFAULT '',
  original_content  TEXT,
  word_count        INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 0,
  summary           TEXT NOT NULL DEFAULT '',
  key_facts         TEXT,
  key_facts_v       INTEGER DEFAULT NULL,
  quality_issues    TEXT,
  quality_issues_v  INTEGER DEFAULT NULL,
  generation_meta   TEXT,
  generation_meta_v INTEGER DEFAULT NULL,
  snapshots         TEXT DEFAULT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE(novel_id, chapter_number)
);

CREATE TABLE IF NOT EXISTS chapter_chat_history (
  id             TEXT PRIMARY KEY,
  novel_id       TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  chapter_number INTEGER NOT NULL,
  role           TEXT NOT NULL,
  content        TEXT NOT NULL DEFAULT '',
  changes        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id         TEXT PRIMARY KEY,
  novel_id   TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  series_id  TEXT,
  type       TEXT NOT NULL
             CHECK (type IN ('character', 'world', 'timeline', 'outline', 'style_reference')),
  title      TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}',
  data_v     INTEGER DEFAULT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  tags       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_relations (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  target_id     TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id               TEXT PRIMARY KEY,
  stage            TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user'
                   CHECK (role IN ('user', 'system')),
  locale           TEXT NOT NULL DEFAULT 'en'
                   CHECK (locale IN ('en', 'zh-CN', 'zh-TW')),
  version          INTEGER NOT NULL DEFAULT 1,
  variant          TEXT NOT NULL DEFAULT 'default',
  template_text    TEXT NOT NULL,
  variables_schema TEXT NOT NULL DEFAULT '{}',
  active           INTEGER NOT NULL DEFAULT 1
                   CHECK (active IN (0, 1)),
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_index (
  id              TEXT PRIMARY KEY,
  novel_id        TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  type            TEXT NOT NULL
                  CHECK (type IN ('character', 'world', 'timeline', 'outline', 'style_reference')),
  path            TEXT NOT NULL,
  title           TEXT NOT NULL,
  tags            TEXT NOT NULL DEFAULT '[]',
  aliases         TEXT NOT NULL DEFAULT '[]',
  importance      TEXT,
  data            TEXT NOT NULL DEFAULT '{}',
  outgoing_links  TEXT NOT NULL DEFAULT '[]',
  content_hash    TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(novel_id, path)
);

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id            TEXT PRIMARY KEY REFERENCES knowledge_index(id) ON DELETE CASCADE,
  novel_id      TEXT NOT NULL,
  model_id      TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  vector        BLOB NOT NULL,
  content_hash  TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS writing_jobs (
  id               TEXT PRIMARY KEY,
  novel_id         TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','paused','completed','failed')),
  end_reason       TEXT,
  current_chapter  INTEGER,
  completed_in_run INTEGER NOT NULL DEFAULT 0,
  seq              INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT,
  started_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_events (
  id             TEXT PRIMARY KEY,
  novel_id       TEXT NOT NULL REFERENCES novels(id) ON DELETE CASCADE,
  type           TEXT NOT NULL
                 CHECK (type IN (
                   'chapter_written','chapter_edited','unification_applied',
                   'quality_resolved','status_changed','export_completed',
                   'snapshot_restored'
                 )),
  source         TEXT NOT NULL CHECK (source IN ('ai','human','accepted')),
  chapter_number INTEGER,
  words_delta    INTEGER NOT NULL DEFAULT 0,
  day_key        TEXT NOT NULL,
  meta           TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL DEFAULT 'local-user',
  novel_id        TEXT REFERENCES novels(id) ON DELETE SET NULL,
  chapter_number  INTEGER,
  operation       TEXT NOT NULL
                  CHECK (operation IN (
                    'chat','outline','chapter','polish','summarize','validate','unify'
                  )),
  role            TEXT,
  connection_kind TEXT,
  provider_id     TEXT,
  model_id        TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  total_tokens    INTEGER,
  first_token_ms  INTEGER,
  duration_ms     INTEGER,
  outcome         TEXT
                  CHECK (outcome IN ('success','failed','truncated','cancelled')),
  est_cost_usd    REAL,
  accepted        INTEGER,
  accepted_words  INTEGER,
  generated_words INTEGER,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_events_created ON activity_events(novel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_day ON activity_events(novel_id, day_key);
CREATE INDEX IF NOT EXISTS idx_ai_runs_model_op ON ai_runs(model_id, operation);
CREATE INDEX IF NOT EXISTS idx_ai_runs_novel ON ai_runs(novel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chapter_chat_novel ON chapter_chat_history(novel_id, chapter_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chapters_novel_id ON chapters(novel_id, chapter_number);
CREATE INDEX IF NOT EXISTS idx_conversations_novel_id ON conversations(novel_id);
CREATE INDEX IF NOT EXISTS idx_kemb_novel ON knowledge_embeddings(novel_id);
CREATE INDEX IF NOT EXISTS idx_kidx_novel_type ON knowledge_index(novel_id, type);
CREATE INDEX IF NOT EXISTS idx_kidx_title ON knowledge_index(novel_id, title);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_novel ON knowledge_entries(novel_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_entries_series ON knowledge_entries(series_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_source ON knowledge_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_relations_target ON knowledge_relations(target_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_relations_unique
  ON knowledge_relations(source_id, target_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_messages_novel_id ON messages(novel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_novels_series ON novels(series_id);
CREATE INDEX IF NOT EXISTS idx_novels_updated_at ON novels(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_novels_user_id ON novels(user_id);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_active ON prompt_templates(stage, role, locale, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_templates_lookup
  ON prompt_templates(stage, role, locale, variant, version);
CREATE INDEX IF NOT EXISTS idx_series_user ON series(user_id);
CREATE INDEX IF NOT EXISTS idx_writing_jobs_novel ON writing_jobs(novel_id, started_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_knowledge_relation_no_self
BEFORE INSERT ON knowledge_relations
BEGIN
  SELECT RAISE(ABORT, 'knowledge_relation: source and target must differ')
  WHERE NEW.source_id = NEW.target_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_knowledge_relation_same_novel
BEFORE INSERT ON knowledge_relations
BEGIN
  SELECT RAISE(ABORT, 'knowledge_relation: source and target must belong to the same novel or series')
  WHERE NOT EXISTS (
    SELECT 1
      FROM knowledge_entries src
      JOIN knowledge_entries tgt
        ON tgt.id = NEW.target_id
     WHERE src.id = NEW.source_id
       AND (
         src.novel_id = tgt.novel_id
         OR (
           src.series_id IS NOT NULL
           AND tgt.series_id IS NOT NULL
           AND src.series_id = tgt.series_id
         )
       )
  );
END;
`;
