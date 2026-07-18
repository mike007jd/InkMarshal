import type { LanguageModel } from 'ai';

import { AI_ERROR_I18N_KEYS, AIUsageError, classifyAIError } from '@/lib/ai-error';
import { headerValue } from '@/lib/ai-providers';
import { isLoopbackHost } from '@/lib/loopback-hosts';
import { resolveModelForRole } from '@/lib/model-supply/server-resolve';
import {
  OPERATION_ROLE,
  isRuntimeConnectionKind,
  type CapabilityRole,
  type OperationKind,
  type RuntimeConnectionKind,
} from '@/lib/model-supply/types';
import type { RuntimeModelDescriptor } from '@/lib/runtime-models';
import { createFinalTextCapture } from '@/lib/streaming-helpers';
import { classifyOutcome, estimateCostUsd } from '@/lib/ai-runs';
import { insertAiRun, type AiRunInput } from '@/lib/db/queries-ai-runs';
import { resolvePricing } from '@/lib/pricing';
import { estimateTokens } from '@/lib/token-budget';
import { countWords } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { requestLocale } from '@/lib/request-locale';

export { AIUsageError } from '@/lib/ai-error';

/**
 * The writing operations the AI layer dispatches. Defined as B.1's
 * {@link OperationKind} so the operation→role contract is one source of truth
 * (`OPERATION_ROLE`): the alias makes the equivalence machine-checked — adding
 * an operation in B.1 surfaces here, and any divergence is a tsc error rather
 * than a silent mismatch. (Not a hand-maintained second copy of the union.)
 *
 * - chat      → draft     (story chat)
 * - outline   → planning  (greenlight + book blueprint)
 * - chapter   → draft     (primary chapter prose / continue)
 * - polish    → rewrite   (edit / rewrite inside Writer Desk)
 * - summarize → recall    (post-chapter rolling-memory digest)
 * - validate  → recall    (post-chapter consistency QA)
 * - unify     → rewrite   (whole-book unification pass)
 */
export type AIUsageOperation = OperationKind;

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AIUsageSettlementInput {
  outcome: AiRunInput['outcome'];
  usage?: ProviderUsage;
  finishReason?: string;
  errorKind?: string;
}

export interface AIUsageSession {
  model: LanguageModel;
  runtimeModel: RuntimeModelDescriptor;
  addPromptText(text: string): void;
  addPartialOutput(text: string): void;
  /** The single terminal API for every started provider call. */
  settle(input: AIUsageSettlementInput): Promise<void>;
  recordUsage(usage: ProviderUsage | undefined, finishReason?: string): Promise<void>;
  /** Terminal: the provider/stream errored. Records `failed`. */
  fail(): Promise<void>;
  /** Terminal: the user aborted / the client disconnected (AI-01). Records
   *  `cancelled` — distinct from `failed` — and still costs any reported tokens. */
  cancel(usage?: ProviderUsage): Promise<void>;
}

export interface UsageSettlement {
  failOnce(): Promise<void>;
  cancelOnce(usage?: ProviderUsage): Promise<void>;
  recordOnce(usage: ProviderUsage | undefined, finishReason?: string): Promise<void>;
  isSettled(): boolean;
}

export function createUsageSettlement(
  session: Pick<AIUsageSession, 'settle'>,
): UsageSettlement {
  let settled = false;
  return {
    async failOnce() {
      if (settled) return;
      settled = true;
      await session.settle({ outcome: 'failed' });
    },
    async cancelOnce(usage) {
      if (settled) return;
      settled = true;
      await session.settle({ outcome: 'cancelled', usage });
    },
    async recordOnce(usage, finishReason) {
      if (settled) return;
      settled = true;
      await session.settle({
        outcome: classifyOutcome({ finishReason }),
        usage,
        finishReason,
      });
    },
    isSettled: () => settled,
  };
}

export interface AIStreamLifecycle {
  signal: AbortSignal;
  cancel(): void;
  isCancelled(): boolean;
}

export function createAIStreamLifecycle(requestSignal?: AbortSignal): AIStreamLifecycle {
  const controller = new AbortController();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (!controller.signal.aborted) controller.abort();
  };
  if (requestSignal?.aborted) {
    cancel();
  } else {
    requestSignal?.addEventListener('abort', cancel, { once: true });
  }
  return {
    signal: controller.signal,
    cancel,
    isCancelled: () => cancelled || controller.signal.aborted || requestSignal?.aborted === true,
  };
}

export function streamTextWithAIUsageCleanup(
  textStream: AsyncIterable<string>,
  session: AIUsageSession,
  signal?: AbortSignal,
  options: { onCancel?: () => void | Promise<void> } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // One terminal settlement wins (exactly-once at this layer; the session also
  // latches). An abort or a consumer stream-cancel settles as `cancelled`; a
  // provider/stream throw settles as `failed`.
  let settled = false;
  const settleOnce = async (run: () => Promise<void>) => {
    if (settled) return;
    settled = true;
    await run();
  };
  const failOnce = () => settleOnce(() => session.settle({ outcome: 'failed' }));
  const cancelOnce = () => settleOnce(() => session.settle({ outcome: 'cancelled' }));
  return new ReadableStream({
    async start(controller) {
      let errored = false;
      try {
        for await (const chunk of textStream) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(chunk));
        }
        if (signal?.aborted) {
          await cancelOnce();
        }
      } catch (error) {
        errored = true;
        if (signal?.aborted) await cancelOnce();
        else await failOnce();
        controller.error(error);
      } finally {
        if (!errored) {
          try { controller.close(); } catch { /* already closed */ }
        }
      }
    },
    async cancel() {
      const results = await Promise.allSettled([
        options.onCancel?.(),
        cancelOnce(),
      ]);
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    },
  });
}

/**
 * The finalText + finishReason capture and the onFinish/onError settlement glue
 * that the single-text streaming routes (chapter continue, rewrite) wire into
 * `streamText`. Both routes carried this byte-for-byte; the logic is subtle
 * (zero-delta hang, double-record race, lock-TTL), so it lives in one place and
 * is unit-tested directly rather than asserted as source strings per route.
 *
 * - `recordFinish` / `recordError` go straight to `streamText`'s onFinish/onError.
 * - `framing` goes straight to {@link frameTextStreamWithCleanup}.
 * - `abandon` settles the finishReason promise when `streamText` throws
 *   synchronously before any callback fires, so a downstream consumer awaiting
 *   it can't hang.
 */
export interface StreamUsageCapture {
  framing: { finalText: Promise<string>; finishReason: Promise<string | undefined> };
  recordFinish(event: { text: string; usage?: ProviderUsage; finishReason?: string }): Promise<void>;
  recordError(error: unknown): void;
  abandon(): void;
}

export function createStreamUsageCapture(
  aiUsage: Pick<AIUsageSession, 'addPartialOutput' | 'settle'>,
  lifecycle: Pick<AIStreamLifecycle, 'isCancelled'>,
): StreamUsageCapture {
  const finalText = createFinalTextCapture();
  let usageSettled = false;
  let resolveFinishReason: (reason: string | undefined) => void = () => {};
  const finishReason = new Promise<string | undefined>(resolve => { resolveFinishReason = resolve; });
  return {
    framing: { finalText: finalText.promise, finishReason },
    async recordFinish({ text, usage, finishReason: reason }) {
      resolveFinishReason(reason);
      try {
        aiUsage.addPartialOutput(text);
        if (!usageSettled) {
          usageSettled = true;
          // A cancelled stream still delivered a finish event with reported
          // usage — record it as `cancelled` (AI-01) so the run is settled
          // exactly once and its already-consumed tokens/cost are attributed,
          // rather than dropping the row entirely.
          if (lifecycle.isCancelled()) {
            await aiUsage.settle({ outcome: 'cancelled', usage, finishReason: reason });
          } else {
            await aiUsage.settle({
              outcome: classifyOutcome({ finishReason: reason }),
              usage,
              finishReason: reason,
            });
          }
        }
        finalText.resolve(text);
      } catch (error) {
        finalText.reject(error);
        throw error;
      }
    },
    recordError(error) {
      // Without this, a provider that errors before any step completes never
      // settles finalText — the zero-delta fallback in frameTextStreamWithCleanup
      // awaits it forever, hanging the stream and holding the writing lock until
      // its TTL. Reject so the framed stream emits an `error` frame and releases
      // the lock immediately, and fail the usage session if it wasn't recorded.
      finalText.reject(error);
      resolveFinishReason('error');
      if (!usageSettled) {
        usageSettled = true;
        void aiUsage.settle({
          outcome: lifecycle.isCancelled() ? 'cancelled' : 'failed',
          finishReason: 'error',
          errorKind: error instanceof Error ? error.name : 'unknown',
        }).catch(() => undefined);
      }
    },
    abandon() {
      resolveFinishReason(undefined);
    },
  };
}

/** Immutable per-call context the session needs to write its ai_runs row. */
interface AIUsageSessionContext {
  userId: string;
  operation: AIUsageOperation;
  role: CapabilityRole;
  connectionKind: RuntimeConnectionKind | null;
  novelId: string | null;
  chapterNumber: number | null;
}

/**
 * The real session: every settled call (success/truncated via {@link recordUsage}
 * or failed/cancelled via {@link fail}) appends ONE row to ai_runs, powering the
 * local cost panel. Token counts prefer the provider's {@link ProviderUsage};
 * when the provider omits them we fall back to a rough character estimate of the
 * accumulated prompt/output text (estimateTokens) so a row is never blank.
 *
 * HARD RULE: persistence is best-effort and MUST NEVER throw into the caller —
 * a ledger write failing can't be allowed to abort a generation. Every DB touch
 * is wrapped; failures are swallowed. (better-sqlite3 INSERTs are microsecond-
 * scale, so this is a guard, not a hot path.)
 */
class UserOwnedAIUsageSession implements AIUsageSession {
  private promptTokensEst = 0;
  private outputTokensEst = 0;
  /** Longest output text seen via addPartialOutput (callers pass cumulative OR
   *  delta; max-wins like outputTokensEst). Used to compute generated_words so
   *  the cost-per-kWord metric attributes this run from its OWN word count. */
  private outputText = '';
  private readonly startedAtMs = Date.now();
  private firstOutputAtMs: number | null = null;
  /** Latches once a terminal row is written so a late fail/record can't double-log. */
  private settled = false;

  constructor(
    public readonly model: LanguageModel,
    public readonly runtimeModel: RuntimeModelDescriptor,
    private readonly context: AIUsageSessionContext,
  ) {}

  addPromptText(text: string): void {
    if (text) this.promptTokensEst += estimateTokens(text);
  }

  addPartialOutput(text: string): void {
    if (!text) return;
    if (this.firstOutputAtMs === null) this.firstOutputAtMs = Date.now();
    // addPartialOutput is sometimes called with the FULL cumulative text and
    // sometimes with a delta; we only use this as a token fallback when the
    // provider returns no usage, so the latest call (largest text) wins rather
    // than summing — avoids double-counting cumulative callers. The same
    // max-wins rule gives us the generated prose for generated_words.
    this.outputTokensEst = Math.max(this.outputTokensEst, estimateTokens(text));
    if (text.length > this.outputText.length) this.outputText = text;
  }

  /** Single terminal write, latched so a call settles exactly once (AI-01). */
  async settle(input: AIUsageSettlementInput): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.persist(input.usage, input.outcome);
  }

  async recordUsage(usage?: ProviderUsage, finishReason?: string): Promise<void> {
    // Thread the stream's finishReason so a 'length'/'max_tokens' stop lands as
    // 'truncated' (not 'success') in the ledger — that's what powers the cost
    // panel's truncation rate.
    await this.settle({ outcome: classifyOutcome({ finishReason }), usage, finishReason });
  }

  async fail(): Promise<void> {
    await this.settle({ outcome: 'failed' });
  }

  async cancel(usage?: ProviderUsage): Promise<void> {
    // User abort / client disconnect: distinct from a provider failure so the
    // panel's cancel rate is real, and still costs whatever tokens the provider
    // reported before the cancel (a cancelled remote call already spent them).
    await this.settle({ outcome: 'cancelled', usage });
  }

  /** Build + insert the row. Pure best-effort: any throw is swallowed. */
  private persist(usage: ProviderUsage | undefined, outcome: AiRunInput['outcome']): void {
    try {
      const inputTokens = usage?.inputTokens ?? (this.promptTokensEst || null);
      const outputTokens = usage?.outputTokens ?? (this.outputTokensEst || null);
      const totalTokens =
        usage?.totalTokens ??
        (inputTokens != null || outputTokens != null
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : null);

      const pricing = resolvePricing(this.runtimeModel.providerId, this.runtimeModel.model);
      // Cost every outcome from whatever tokens were reported/estimated — a
      // truncated or cancelled remote call already consumed (and was billed for)
      // its tokens, so gating cost on `success` under-counted real spend (AI-01).
      // estimateCostUsd still returns 0 for local and null when pricing is absent.
      const estCostUsd = estimateCostUsd(
        { inputTokens: inputTokens ?? undefined, outputTokens: outputTokens ?? undefined },
        pricing,
        this.context.connectionKind,
      );

      const firstTokenMs =
        this.firstOutputAtMs !== null ? this.firstOutputAtMs - this.startedAtMs : null;

      insertAiRun(
        {
          novelId: this.context.novelId,
          chapterNumber: this.context.chapterNumber,
          operation: this.context.operation,
          role: this.context.role,
          connectionKind: this.context.connectionKind,
          providerId: this.runtimeModel.providerId,
          modelId: this.runtimeModel.model,
          inputTokens,
          outputTokens,
          totalTokens,
          firstTokenMs,
          durationMs: Date.now() - this.startedAtMs,
          outcome,
          estCostUsd,
          // Capture the run's own generated word count so cost-per-kWord
          // attributes this run from itself, not the mutable chapters row.
          generatedWords: this.outputText ? countWords(this.outputText) : null,
        },
        this.context.userId,
      );
    } catch {
      // Ledger writes must never break a generation. Swallow and move on.
    }
  }
}

/**
 * Read the user-runtime connection kind (local / provider / custom) for a role
 * from the request headers, mirroring server-resolve's role-prefix selection:
 * `x-im-kind` when the single-role header matches, else `x-im-{role}-kind`. When
 * no explicit kind is present, infer `local` for a loopback base URL (the
 * bundled engine path) so local calls are correctly costed at 0 even if the
 * client omitted the kind header. Returns null when undeterminable.
 */
export function connectionKindFromRequest(req: Request, role: CapabilityRole): RuntimeConnectionKind | null {
  const headerRole = headerValue(req, 'x-im-role');
  const prefix = headerRole === role ? 'x-im' : `x-im-${role}`;
  const baseUrl = headerValue(req, `${prefix}-base-url`);
  if (baseUrl) {
    try {
      if (isLoopbackHost(new URL(baseUrl).hostname)) return 'local';
    } catch {
      // Unparseable base URL — fall through to null.
    }
  }
  const raw = headerValue(req, `${prefix}-kind`);
  if (isRuntimeConnectionKind(raw)) return raw;
  return null;
}

export async function createAIUsageSession(
  request: Request,
  options: {
    userId: string;
    operation: AIUsageOperation;
    /** Optional novel scope — additive; an unprovided value logs novel_id NULL.
     *  Routes thread these so the panel can filter/attribute per novel + chapter. */
    novelId?: string | null;
    chapterNumber?: number | null;
  },
): Promise<AIUsageSession> {
  if (!options.userId) {
    throw new AIUsageError('Local user context missing', 500);
  }

  // Role-aware (`x-im-*`) resolution from the user's capability bindings.
  // There is no server-owned cloud/env fallback; every remote provider must be
  // explicitly user-owned.
  const role = OPERATION_ROLE[options.operation];
  const resolved = await resolveModelForRole(request, role);
  if (!resolved) {
    const t = getTranslations(requestLocale(request.headers));
    throw new AIUsageError(
      t[AI_ERROR_I18N_KEYS.local_engine],
      503,
      'local_engine',
    );
  }

  const { model, runtimeModel } = resolved;
  return new UserOwnedAIUsageSession(model, runtimeModel, {
    userId: options.userId,
    operation: options.operation,
    role,
    connectionKind: connectionKindFromRequest(request, role),
    novelId: options.novelId ?? null,
    chapterNumber: options.chapterNumber ?? null,
  });
}

export function aiUsageErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AIUsageError)) return null;
  return Response.json(
    { error: error.message, aiError: classifyAIError(error) },
    { status: error.status },
  );
}
