// Barrel re-export of the split AI module (see `lib/ai/`). Existing imports
// from `@/lib/ai` continue to resolve here unchanged.
//
// Server-only — the sub-modules look up prompt templates in the local SQLite
// `prompt_templates` table on first use.

export * from '@/lib/ai/index';
