type JsonParseErrorDetail =
  | { kind: 'corrupted'; raw: string; cause: string }
  | { kind: 'version_mismatch'; stored_v: number; max_supported_v: number }
  | { kind: 'schema_mismatch'; missing_fields: string[] };

class JsonColumnError extends Error {
  constructor(
    public readonly column: string,
    public readonly detail: JsonParseErrorDetail,
  ) {
    super(`JSON column '${column}' parse error: ${detail.kind}`);
    this.name = 'JsonColumnError';
  }
}

export interface ParseOptions {
  /** Highest version this code understands. */
  maxSupportedVersion: number;
  /** Returns missing required field names, empty array if shape is valid. */
  validate?: (v: unknown) => string[];
  /**
   * When true (D8), a JSON-parse/corruption error on a user-content column
   * degrades to `null` + `console.warn` instead of throwing — so one corrupt
   * cell can't take down the whole `getNovel`/`getChapter` read. The
   * forward-version guard (`stored_v > maxSupported`) ALWAYS throws regardless,
   * because that is the deliberate "block a downgraded client" choice.
   */
  lenientOnCorruption?: boolean;
}

export function parseJsonbWithVersion<T>(
  raw: unknown,
  version: unknown,
  column: string,
  opts: ParseOptions,
): T | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return raw as T;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    if (opts.lenientOnCorruption) {
      console.warn(
        `JSON column '${column}' is corrupt; degrading to null: ${(e as Error).message}`,
      );
      return null;
    }
    throw new JsonColumnError(column, {
      kind: 'corrupted',
      raw: raw.slice(0, 200),
      cause: (e as Error).message,
    });
  }

  const storedV =
    typeof version === 'number'
      ? version
      : typeof version === 'string' && version.trim() !== '' && Number.isFinite(Number(version))
        ? Number(version)
        : null;
  if (storedV !== null && storedV > opts.maxSupportedVersion) {
    throw new JsonColumnError(column, {
      kind: 'version_mismatch',
      stored_v: storedV,
      max_supported_v: opts.maxSupportedVersion,
    });
  }

  if (opts.validate) {
    const missing = opts.validate(parsed);
    if (missing.length > 0) {
      throw new JsonColumnError(column, {
        kind: 'schema_mismatch',
        missing_fields: missing,
      });
    }
  }

  return parsed as T;
}

export function toJsonText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

/** Lenient legacy reader: returns null on corrupt JSON instead of throwing. */
export function fromJsonTextLenient<T>(v: unknown): T | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

/**
 * Current JSON column versions written by this build. Only columns actually
 * round-tripped through {@link parseJsonbWithVersion} live here — `blueprint`
 * (W2-D dropped the column; it's now a fresh projection), `knowledge_data`, and
 * `volume_summaries` (parsed via raw JSON.parse) were never read off this map.
 */
export const JSON_COLUMN_VERSIONS = {
  interview_state: 1,
  unification_report: 1,
  key_facts: 1,
  quality_issues: 1,
  generation_meta: 1,
} as const;


/**
 * SQL-side defense-in-depth for a malformed `data` JSON column: yields the
 * column text, or `'{}'` when it isn't valid JSON, so `json_extract`/`json_set`/
 * `json_each` can't throw on a corrupt row before the application-layer parser
 * (`parseKnowledgeEntry`) gets a chance to tolerate it.
 */
export const SAFE_DATA_JSON = "CASE WHEN json_valid(data) THEN data ELSE '{}' END";
