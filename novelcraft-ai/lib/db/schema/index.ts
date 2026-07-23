import { sql as currentSchemaSql } from '@/lib/db/schema/0001_initial';

/** The only on-disk shape supported by the unpublished product. */
export const CURRENT_SCHEMA_VERSION = 1;

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

export { currentSchemaSql };
