// Barrel re-export of the split AI module (see `lib/ai/`). Existing imports
// from `@/lib/ai` continue to resolve here unchanged.
//
// Server-only — the sub-modules resolve prompts exclusively from the local
// SQLite `prompt_templates` table seeded when a fresh database is created.

export * from '@/lib/ai/index';
