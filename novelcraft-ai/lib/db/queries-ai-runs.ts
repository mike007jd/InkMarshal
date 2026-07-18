// Read/write layer for the per-call AI usage ledger (ai_runs).
// Powers the local cost panel. This module owns:
//   - insertAiRun        — append one row per AI call (best-effort; the caller
//                          wraps it so a write failure never aborts generation).
//   - markAiRunAccepted  — rebuild accepted / accepted_words on a settled run.
//   - aggregateAiRuns    — GROUP BY operation × model with SUM/AVG for the table.
//   - costPerAcceptedKWord — the headline "$ per 1k accepted words" metric.
//
// DESIGN: ai_runs is append-only and high-cardinality (a long novel reaches
// thousands of rows), so the panel reads are pure SQL aggregates — never a load
// of every row into JS. novel_id is ON DELETE SET NULL, so a deleted novel's
// rows survive with a NULL novel_id (cross-project history), which the filters
// account for.

import { getDb } from '@/lib/db/connection';
import { nowIso } from '@/lib/utils';
import type { OperationKind, RuntimeConnectionKind } from '@/lib/model-supply/types';
import type { CapabilityRole } from '@/lib/model-supply/types';
import type { RunOutcome } from '@/lib/ai-runs';

/** A row to append. Numeric fields are nullable — a partial provider usage
 *  payload still yields an honest partial row rather than fabricated zeros. */
export interface AiRunInput {
  novelId?: string | null;
  chapterNumber?: number | null;
  operation: OperationKind;
  role?: CapabilityRole | string | null;
  connectionKind?: RuntimeConnectionKind | null;
  providerId?: string | null;
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  firstTokenMs?: number | null;
  durationMs?: number | null;
  outcome: RunOutcome;
  /** est_cost_usd: 0 for local, a positive number for priced BYOK, or null
   *  ("unknown") for an unpriced cloud call. NULL is meaningful — keep it. */
  estCostUsd?: number | null;
  /** Word count of the prose this run actually generated (captured at generation
   *  time). Stored on the run itself so the cost-per-kWord metric attributes
   *  each run from its OWN word count rather than falling back to the mutable
   *  chapters row (which always reflects the LATEST regeneration). */
  generatedWords?: number | null;
}

const INSERT_SQL = `
  INSERT INTO ai_runs (
    id, user_id, novel_id, chapter_number, operation, role, connection_kind,
    provider_id, model_id, input_tokens, output_tokens, total_tokens,
    first_token_ms, duration_ms, outcome, est_cost_usd, accepted, accepted_words,
    generated_words, created_at
  ) VALUES (
    @id, @user_id, @novel_id, @chapter_number, @operation, @role, @connection_kind,
    @provider_id, @model_id, @input_tokens, @output_tokens, @total_tokens,
    @first_token_ms, @duration_ms, @outcome, @est_cost_usd, NULL, NULL,
    @generated_words, @created_at
  )
`;

/** Append one ledger row. Returns the generated run id. Throws on a DB error —
 *  the caller (lib/ai-usage.ts) wraps this in try/catch so it never blocks a
 *  generation; tests assert it inserts the expected columns. */
export function insertAiRun(input: AiRunInput, userId = 'local-user'): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(INSERT_SQL)
    .run({
      id,
      user_id: userId,
      novel_id: input.novelId ?? null,
      chapter_number: input.chapterNumber ?? null,
      operation: input.operation,
      role: input.role ?? null,
      connection_kind: input.connectionKind ?? null,
      provider_id: input.providerId ?? null,
      model_id: input.modelId ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      total_tokens: input.totalTokens ?? null,
      first_token_ms: input.firstTokenMs ?? null,
      duration_ms: input.durationMs ?? null,
      outcome: input.outcome,
      est_cost_usd: input.estCostUsd ?? null,
      generated_words: input.generatedWords ?? null,
      created_at: nowIso(),
    });
  return id;
}

/** Backfill the accept signal onto a single run by id. accepted=1 + the word
 *  count of the prose the author kept. Idempotent; a no-op if the id is gone. */
export function markAiRunAccepted(runId: string, acceptedWords: number): void {
  getDb()
    .prepare('UPDATE ai_runs SET accepted = 1, accepted_words = ? WHERE id = ?')
    .run(Math.max(0, Math.round(acceptedWords)), runId);
}

// ── Aggregation ──

export interface AiRunFilters {
  /** Scope to one novel. Omit / null → all novels (including orphaned NULL rows). */
  novelId?: string | null;
  /** Only rows created on/after this ISO timestamp (the time-window control). */
  since?: string | null;
}

/** One operation × model bucket of the cost table. */
export interface AiRunAggregateRow {
  operation: string;
  modelId: string | null;
  providerId: string | null;
  connectionKind: string | null;
  runs: number;
  successes: number;
  failures: number;
  truncated: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Average first-token latency over rows that recorded one (ms). */
  avgFirstTokenMs: number | null;
  /** Average wall-clock duration over rows that recorded one (ms). */
  avgDurationMs: number | null;
  /** Summed estimated cost over PRICED rows only. */
  estCostUsd: number;
  /** Count of rows with a non-null est_cost_usd — drives the "unknown" hint
   *  when some rows in a bucket have no price on file. */
  pricedRuns: number;
}

function buildWhere(filters: AiRunFilters | undefined): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filters?.novelId != null) {
    parts.push('novel_id = ?');
    params.push(filters.novelId);
  }
  if (filters?.since != null) {
    parts.push('created_at >= ?');
    params.push(filters.since);
  }
  return { clause: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

interface AggregateRawRow {
  operation: string;
  model_id: string | null;
  provider_id: string | null;
  connection_kind: string | null;
  runs: number;
  successes: number;
  failures: number;
  truncated: number;
  cancelled: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  avg_first_token_ms: number | null;
  avg_duration_ms: number | null;
  est_cost_usd: number;
  priced_runs: number;
}

/** Aggregate the ledger by operation × model for the panel table. Ordered by
 *  run volume so the operations the author leans on most surface first. */
export function aggregateAiRuns(filters?: AiRunFilters): AiRunAggregateRow[] {
  const { clause, params } = buildWhere(filters);
  const rows = getDb()
    .prepare(
      `SELECT
         operation,
         model_id,
         provider_id,
         connection_kind,
         COUNT(*)                                            AS runs,
         SUM(outcome = 'success')                            AS successes,
         SUM(outcome = 'failed')                             AS failures,
         SUM(outcome = 'truncated')                          AS truncated,
         SUM(outcome = 'cancelled')                          AS cancelled,
         COALESCE(SUM(input_tokens), 0)                      AS input_tokens,
         COALESCE(SUM(output_tokens), 0)                     AS output_tokens,
         COALESCE(SUM(total_tokens), 0)                      AS total_tokens,
         AVG(first_token_ms)                                 AS avg_first_token_ms,
         AVG(duration_ms)                                    AS avg_duration_ms,
         COALESCE(SUM(est_cost_usd), 0)                      AS est_cost_usd,
         SUM(est_cost_usd IS NOT NULL)                       AS priced_runs
       FROM ai_runs
       ${clause}
       GROUP BY operation, model_id, provider_id, connection_kind
       ORDER BY runs DESC, operation`,
    )
    .all(...params) as AggregateRawRow[];

  return rows.map(r => ({
    operation: r.operation,
    modelId: r.model_id,
    providerId: r.provider_id,
    connectionKind: r.connection_kind,
    runs: r.runs,
    successes: r.successes,
    failures: r.failures,
    truncated: r.truncated,
    cancelled: r.cancelled,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalTokens: r.total_tokens,
    avgFirstTokenMs: r.avg_first_token_ms,
    avgDurationMs: r.avg_duration_ms,
    estCostUsd: r.est_cost_usd,
    pricedRuns: r.priced_runs,
  }));
}

/** The headline metric, per model: USD per 1,000 accepted words. */
export interface CostPerKWordRow {
  modelId: string | null;
  providerId: string | null;
  connectionKind: string | null;
  /** Summed cost over PRICED accepted-bearing runs. */
  estCostUsd: number;
  /** Accepted words attributed to this model. */
  acceptedWords: number;
  /** estCostUsd / acceptedWords * 1000. null when acceptedWords is 0 (no signal
   *  yet) or every contributing run is unpriced (cost unknown, not free). */
  costPerKWord: number | null;
  /** True when some contributing accepted rows had no price on file. */
  hasUnpricedRuns: boolean;
}

interface CostPerKWordRawRow {
  model_id: string | null;
  provider_id: string | null;
  connection_kind: string | null;
  est_cost_usd: number;
  accepted_words: number;
  accepted_runs: number;
  priced_accepted_runs: number;
}

/**
 * Cost per 1k accepted words, grouped by model. "Accepted words" come from two
 * sources, in priority order, so the metric works before the live accept-event
 * wiring lands (one-phase degrade per the spec):
 *
 *  1. `ai_runs.accepted_words` when the accept signal rebuilded it.
 *  2. Otherwise the chapter's own `generation_meta.actualWords` (joined by
 *     novel_id + chapter_number) — the words the AI produced for that chapter.
 *
 * Local runs remain in the raw metric for diagnostics, while the writer-facing
 * UI excludes them from provider-cost ranking. If ANY accepted run in a bucket
 * lacks a verified price, costPerKWord is unknown: dividing a partial cost by
 * all accepted words would make that model look deceptively cheap.
 */
export function costPerAcceptedKWord(novelId?: string | null, since?: string | null): CostPerKWordRow[] {
  const params: unknown[] = [];
  let novelClause = '';
  let sinceClause = '';
  if (novelId != null) {
    novelClause = 'AND r.novel_id = ?';
    params.push(novelId);
  }
  if (since != null) {
    sinceClause = 'AND r.created_at >= ?';
    params.push(since);
  }

  const rows = getDb()
    .prepare(
      `SELECT
         r.model_id        AS model_id,
         r.provider_id     AS provider_id,
         r.connection_kind AS connection_kind,
         COALESCE(SUM(r.est_cost_usd), 0)                       AS est_cost_usd,
         COALESCE(SUM(
           COALESCE(
             r.accepted_words,
             r.generated_words,
             CAST(json_extract(c.generation_meta, '$.actualWords') AS INTEGER),
             0
           )
         ), 0)                                                  AS accepted_words,
         COUNT(*)                                               AS accepted_runs,
         SUM(r.est_cost_usd IS NOT NULL)                        AS priced_accepted_runs
       FROM ai_runs r
       LEFT JOIN chapters c
         ON c.novel_id = r.novel_id AND c.chapter_number = r.chapter_number
       WHERE r.outcome = 'success'
         -- Exclude orphaned runs (novel deleted → novel_id NULL): they can't be
         -- joined to a chapter for accepted_words, so an accepted=1 orphan would
         -- add cost with 0 accepted words and inflate the per-kWord denominator.
         AND r.novel_id IS NOT NULL
         AND (
           r.accepted = 1
           OR json_extract(c.generation_meta, '$.actualWords') IS NOT NULL
         )
         ${novelClause}
         ${sinceClause}
       GROUP BY r.model_id, r.provider_id, r.connection_kind
       ORDER BY est_cost_usd DESC`,
    )
    .all(...params) as CostPerKWordRawRow[];

  return rows.map(r => {
    const acceptedWords = r.accepted_words;
    const hasUnpricedRuns = r.priced_accepted_runs < r.accepted_runs;
    const costPerKWord =
      acceptedWords > 0 && !hasUnpricedRuns
        ? (r.est_cost_usd / acceptedWords) * 1000
        : null;
    return {
      modelId: r.model_id,
      providerId: r.provider_id,
      connectionKind: r.connection_kind,
      estCostUsd: r.est_cost_usd,
      acceptedWords,
      costPerKWord,
      hasUnpricedRuns,
    };
  });
}
