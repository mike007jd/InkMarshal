'use client';

import {
  clearCapabilityBinding,
  getBindingForRole,
  getCapabilityProfile,
  getConnection,
  getConnections,
  removeConnection,
  saveCapabilityBinding,
  upsertConnection,
} from '@/lib/model-supply/connections';
import {
  isLocalEngineConnectionId,
  localEngineConnectionId,
  startAndRegisterLocalEngine,
} from '@/lib/model-supply/local-engine';
import {
  CAPABILITY_ROLES,
  type CapabilityRole,
  type RuntimeConnection,
} from '@/lib/model-supply/types';
import {
  getStoredSetting,
  removeStoredSetting,
  setStoredSetting,
} from '@/lib/app-settings-client';
import {
  engineEstimateFootprint,
  engineResourceBudget,
  engineStatus,
  engineStop,
  listInstalledLocalModels,
  stopOthersForPath,
  type EngineBudget,
  type EngineFormat,
  type EngineInfo,
} from '@/lib/desktop-runtime';

// ── Wave 4 — multi-engine orchestration ─────────────────────────────────────
//
// One running engine == one RuntimeConnection row (connectionId derived from
// the Rust engineId). Roles are bound independently — `startEngineForRoles`
// only touches the roles in its `plan.roles` list, never the others. This is
// the key behavior change from the wave-3 single-engine "one-shot bind 4
// roles" world: an explicit launch for `draft` MUST NOT unbind `rewrite`.

/** Plan for starting (or reusing) one engine and binding the supplied roles. */
export interface EngineStartPlan {
  modelPath: string;
  format: EngineFormat;
  modelLabel: string;
  /** Capability roles to bind to the new (or reused) engine. */
  roles: readonly CapabilityRole[];
  /** Optional disambiguator so the same model can be launched twice. */
  engineLabel?: string;
  /**
   * Strategy when the RAM budget is insufficient:
   *  - `replace` — stop all other engines for the same model_path and retry.
   *  - `reuse`   — reuse the existing engine for this model_path (no new start);
   *                its connectionId is used to bind the requested roles.
   *  - `cancel`  — abort and throw {@link QuotaConflict} (the UI decides).
   * Defaults to `cancel` so an unhandled OOM never crashes the engine pool.
   */
  onConflict?: 'replace' | 'reuse' | 'cancel';
}

/** Result of a successful {@link startEngineForRoles}. */
export interface EngineStartResult {
  connection: RuntimeConnection;
  modelId: string;
  engineId: string;
  footprintBytes: number;
  /** Roles that were actually (re)bound by this call. */
  boundRoles: CapabilityRole[];
  /** True when an existing engine was reused (no new process spawned). */
  reused: boolean;
}

/** Detail attached to a {@link QuotaConflict} so the UI can render the choice. */
export interface QuotaConflictDetail {
  modelPath: string;
  /** RAM the requested engine needs (bytes). */
  requiredBytes: number;
  /** RAM currently available after running engines + OS reservation. */
  availableBytes: number;
  /** RAM the OS keeps reserved for itself. */
  reservedForOsBytes: number;
  /** Snapshot of the running engines at the moment of the conflict. */
  running: EngineBudget['running'];
  /** Subset of `running` whose modelPath equals the requested modelPath. */
  conflicting: EngineBudget['running'];
}

/**
 * Thrown when the resource budget cannot fit a new engine and the caller did
 * not opt into `replace`/`reuse`. The UI catches this and renders the three-way
 * conflict dialog.
 */
export class QuotaConflict extends Error {
  readonly detail: QuotaConflictDetail;
  constructor(detail: QuotaConflictDetail) {
    super(
      `Cannot fit a new engine: needs ${detail.requiredBytes} bytes, only ${detail.availableBytes} available`,
    );
    this.name = 'QuotaConflict';
    this.detail = detail;
  }
}

interface EngineBudgetExceeded {
  requiredBytes?: number;
  availableBytes?: number;
  reservedForOsBytes?: number;
}

/**
 * Parse the structured payload Rust's atomic admit emits when it rejects an
 * over-budget start (engine.rs `admit_engine`). The `ENGINE_BUDGET_EXCEEDED:<json>`
 * shape is a fixed single-consumer contract between admit_engine and this
 * resolver — the Rust admit lock is the authoritative budget gate, so a reject
 * here means a concurrent launch won the race after the advisory TS checks
 * passed. Returns null for any other error.
 */
function parseEngineBudgetExceeded(err: unknown): EngineBudgetExceeded | null {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const prefix = 'ENGINE_BUDGET_EXCEEDED:';
  const idx = msg.indexOf(prefix);
  if (idx === -1) return null;
  try {
    return JSON.parse(msg.slice(idx + prefix.length)) as EngineBudgetExceeded;
  } catch {
    return null;
  }
}

/**
 * Start (or reuse) one engine for a model and bind the requested roles to it.
 * Crucially this does NOT clear bindings outside `plan.roles` — calling it for
 * a focused subset (e.g. just `['draft']`) leaves `rewrite`/`planning`/`recall`
 * pointing wherever they were.
 */
export async function startEngineForRoles(
  plan: EngineStartPlan,
): Promise<EngineStartResult> {
  const policy = plan.onConflict ?? 'cancel';

  // 1. Estimate footprint (best-effort). If estimation fails we proceed with
  //    `required = 0` rather than failing the launch — the user can still
  //    decide to start; we surface the estimation error only as a budget hint.
  let requiredBytes = 0;
  try {
    const footprint = await engineEstimateFootprint(plan.modelPath, plan.format);
    requiredBytes = footprint.ramBytes;
  } catch {
    // Best-effort: a missing/locked model file is surfaced by engineStart itself
    // with a precise message; skipping the admit-check here just means the
    // budget conflict-dialog won't trigger for an unmeasurable bundle. Leaving
    // `requiredBytes` at its initial 0 admits the launch without a budget check.
  }

  // 2. Check budget. If there is already a running engine for this exact
  //    modelPath we can `reuse` it without spending RAM.
  const budget = await engineResourceBudget();
  const requestedPath = normalizeModelPathForCompare(plan.modelPath);
  const conflicting = budget.running.filter(r => normalizeModelPathForCompare(r.modelPath) === requestedPath);
  const alreadyRunning = await findRunningForPath(plan.modelPath, plan.engineLabel);

  if (alreadyRunning) {
    // Reuse path: bind the requested roles to the existing connection row.
    const connection = ensureLocalEngineConnection(alreadyRunning, plan.modelLabel);
    const boundRoles = bindRolesToConnection(plan.roles, connection.id, plan.modelLabel);
    persistEngineLaunchPlan(plan, alreadyRunning.engineId);
    return {
      connection,
      modelId: plan.modelLabel,
      engineId: alreadyRunning.engineId,
      footprintBytes: alreadyRunning.footprintBytes ?? 0,
      boundRoles,
      reused: true,
    };
  }

  // 3. Budget admission — only run when there is no already-running instance
  //    we could reuse (otherwise we'd block a free reuse on a missing budget).
  //    NOTE: `budget` above is ADVISORY — between this read and the spawn at
  //    step 5 a parallel autoBind/launch can start another engine. We re-read
  //    and re-validate immediately before spawning (step 4) to close the TOCTOU.
  if (requiredBytes > budget.availableRamBytes) {
    // `replace` stops everything sharing the model_path (freeing RAM) and only
    // then is allowed to proceed; every other outcome throws the conflict.
    let replaced = false;
    if (policy === 'replace') {
      // Stop everything that shares the model_path and drop the now-stale
      // local-engine connection rows so health probes don't hammer dead ports.
      // The Rust side canonicalizes the path before matching; do not rely on
      // this layer's raw string comparison to decide whether a replacement exists.
      const stopped = await stopOthersForPath(plan.modelPath);
      await pruneStaleLocalEngineRows();
      replaced = stopped > 0;
    }
    if (!replaced) {
      throw new QuotaConflict({
        modelPath: plan.modelPath,
        requiredBytes,
        availableBytes: budget.availableRamBytes,
        reservedForOsBytes: budget.reservedForOsBytes,
        running: budget.running,
        conflicting,
      });
    }
  }

  // 4. Re-read the budget immediately before spawning and re-validate. The
  //    step-2 snapshot is stale: a concurrent launch may have admitted an
  //    engine since, and the `replace` branch above only verified `stopped > 0`
  //    — not that the freed RAM now actually fits `requiredBytes`. Without this
  //    the pool can over-admit and OOM, or `replace` can stop a sibling yet
  //    still not fit, leaving the user with neither engine. This is the single
  //    authoritative TS-side admit-check before `engineStart`.
  if (requiredBytes > 0) {
    let freshBudget: EngineBudget;
    try {
      freshBudget = await engineResourceBudget();
    } catch {
      // If the budget command itself fails we fall back to the advisory read
      // rather than blocking a launch the user explicitly requested.
      freshBudget = budget;
    }
    if (requiredBytes > freshBudget.availableRamBytes) {
      const freshConflicting = freshBudget.running.filter(
        r => normalizeModelPathForCompare(r.modelPath) === requestedPath,
      );
      throw new QuotaConflict({
        modelPath: plan.modelPath,
        requiredBytes,
        availableBytes: freshBudget.availableRamBytes,
        reservedForOsBytes: freshBudget.reservedForOsBytes,
        running: freshBudget.running,
        conflicting: freshConflicting,
      });
    }
  }

  // 5. Spawn the engine + upsert its dedicated connection row. The Rust admit
  //    lock is the authoritative budget gate: if a concurrent launch won the
  //    race after our TS checks passed, engine_start rejects with
  //    ENGINE_BUDGET_EXCEEDED — surface it as the same conflict dialog the TS
  //    checks would, rather than leaking a raw error string to the UI.
  try {
    const started = await startAndRegisterLocalEngine(
      plan.modelPath,
      plan.format,
      plan.modelLabel,
      { engineLabel: plan.engineLabel },
    );
    const boundRoles = bindRolesToConnection(plan.roles, started.connection.id, plan.modelLabel);
    persistEngineLaunchPlan(plan, started.engineId);
    return {
      connection: started.connection,
      modelId: started.modelId,
      engineId: started.engineId,
      footprintBytes: started.footprintBytes,
      boundRoles,
      reused: false,
    };
  } catch (err) {
    const exceeded = parseEngineBudgetExceeded(err);
    if (!exceeded) throw err;
    const snapshot = await engineResourceBudget().catch(() => budget);
    throw new QuotaConflict({
      modelPath: plan.modelPath,
      requiredBytes: exceeded.requiredBytes ?? requiredBytes,
      availableBytes: exceeded.availableBytes ?? snapshot.availableRamBytes,
      reservedForOsBytes: exceeded.reservedForOsBytes ?? snapshot.reservedForOsBytes,
      running: snapshot.running,
      conflicting: snapshot.running.filter(
        r => normalizeModelPathForCompare(r.modelPath) === requestedPath,
      ),
    });
  }
}

/**
 * Stop one running engine and clear every capability binding that pointed at
 * it. Other engines (and the bindings they own) are untouched.
 */
export async function stopEngineAndUnbind(engineId: string): Promise<void> {
  const connectionId = localEngineConnectionId(engineId);
  // An explicit stop is a user decision — drop the launch plan so the next
  // app boot doesn't resurrect an engine the user shut down on purpose.
  removeEngineLaunchPlanByEngineId(engineId);
  try {
    await engineStop(engineId);
  } catch {
    // engine_stop is idempotent on the Rust side; a stop-after-stop is fine.
  }
  // Clear bindings that pointed at this connection (independent of role).
  const profile = getCapabilityProfile();
  for (const role of CAPABILITY_ROLES) {
    const binding = profile[role];
    if (binding?.connectionId === connectionId) {
      clearCapabilityBinding(role);
    }
  }
  // Remove the now-stale connection row so health probes don't keep hammering
  // a dead localhost port. removeConnection is async because it deletes the
  // (non-existent) secret too — await so the UI re-render sees the gone row.
  await removeConnection(connectionId);
}

/**
 * Snapshot of which engine each capability role is currently routed through.
 * Only roles bound to a local-engine connection appear in the map; roles bound
 * to a provider (OpenAI / Anthropic / custom) are deliberately omitted — those
 * are not "engines" in the local-process sense.
 */
export function listRoleEngineBindings(): Map<
  CapabilityRole,
  { engineId: string; connectionId: string; modelId: string }
> {
  const out = new Map<
    CapabilityRole,
    { engineId: string; connectionId: string; modelId: string }
  >();
  const profile = getCapabilityProfile();
  for (const role of CAPABILITY_ROLES) {
    const binding = profile[role];
    if (!binding) continue;
    if (!isLocalEngineConnectionId(binding.connectionId)) continue;
    const engineId = engineIdFromConnectionId(binding.connectionId);
    if (!engineId) continue;
    out.set(role, {
      engineId,
      connectionId: binding.connectionId,
      modelId: binding.modelId,
    });
  }
  return out;
}

/**
 * Thin wrapper over {@link startEngineForRoles} that binds every capability
 * role to the started engine. Used by the first-run wizard's
 * "download a starter model → bind all roles" convenience; the Models panel
 * uses {@link startEngineForRoles} with an explicit role set so it controls
 * exactly which roles are touched.
 */
export async function startAndBindLocalEngine(
  modelPath: string,
  format: EngineFormat,
  modelLabel: string,
  roles: readonly CapabilityRole[] = CAPABILITY_ROLES,
): Promise<{ connection: RuntimeConnection; modelId: string }> {
  const result = await startEngineForRoles({
    modelPath,
    format,
    modelLabel,
    roles,
    onConflict: 'reuse',
  });
  return { connection: result.connection, modelId: result.modelId };
}

/**
 * Clear only bindings owned by a local-engine connection (any id minted by
 * {@link localEngineConnectionId}, plus the legacy single-row id). Provider
 * and custom-endpoint bindings survive.
 */
export function clearLocalEngineBindings(
  roles: readonly CapabilityRole[] = CAPABILITY_ROLES,
): void {
  for (const role of roles) {
    const binding = getBindingForRole(role);
    if (binding && isLocalEngineConnectionId(binding.connectionId)) {
      clearCapabilityBinding(role);
    }
  }
}

/**
 * Detect bindings that point at connections / models that no longer exist.
 * Returns the list of dangling roles so the UI can render diagnostics or
 * clear only those stale bindings.
 */
export function findDanglingBindings(
  knownConnectionIds: ReadonlySet<string>,
  roles: readonly CapabilityRole[] = CAPABILITY_ROLES,
): CapabilityRole[] {
  const dangling: CapabilityRole[] = [];
  for (const role of roles) {
    const binding = getBindingForRole(role);
    if (!binding) continue;
    if (!knownConnectionIds.has(binding.connectionId)) {
      dangling.push(role);
    }
  }
  return dangling;
}

export function clearDanglingBindings(
  knownConnectionIds: ReadonlySet<string>,
  roles: readonly CapabilityRole[] = CAPABILITY_ROLES,
): CapabilityRole[] {
  const dangling = findDanglingBindings(knownConnectionIds, roles);
  for (const role of dangling) clearCapabilityBinding(role);
  return dangling;
}

// ── Engine relaunch on app boot ─────────────────────────────────────────────
//
// Local engines are child processes of the Tauri app: every quit kills them,
// but the capability bindings (localStorage) survive. Without relaunch the
// user lands in a "bound but dead" state after EVERY restart and must
// manually re-launch from the Models panel. We persist each successful launch
// plan and replay it on boot, then prune whatever could not be restored so
// the status surfaces show the truthful unbound state instead of a zombie.

const ENGINE_LAUNCH_PLANS_KEY = 'inkmarshal_engine_launch_plans_v1';

interface PersistedEnginePlan {
  modelPath: string;
  format: EngineFormat;
  modelLabel: string;
  roles: CapabilityRole[];
  engineLabel?: string;
  /** engineId of the live process this plan last produced. */
  engineId: string;
}

function planKey(modelPath: string, engineLabel: string | undefined): string {
  return `${normalizeModelPathForCompare(modelPath)}|${engineLabel ?? ''}`;
}

function readEngineLaunchPlans(): PersistedEnginePlan[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = getStoredSetting(ENGINE_LAUNCH_PLANS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is PersistedEnginePlan =>
      Boolean(p) && typeof p === 'object'
      && typeof (p as PersistedEnginePlan).modelPath === 'string'
      && typeof (p as PersistedEnginePlan).modelLabel === 'string'
      && typeof (p as PersistedEnginePlan).engineId === 'string'
      && Array.isArray((p as PersistedEnginePlan).roles),
    );
  } catch {
    return [];
  }
}

function writeEngineLaunchPlans(plans: PersistedEnginePlan[]): void {
  if (typeof window === 'undefined') return;
  if (plans.length === 0) removeStoredSetting(ENGINE_LAUNCH_PLANS_KEY);
  else setStoredSetting(ENGINE_LAUNCH_PLANS_KEY, JSON.stringify(plans));
}

function persistEngineLaunchPlan(plan: EngineStartPlan, engineId: string): void {
  const key = planKey(plan.modelPath, plan.engineLabel);
  const plans = readEngineLaunchPlans().filter(
    p => planKey(p.modelPath, p.engineLabel) !== key,
  );
  plans.push({
    modelPath: plan.modelPath,
    format: plan.format,
    modelLabel: plan.modelLabel,
    roles: [...plan.roles],
    engineLabel: plan.engineLabel,
    engineId,
  });
  writeEngineLaunchPlans(plans);
}

function removeEngineLaunchPlanByEngineId(engineId: string): void {
  const plans = readEngineLaunchPlans();
  const next = plans.filter(p => p.engineId !== engineId);
  if (next.length !== plans.length) writeEngineLaunchPlans(next);
}

let restoreEnginesPromise: Promise<void> | null = null;

/**
 * Relaunch the engines that were running when the app last quit and re-bind
 * the roles that still point at (now-dead) local-engine connections. Roles
 * the user re-bound to a provider in the meantime are left alone. Plans whose
 * model file has been deleted are dropped. Always finishes with a stale-row
 * prune so anything unrestorable surfaces as honestly unbound. Idempotent —
 * concurrent callers share one run per app session.
 */
export function restoreEnginesOnLaunch(): Promise<void> {
  restoreEnginesPromise ??= (async () => {
    const plans = readEngineLaunchPlans();
    if (plans.length === 0) {
      await pruneStaleLocalEngineRows();
      return;
    }
    let running: EngineInfo[];
    try {
      running = await engineStatus();
    } catch {
      return; // No desktop runtime (web preview) — nothing to restore.
    }
    const runningIds = new Set(running.map(e => e.engineId));

    let installedPaths: Set<string> | null = null;
    try {
      const installed = await listInstalledLocalModels();
      installedPaths = new Set(installed.map(m => normalizeModelPathForCompare(m.modelPath)));
    } catch {
      installedPaths = null; // Unknown — let engineStart be the arbiter.
    }
    for (const plan of plans) {
      if (runningIds.has(plan.engineId)) continue;
      if (installedPaths && !installedPaths.has(normalizeModelPathForCompare(plan.modelPath))) {
        // Model file is gone — never retry this plan again.
        removeEngineLaunchPlanByEngineId(plan.engineId);
        continue;
      }
      // Only re-bind roles still routed through a local engine; a role the
      // user moved to a cloud provider after the engine died stays put.
      const roles = plan.roles.filter(role => {
        const binding = getBindingForRole(role);
        return binding != null && isLocalEngineConnectionId(binding.connectionId);
      });
      if (roles.length === 0) {
        removeEngineLaunchPlanByEngineId(plan.engineId);
        continue;
      }
      try {
        await startEngineForRoles({
          modelPath: plan.modelPath,
          format: plan.format,
          modelLabel: plan.modelLabel,
          roles,
          engineLabel: plan.engineLabel,
          onConflict: 'reuse',
        });
      } catch {
        // OOM / engine failure — keep the plan (a later manual launch heals
        // it); the prune below clears the dead binding so the UI is truthful.
      }
    }
    await pruneStaleLocalEngineRows();
  })().catch(() => {
    // Restoration is best-effort; failures degrade to the manual launch flow.
    // Reset the cached promise so a later call (e.g. after the runtime
    // recovers) actually retries instead of resolving to this no-op forever.
    restoreEnginesPromise = null;
  });
  return restoreEnginesPromise;
}

// ── internals ───────────────────────────────────────────────────────────────

function engineIdFromConnectionId(connectionId: string): string | null {
  const prefix = 'local-engine:';
  if (!connectionId.startsWith(prefix)) return null;
  return connectionId.slice(prefix.length);
}

async function findRunningForPath(
  modelPath: string,
  engineLabel: string | undefined,
): Promise<EngineInfo | null> {
  try {
    const engines = await engineStatus();
    const requestedPath = normalizeModelPathForCompare(modelPath);
    // engineLabel filters the disambiguator — a "polish" instance does not get
    // reused as a "draft" instance even when modelPath matches.
    const match = engines.find(
      e =>
        normalizeModelPathForCompare(e.modelPath) === requestedPath &&
        (engineLabel ? e.engineLabel === engineLabel : !e.engineLabel),
    );
    return match ?? null;
  } catch {
    return null;
  }
}

export function normalizeModelPathForCompare(path: string): string {
  let value = path.trim().replace(/\\/g, '/');
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

function ensureLocalEngineConnection(
  engine: EngineInfo,
  modelLabel: string,
): RuntimeConnection {
  const id = localEngineConnectionId(engine.engineId);
  const existing = getConnection(id);
  if (existing) return existing;
  // The engine is already running (otherwise we wouldn't be reusing) but its
  // connection row was somehow missing — recreate it inline rather than re-
  // upserting through local-engine (which would re-engineStart and bypass
  // budget).
  const labelSuffix = engine.engineLabel ? ` · ${engine.engineLabel}` : '';
  return upsertConnection({
    id,
    label: `Local engine · ${modelLabel}${labelSuffix}`,
    kind: 'local',
    transport: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${engine.port}/v1`,
    secretRef: null,
  });
}

function bindRolesToConnection(
  roles: readonly CapabilityRole[],
  connectionId: string,
  modelId: string,
): CapabilityRole[] {
  const bound: CapabilityRole[] = [];
  for (const role of roles) {
    saveCapabilityBinding(role, connectionId, modelId);
    bound.push(role);
  }
  return bound;
}

/**
 * Remove local-engine connection rows whose engineId is no longer in the
 * registry. Safe to call any time — only acts on rows whose id starts with
 * `local-engine:`. Used after `stop_others_for_path` so the rows for the
 * stopped engines don't linger.
 */
async function pruneStaleLocalEngineRows(): Promise<void> {
  const connections = getConnections();
  const localConnIds = connections
    .map(c => c.id)
    .filter(id => id.startsWith('local-engine:'));
  if (localConnIds.length === 0) return;
  let runningIds: Set<string>;
  try {
    const running = await engineStatus();
    runningIds = new Set(running.map(e => localEngineConnectionId(e.engineId)));
  } catch {
    // No desktop runtime — nothing authoritative to prune against.
    return;
  }
  for (const id of localConnIds) {
    if (!runningIds.has(id)) {
      try {
        const profile = getCapabilityProfile();
        for (const role of CAPABILITY_ROLES) {
          if (profile[role]?.connectionId === id) {
            clearCapabilityBinding(role);
          }
        }
        await removeConnection(id);
      } catch {
        // Best-effort: a stale connection row is harmless once the binding
        // is also gone (clearDanglingBindings will follow up).
      }
    }
  }
}
