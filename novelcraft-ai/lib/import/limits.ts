// Shared caps for the opaque manuscript import pipeline.
// Keep in lockstep with `MAX_MANUSCRIPT_IMPORT_BYTES` in
// `src-tauri/src/manuscript_import.rs`.

export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB
/** Parsed prose may expand beyond the compressed DOCX input, but stays bounded. */
export const MAX_IMPORT_RECONSTRUCTED_BYTES = 64 * 1024 * 1024;
export const MAX_IMPORT_CHAPTERS = 1_000;
export const MAX_IMPORT_PARAGRAPHS = 20_000;
/** Keeps compact confirm/dedupe payloads below the framework request ceiling. */
export const MAX_IMPORT_PARTS = 5_000;
export const MAX_IMPORT_TITLE_CHARS = 200;
export const MAX_IMPORT_BASENAME_CHARS = 180;
export const MAX_IMPORT_NOVEL_TITLE_CHARS = 200;
/** Bounded body snippet returned to the client per chapter. */
export const PREVIEW_SNIPPET_CHARS = 240;
/** Bounded snippet per paragraph for the split-at-paragraph UI. */
export const PREVIEW_PARAGRAPH_CHARS = 80;
/** Aggregate prose-character budget for the complete open-session response. */
export const MAX_IMPORT_PREVIEW_CHARS = 120_000;
/** Import sessions expire after 24h (best-effort cleanup). */
export const IMPORT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** 32-byte token encoded as lowercase hex. */
export const IMPORT_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
