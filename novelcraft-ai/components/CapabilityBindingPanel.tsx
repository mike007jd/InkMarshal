'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cpu, HardDrive, Play, Sparkles, Workflow } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { RoleSpecificEngineLaunchDialog } from '@/components/EngineLaunchRoleDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { omitKey } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  engineEstimateFootprint,
  engineResourceBudget,
  engineStatus,
  isTauriRuntime,
  listInstalledLocalModels,
  ollamaListTags,
  type EngineBudget,
  type EngineFormat,
  type EngineInfo,
} from '@/lib/desktop-runtime';
import { catalogForRole, MODEL_CATALOG } from '@/lib/model-supply/catalog';
import { formatBytes } from '@/lib/model-supply/format';
import {
  clearCapabilityBinding,
  getCapabilityProfile,
  getConnections,
  saveCapabilityBinding,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import {
  isLocalEngineConnectionId,
  localEngineConnectionId,
} from '@/lib/model-supply/local-engine';
import { bindingForConnectionSelection } from '@/lib/model-supply/binding-selection';
import {
  startEngineForRoles,
  type EngineStartResult,
} from '@/lib/model-supply/orchestrator';
import { checkConnectionHealth } from '@/lib/model-supply/runtime-health';
import {
  CAPABILITY_ROLES,
  type CapabilityBinding,
  type CapabilityProfile,
  type CapabilityRole,
  type CuratedModelEntry,
  type InstalledLocalModel,
  type RuntimeConnection,
} from '@/lib/model-supply/types';

const NONE = '__none__';

function roleMeta(
  role: CapabilityRole,
  t: ReturnType<typeof useLanguage>['t'],
): { label: string; desc: string } {
  switch (role) {
    case 'draft':
      return { label: t.capabilityRoleDraftLabel, desc: t.capabilityRoleDraftDesc };
    case 'rewrite':
      return { label: t.capabilityRoleRewriteLabel, desc: t.capabilityRoleRewriteDesc };
    case 'planning':
      return { label: t.capabilityRolePlanningLabel, desc: t.capabilityRolePlanningDesc };
    case 'recall':
      return { label: t.capabilityRoleRecallLabel, desc: t.capabilityRoleRecallDesc };
  }
}

// Curated model ids a role could use, as fallback suggestions when a runtime
// doesn't advertise its tags.
function suggestedModels(role: CapabilityRole): string[] {
  return catalogForRole(role)
    .filter(e => e.lifecycle === 'recommended')
    .map(e => e.ollamaName)
    .filter((m): m is string => Boolean(m));
}

// ── autoBind scoring ────────────────────────────────────────────────────────
//
// Candidate sources for a role:
//   - already-running engines (`local-engine:<engineId>` connections)
//   - installed local models in the desktop model folder
//   - models advertised by remote/Ollama connections (health probe / tags)
//
// All three are normalized into a `Candidate` so scoring is uniform.

export type CandidateSource = 'engine' | 'installed' | 'remote';

export interface Candidate {
  source: CandidateSource;
  // Curated catalog entry, when we could match the model id back to one. The
  // scorer uses `catalogMatch.role` for roleFit + (future) `languages`.
  catalogMatch: CuratedModelEntry | null;
  modelLabel: string; // display label
  modelId: string; // id used in capability binding
  // Bind-time fields:
  connectionId?: string; // for engine + remote candidates
  connection?: RuntimeConnection; // the backing connection (for tier classification)
  installed?: InstalledLocalModel; // for the installed-but-not-yet-running case
  alreadyRunning?: EngineInfo; // engine candidate's running info
}

// ── Connection tier (the locked product rule) ────────────────────────────────
//
// Bundled local engine ≫ other detected local (Ollama / LM Studio) ≫ BYOK cloud.
// A cloud candidate must only win when no viable local candidate exists, so the
// tier weight dominates roleFit (max roleFit term is 13: fit*10 + zh 3).
//
//   bundled  = 100  (running local engine, or an installed model we'll launch
//                    on the bundled engine)
//   detected = 40   (externally-detected local server: Ollama / LM Studio /
//                    any loopback `kind:'local'` connection)
//   cloud    = 0    (BYOK provider / non-loopback remote — last resort)
type ConnectionTier = 'bundled' | 'detected' | 'cloud';

const TIER_BONUS: Record<ConnectionTier, number> = {
  bundled: 100,
  detected: 40,
  cloud: 0,
};

const LOOPBACK_HOST_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)(:|\/|$)/i;

/**
 * A connection points at a local-loopback target — either by being an
 * `ollama-native` transport (which is loopback by definition) or by having a
 * loopback baseUrl. The invariant the autoBind tier system encodes is
 * "loopback = local-detected, regardless of how the user spelled the
 * connection". A custom `openai-compatible` row at `http://127.0.0.1:11434/v1`
 * is the standard way users wire Ollama's OpenAI-compat path, and must not be
 * misclassified as cloud BYOK.
 */
function isLoopbackTarget(conn: { transport?: string; baseUrl?: string }): boolean {
  if (conn.transport === 'ollama-native') return true;
  if (!conn.baseUrl) return false;
  return LOOPBACK_HOST_RE.test(conn.baseUrl);
}

/**
 * Classify a candidate into the bundled / detected-local / cloud tier. This is
 * the single place that encodes "bundled engine is DEFAULT, BYOK is LAST".
 *   - `engine` source → bundled (it IS a running bundled `local-engine:` row).
 *   - `installed` source → bundled (we'd launch it on the bundled engine).
 *   - `remote` source → inspect the connection: anything pointing at a
 *     loopback target is a detected local server (covers both Ollama's
 *     native transport and `kind:'custom'` openai-compat rows targeting
 *     `http://127.0.0.1:*`); everything else is BYOK cloud.
 */
export function connectionTier(candidate: Candidate): ConnectionTier {
  if (candidate.source === 'engine' || candidate.source === 'installed') {
    return 'bundled';
  }
  const conn = candidate.connection;
  if (!conn) return 'cloud';
  if (isLoopbackTarget(conn)) return 'detected';
  return 'cloud';
}

interface PlanStep {
  role: CapabilityRole;
  candidate: Candidate;
}

interface AutoBindOutcome {
  started: number;
  reused: number;
  bound: number;
  failed: number;
}

function roleFitForEntry(entry: CuratedModelEntry | null, role: CapabilityRole): number {
  if (!entry) return 0;
  const roles = Array.isArray(entry.role) ? entry.role : [entry.role];
  return roles.includes(role) ? 1 : 0;
}

/**
 * Catalog entry that best matches a free-form model id ("qwen3.5:4b",
 * "Qwen3.5-9B-Q4_K_M.gguf", "Qwen/Qwen3.5-9B/.../"). We
 * match against ollamaName + repo basenames + the catalog id slug. Returns the
 * first one with a positive signal — order in MODEL_CATALOG implicitly
 * encodes preference within a category.
 */
function catalogEntryForModelId(modelId: string): CuratedModelEntry | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  for (const entry of MODEL_CATALOG) {
    if (entry.ollamaName && entry.ollamaName.toLowerCase() === lower) return entry;
  }
  for (const entry of MODEL_CATALOG) {
    const hay: string[] = [];
    if (entry.ollamaName) hay.push(entry.ollamaName);
    if (entry.gguf?.repo) {
      hay.push(entry.gguf.repo);
      // basename only — most local files are `Repo-Name-Quant.gguf`.
      const base = entry.gguf.repo.split('/').pop() ?? '';
      if (base) hay.push(base);
    }
    if (entry.mlx?.repo) {
      hay.push(entry.mlx.repo);
      const base = entry.mlx.repo.split('/').pop() ?? '';
      if (base) hay.push(base);
    }
    hay.push(entry.id);
    for (const h of hay) {
      if (!h) continue;
      const hl = h.toLowerCase();
      // bidirectional substring - handles both shorter ids ("qwen3.5:4b") and
      // long filenames ("Qwen3.5-9B-Q4_K_M.gguf").
      if (lower.includes(hl) || hl.includes(lower)) return entry;
    }
  }
  return null;
}

/** Score a candidate for a role; higher = better. Plan §1.4 d formula. */
export function scoreCandidate(
  candidate: Candidate,
  role: CapabilityRole,
  budget: EngineBudget | null,
  footprintByPath: Map<string, number>,
): number {
  const fit = roleFitForEntry(candidate.catalogMatch, role);
  let score = fit * 10;
  // W4-F will add `languages` to CuratedModelEntry. Until then the field is
  // undefined and the bonus collapses to 0 — that's the documented behavior.
  const langs = (candidate.catalogMatch as (CuratedModelEntry & { languages?: string[] }) | null)
    ?.languages;
  if (Array.isArray(langs) && langs.includes('zh')) score += 3;
  // Connection-tier weight — the locked product rule. This term dominates the
  // roleFit term (max 13) so a local candidate ALWAYS outranks a cloud one of
  // equal fit; a cloud candidate only wins when no local candidate is viable.
  score += TIER_BONUS[connectionTier(candidate)];
  // Footprint fit:
  //   - Engine source: it's already running, so it definitely fits.
  //   - Installed: look up estimated footprint vs. available budget.
  //   - Remote: no local RAM cost, neutral.
  if (candidate.source === 'engine') {
    score += 2; // already_running bonus
    score += 5; // footprint fits by construction
  } else if (candidate.source === 'installed' && candidate.installed) {
    const footprint = footprintByPath.get(candidate.installed.modelPath) ?? 0;
    if (footprint > 0 && budget && footprint <= budget.availableRamBytes) {
      score += 5;
    } else if (footprint > 0 && budget && footprint > budget.availableRamBytes) {
      score -= 10;
    } else {
      // Unknown footprint (estimation failed / no budget snapshot): a small
      // positive local-preference bonus instead of 0, so a downloaded local
      // model is still preferred over a remote candidate of equal fit. Kept
      // below the +5 "known-fit" bonus so a confirmed-fitting model still wins.
      score += 1;
    }
  }
  return score;
}

export function CapabilityBindingPanel({
  hideWhenUnavailable = false,
}: {
  hideWhenUnavailable?: boolean;
} = {}) {
  const { t } = useLanguage();
  const [connections, setConnections] = useState<RuntimeConnection[]>([]);
  const [profile, setProfile] = useState<CapabilityProfile>(() =>
    getCapabilityProfile(),
  );
  // connectionId -> advertised model ids (ollama tags / health models)
  const [modelsByConn, setModelsByConn] = useState<Record<string, string[]>>({});
  // role -> manual model id text (when the runtime advertises nothing)
  const [manualModel, setManualModel] = useState<Record<string, string>>({});
  const [pendingPrimaryConnection, setPendingPrimaryConnection] = useState<
    Partial<Record<CapabilityRole, string>>
  >({});
  const [pendingFallbackConnection, setPendingFallbackConnection] = useState<
    Partial<Record<CapabilityRole, string>>
  >({});
  const [autoBinding, setAutoBinding] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([]);
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [budget, setBudget] = useState<EngineBudget | null>(null);
  // Per-role launch dialog state. Only one role's dialog is open at a time —
  // CapabilityBindingPanel is small and modal use is sparse, so a single
  // `pendingLaunch` slot suffices.
  const [pendingLaunch, setPendingLaunch] = useState<{
    role: CapabilityRole;
    modelPath: string;
    format: EngineFormat;
    modelLabel: string;
  } | null>(null);

  const mountedRef = useRef(true);
  const refreshSeqRef = useRef(0);
  const autoBindSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadModelsFor = useCallback(async (conn: RuntimeConnection, seq: number) => {
    let models: string[] = [];
    if (conn.transport === 'ollama-native' && isTauriRuntime()) {
      try {
        models = await ollamaListTags(conn.baseUrl);
      } catch {
        models = [];
      }
    }
    if (models.length === 0) {
      const health = await checkConnectionHealth(conn);
      models = health.models;
    }
    if (mountedRef.current && refreshSeqRef.current === seq) {
      setModelsByConn(prev => ({ ...prev, [conn.id]: models }));
    }
  }, []);

  /** Refresh the desktop-side state — installed models, running engines, RAM
   * budget. Errors collapse to empty / null so the UI never blocks on a
   * desktop-only command rejecting in the web preview. */
  const loadDesktopState = useCallback(async (seq?: number) => {
    if (!isTauriRuntime()) {
      if (mountedRef.current && (seq == null || refreshSeqRef.current === seq)) {
        setInstalled([]);
        setEngines([]);
        setBudget(null);
      }
      return;
    }
    const [inst, engs, bud] = await Promise.all([
      listInstalledLocalModels().catch(() => [] as InstalledLocalModel[]),
      engineStatus().catch(() => [] as EngineInfo[]),
      engineResourceBudget().catch(() => null),
    ]);
    if (!mountedRef.current || (seq != null && refreshSeqRef.current !== seq)) return;
    setInstalled(inst);
    setEngines(engs);
    setBudget(bud);
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const conns = getConnections();
    if (!mountedRef.current || refreshSeqRef.current !== seq) return;
    setConnections(conns);
    setProfile(getCapabilityProfile());
    await Promise.all([
      ...conns.map(conn => loadModelsFor(conn, seq)),
      loadDesktopState(seq),
    ]);
  }, [loadDesktopState, loadModelsFor]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    // Re-read when a sibling model-manager panel mutates a connection/binding
    // (one drawer — panels must stay consistent). subscribeConnectionsStore is
    // SSR-safe and never fires synchronously on subscribe.
    const unsubscribe = subscribeConnectionsStore(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh]);

  const connById = useMemo(
    () => new Map(connections.map(c => [c.id, c])),
    [connections],
  );

  // engineId -> EngineInfo
  const engineById = useMemo(
    () => new Map(engines.map(e => [e.engineId, e])),
    [engines],
  );

  const setBinding = useCallback(
    (role: CapabilityRole, next: CapabilityBinding | null) => {
      if (next == null || !next.connectionId || !next.modelId) {
        clearCapabilityBinding(role);
      } else {
        saveCapabilityBinding(
          role,
          next.connectionId,
          next.modelId,
          next.fallback,
        );
      }
      setProfile(getCapabilityProfile());
    },
    [],
  );

  const modelOptionsFor = useCallback(
    (role: CapabilityRole, connectionId: string): string[] => {
      const advertised = modelsByConn[connectionId] ?? [];
      const suggested = suggestedModels(role);
      // Merge advertised + curated suggestions, de-duped, advertised first.
      return Array.from(new Set([...advertised, ...suggested]));
    },
    [modelsByConn],
  );

  // ── autoBind (wave 4) ─────────────────────────────────────────────────────
  //
  // Rewritten per plan §1.4 d. Candidate sources (merged + de-duped):
  //   • running engines (each = one `local-engine:<engineId>` connection row)
  //   • installed local models in the model dir
  //   • models advertised by reachable remote/Ollama connections
  // Score formula:
  //   score = roleFit(catalog, role) * 10
  //         + (entry.languages?.includes('zh') ? 3 : 0)   // W4-F adds languages
  //         + (footprint_fits_available_ram ? 5 : -10)
  //         + (already_running ? 2 : 0)
  // For each role we pick the highest-scoring positive candidate. Greedy
  // resource budgeting: each new engine we plan to start spends its footprint
  // against `availableRamBytes`; if the next role's best candidate would not
  // fit, we fall back to its best already-running candidate (engine source).

  const autoBind = useCallback(async () => {
    const seq = ++autoBindSeqRef.current;
    setAutoBinding(true);
    setAutoMsg(null);
    try {
      const conns = getConnections();
      const desktop = isTauriRuntime();

      // Fresh snapshot of desktop state so a stale `engines` from a parallel
      // mutation doesn't make the planner choose a dead engineId.
      const [installedNow, enginesNow, budgetNow] = desktop
        ? await Promise.all([
            listInstalledLocalModels().catch(() => [] as InstalledLocalModel[]),
            engineStatus().catch(() => [] as EngineInfo[]),
            engineResourceBudget().catch(() => null as EngineBudget | null),
          ])
        : [[] as InstalledLocalModel[], [] as EngineInfo[], null as EngineBudget | null];
      if (!mountedRef.current || autoBindSeqRef.current !== seq) return;

      // Health-check every connection once; reuse across roles.
      const healthByConn = new Map<
        string,
        { reachable: boolean; models: string[] }
      >();
      await Promise.all(
        conns.map(async c => {
          const h = await checkConnectionHealth(c);
          let models = h.models;
          if (
            models.length === 0 &&
            c.transport === 'ollama-native' &&
            desktop
          ) {
            try {
              models = await ollamaListTags(c.baseUrl);
            } catch {
              models = [];
            }
          }
          healthByConn.set(c.id, {
            reachable: h.reachable && h.transportOk,
            models,
          });
        }),
      );
      if (!mountedRef.current || autoBindSeqRef.current !== seq) return;

      // Estimate footprint for each installed model, parallel + best-effort.
      const footprintByPath = new Map<string, number>();
      if (desktop) {
        await Promise.all(
          installedNow.map(async m => {
            try {
              const fp = await engineEstimateFootprint(m.modelPath, m.format);
              footprintByPath.set(m.modelPath, fp.ramBytes);
            } catch {
              // Unknown footprint → 0 → scorer assigns 0 instead of bonus/penalty.
              footprintByPath.set(m.modelPath, 0);
            }
          }),
        );
      }
      if (!mountedRef.current || autoBindSeqRef.current !== seq) return;

      // Build the candidate pool. Note duplicates across sources are expected
      // (an installed model that's also already running shows up as both an
      // engine candidate and an installed candidate); the scorer picks the
      // engine path because of the `already_running` bonus, which is exactly
      // what we want.
      const candidates: Candidate[] = [];

      // 1. Engine candidates — one per running engine.
      for (const eng of enginesNow) {
        const connId = localEngineConnectionId(eng.engineId);
        const conn = conns.find(c => c.id === connId);
        if (!conn) continue;
        const label = conn.label.replace(/^Local engine · /, '') || eng.modelPath;
        // For an engine candidate the `modelId` is the label the engine was
        // registered with — same value passed to saveCapabilityBinding. We
        // approximate via the connection label suffix since the engine row
        // itself doesn't carry a modelLabel field.
        candidates.push({
          source: 'engine',
          catalogMatch: catalogEntryForModelId(label),
          modelLabel: label,
          modelId: label,
          connectionId: connId,
          alreadyRunning: eng,
        });
      }

      // 2. Installed-local candidates (excluding ones already running).
      const runningPaths = new Set(enginesNow.map(e => e.modelPath));
      for (const m of installedNow) {
        if (runningPaths.has(m.modelPath)) continue;
        candidates.push({
          source: 'installed',
          catalogMatch: catalogEntryForModelId(m.label),
          modelLabel: m.label,
          modelId: m.label,
          installed: m,
        });
      }

      // 3. Remote-advertised candidates — one per (connection, model) pair.
      for (const c of conns) {
        const info = healthByConn.get(c.id);
        if (!info || !info.reachable) continue;
        // Skip local-engine connections; they're already represented by their
        // engine candidate, which carries the alreadyRunning bonus.
        if (isLocalEngineConnectionId(c.id)) continue;
        for (const modelId of info.models) {
          candidates.push({
            source: 'remote',
            catalogMatch: catalogEntryForModelId(modelId),
            modelLabel: modelId,
            modelId,
            connectionId: c.id,
            connection: c,
          });
        }
      }

      if (candidates.length === 0) {
        if (mountedRef.current && autoBindSeqRef.current === seq) setAutoMsg(t.capabilityNoConnections);
        return;
      }

      // Plan: pick the best candidate per role.
      // Greedy RAM accounting — each `installed` candidate we plan to start
      // spends its footprint against the running budget. Multiple roles binding
      // to the SAME installed model only spend its footprint once (the
      // orchestrator's reuse path).
      let runningBudgetBytes = budgetNow?.availableRamBytes ?? 0;
      const spentForPath = new Set<string>();
      const plan: PlanStep[] = [];

      for (const role of CAPABILITY_ROLES) {
        // Rank candidates by score for this role; tie-break by source so a
        // local candidate always beats a remote one at equal score. Order:
        // already-running engine (cheapest bind) → installed local (launch on
        // the bundled engine) → remote (Ollama/cloud). This keeps `installed`
        // ABOVE `remote`, reinforcing the tier bonus on the rare exact-tie.
        const sourcePriority: Record<CandidateSource, number> = {
          engine: 0,
          installed: 1,
          remote: 2,
        };
        const ranked = candidates
          .map(c => ({ c, s: scoreCandidate(c, role, budgetNow, footprintByPath) }))
          .sort((a, b) => b.s - a.s || sourcePriority[a.c.source] - sourcePriority[b.c.source]);

        let picked: Candidate | null = null;
        for (const { c, s } of ranked) {
          if (s <= 0) break;
          if (c.source === 'installed' && c.installed) {
            const fp = footprintByPath.get(c.installed.modelPath) ?? 0;
            if (!spentForPath.has(c.installed.modelPath) && fp > 0 && fp > runningBudgetBytes) {
              // Budget would not fit — skip this candidate; the next ranked
              // candidate (possibly an engine reuse) gets a chance.
              continue;
            }
          }
          picked = c;
          break;
        }
        if (!picked) continue;

        // Account for the budget spend (only for new starts, only the first
        // time we plan to start the same path).
        if (picked.source === 'installed' && picked.installed) {
          const path = picked.installed.modelPath;
          if (!spentForPath.has(path)) {
            const fp = footprintByPath.get(path) ?? 0;
            runningBudgetBytes = Math.max(0, runningBudgetBytes - fp);
            spentForPath.add(path);
          }
        }
        plan.push({ role, candidate: picked });
      }

      if (plan.length === 0) {
        if (mountedRef.current && autoBindSeqRef.current === seq) setAutoMsg(t.capabilityAutoBindNone);
        return;
      }

      // Execute the plan.
      let started = 0;
      let reused = 0;
      let bound = 0;
      let failed = 0;
      // Track which paths we've already kicked off an engine for in this auto-
      // bind run so subsequent roles binding to the same model reuse it.
      const launchedPaths = new Map<string, string /* connectionId */>();
      for (const step of plan) {
        if (!mountedRef.current || autoBindSeqRef.current !== seq) return;
        const c = step.candidate;
        if (c.source === 'engine' && c.connectionId) {
          // Direct bind to an already-running engine — no engine start needed.
          saveCapabilityBinding(step.role, c.connectionId, c.modelId);
          reused += 1;
          bound += 1;
          continue;
        }
        if (c.source === 'remote' && c.connectionId) {
          saveCapabilityBinding(step.role, c.connectionId, c.modelId);
          bound += 1;
          continue;
        }
        if (c.source === 'installed' && c.installed) {
          const path = c.installed.modelPath;
          const existing = launchedPaths.get(path);
          if (existing) {
            saveCapabilityBinding(step.role, existing, c.modelId);
            reused += 1;
            bound += 1;
            continue;
          }
          try {
            const result: EngineStartResult = await startEngineForRoles({
              modelPath: path,
              format: c.installed.format,
              modelLabel: c.installed.label,
              roles: [step.role],
              onConflict: 'reuse',
            });
            if (!mountedRef.current || autoBindSeqRef.current !== seq) return;
            launchedPaths.set(path, result.connection.id);
            if (result.reused) reused += 1;
            else started += 1;
            bound += 1;
          } catch {
            // Best-effort: a single launch failure must not abort the
            // remaining plan steps. Other roles may still get bound to
            // reachable remote connections. Count it so the summary doesn't
            // report a clean success while roles silently stayed unbound.
            if (!mountedRef.current || autoBindSeqRef.current !== seq) return;
            failed += 1;
          }
        }
      }

      if (mountedRef.current && autoBindSeqRef.current === seq) {
        setProfile(getCapabilityProfile());
        // Refresh engines list so subsequent renders / the running-engine
        // counter reflect newly started engines.
        await loadDesktopState();
        if (!mountedRef.current || autoBindSeqRef.current !== seq) return;
        const outcome: AutoBindOutcome = { started, reused, bound, failed };
        const failedNote = outcome.failed > 0
          ? ' ' + t.capabilityAutoBindFailed.replace('{failed}', String(outcome.failed))
          : '';
        setAutoMsg(
          outcome.bound > 0
            ? t.capabilityAutoBindSummary
                .replace('{started}', String(outcome.started))
                .replace('{reused}', String(outcome.reused))
                .replace('{bound}', String(outcome.bound)) + failedNote
            : outcome.failed > 0
              ? t.capabilityAutoBindFailed.replace('{failed}', String(outcome.failed))
              : t.capabilityAutoBindNone,
        );
      }
    } finally {
      if (mountedRef.current && autoBindSeqRef.current === seq) setAutoBinding(false);
    }
  }, [loadDesktopState, t]);

  // ── Per-role launch ──────────────────────────────────────────────────────

  /** Open the role-specific launch dialog with the user's best installed
   * model for that role pre-selected. We just need *some* sensible default —
   * the dialog itself doesn't currently let the user re-pick the file; this
   * commit ships the "click → dialog → start" path. (Plan also calls for
   * showing installed/engine/ollama lists inside the dialog; that requires a
   * larger picker UI which is deferred — the W4-B EngineLaunchRoleDialog
   * already runs startEngineForRoles + handles QuotaConflict.) */
  const launchForRole = useCallback(
    (role: CapabilityRole) => {
      // Prefer an installed model whose curated catalog entry includes this role.
      const ranked: { m: InstalledLocalModel; score: number }[] = [];
      for (const m of installed) {
        const entry = catalogEntryForModelId(m.label);
        const fit = roleFitForEntry(entry, role);
        if (fit > 0) ranked.push({ m, score: fit * 10 });
      }
      // If nothing fits, fall back to the first installed model as default.
      const bestFit = ranked.sort((a, b) => b.score - a.score)[0];
      const target = bestFit?.m ?? installed[0];
      if (!target) {
        // No installed model at all — distinct from "no connections".
        setAutoMsg(t.capabilityNoInstalledModels);
        return;
      }
      // Launching a model not curated for this role still works, but warn so the
      // user isn't surprised by a role-mismatched default.
      setAutoMsg(bestFit ? null : t.capabilityRoleNotOptimized);
      setPendingLaunch({
        role,
        modelPath: target.modelPath,
        format: target.format,
        modelLabel: target.label,
      });
    },
    [installed, t],
  );

  const handleLaunchSuccess = useCallback(
    (_result: EngineStartResult) => {
      setPendingLaunch(null);
      void refresh();
    },
    [refresh],
  );

  const handleLaunchCancel = useCallback(() => setPendingLaunch(null), []);

  // One model control shared by the primary AND fallback paths. `manualKey`
  // namespaces the manual-entry draft text (role for primary,
  // `${role}:fallback` for the fallback) so a connection with no advertised
  // models is still settable on EITHER slot, and the two drafts never collide.
  const renderModelControl = (
    role: CapabilityRole,
    connId: string,
    currentModelId: string,
    manualKey: string,
    onCommit: (modelId: string) => void,
  ) => {
    if (!connId) {
      return (
        <Select disabled>
          <SelectTrigger>
            <SelectValue placeholder={t.capabilitySelectModel} />
          </SelectTrigger>
        </Select>
      );
    }
    const options = modelOptionsFor(role, connId);
    if (options.length > 0) {
      return (
        <Select
          value={currentModelId || ''}
          onValueChange={v => onCommit(v)}
        >
          <SelectTrigger>
            <SelectValue placeholder={t.capabilitySelectModel} />
          </SelectTrigger>
          <SelectContent>
            {options.map(m => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    // No advertised/suggested models — manual entry escape.
    return (
      <Input
        value={manualModel[manualKey] ?? currentModelId ?? ''}
        placeholder={t.capabilityModelManualEntry}
        onChange={e =>
          setManualModel(prev => ({ ...prev, [manualKey]: e.target.value }))
        }
        onBlur={() => {
          const val = (manualModel[manualKey] ?? '').trim();
          if (val) onCommit(val);
        }}
      />
    );
  };

  const desktop = isTauriRuntime();
  const runningCount = engines.length;
  // Role cards only make sense once there is something to bind to — a
  // connection, or an installed model the per-role launch button can start.
  const hasAnyBindingTarget = connections.length > 0 || installed.length > 0;
  const availableRamLabel = budget ? formatBytes(budget.availableRamBytes) : '—';

  if (hideWhenUnavailable && !hasAnyBindingTarget) return null;

  return (
    <section>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="h-3.5 w-3.5 shrink-0 text-book-ink-muted" />
          <h3 className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
            {t.capabilityTitle}
          </h3>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void autoBind()}
          disabled={autoBinding || !hasAnyBindingTarget}
          className="w-full sm:w-auto"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {autoBinding ? t.capabilityAutoBinding : t.capabilityAutoBind}
        </Button>
      </div>

      <div className="space-y-3">
        <p className="text-xs leading-5 text-book-ink-muted">
          {t.capabilityDesc}
        </p>

        {desktop && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-book-border bg-book-bg-secondary px-3 py-2 text-xs-tight text-book-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5" />
              {t.engineRunningCount.replace('{count}', String(runningCount))}
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1.5">
              <HardDrive className="h-3.5 w-3.5" />
              {t.engineAvailableRam.replace('{ram}', availableRamLabel)}
            </span>
          </div>
        )}

        {autoMsg && (
          <p className="rounded-md border border-book-border bg-book-bg-secondary px-3 py-2 text-xs-tight text-book-ink-secondary">
            {autoMsg}
          </p>
        )}

        {connections.length === 0 && (
          <p className="rounded-md border border-dashed border-book-border px-3 py-2 text-xs text-book-ink-muted">
            {t.capabilityNoConnections}
          </p>
        )}

        {hasAnyBindingTarget && CAPABILITY_ROLES.map(role => {
          const binding = profile[role];
          const meta = roleMeta(role, t);
          const bound = Boolean(binding?.connectionId && binding?.modelId);
          const pendingConnectionId = pendingPrimaryConnection[role];
          const selectedConnectionId = pendingConnectionId ?? binding?.connectionId ?? '';
          const selectedModelId =
            pendingConnectionId && pendingConnectionId !== binding?.connectionId
              ? ''
              : binding?.modelId ?? '';
          const pendingFallbackConnectionId = pendingFallbackConnection[role];
          const selectedFallbackConnectionId =
            pendingFallbackConnectionId ?? binding?.fallback?.connectionId ?? NONE;
          const selectedFallbackModelId =
            pendingFallbackConnectionId &&
            pendingFallbackConnectionId !== binding?.fallback?.connectionId
              ? ''
              : binding?.fallback?.modelId ?? '';
          // Disabled when there are no installed models to launch for — the
          // dialog needs a `modelPath` to call startEngineForRoles.
          const launchDisabled = !desktop || installed.length === 0;
          return (
            <div
              key={role}
              className="rounded-md border border-book-border px-3 py-2.5"
            >
              <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-book-ink-primary">
                      {meta.label}
                    </span>
                    <span className={`inline-flex items-center gap-1 text-2xs font-semibold ${
                      bound ? 'text-book-success' : 'text-book-danger'
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        bound ? 'bg-book-success' : 'bg-book-danger'
                      }`} aria-hidden />
                      {bound ? t.capabilityBound : t.capabilityUnbound}
                    </span>
                    {binding?.connectionId &&
                      isLocalEngineConnectionId(binding.connectionId) &&
                      // Verify the engine actually runs — if it's a dangling
                      // pointer we still show the binding but skip the chip.
                      (() => {
                        const id = binding.connectionId.replace(/^local-engine:/, '');
                        return engineById.has(id);
                      })() && (
                        <span className="text-2xs font-semibold text-book-gold-dark">
                          {t.modelManagerEngineRunning}
                        </span>
                      )}
                  </div>
                  <p className="mt-0.5 text-xs-tight text-book-ink-muted">
                    {meta.desc}
                  </p>
                </div>
                <div className="flex w-full shrink-0 flex-col gap-1.5 sm:w-auto sm:flex-row sm:items-center">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={launchDisabled}
                    onClick={() => launchForRole(role)}
                    className="w-full sm:w-auto"
                    title={
                      launchDisabled
                        ? t.modelManagerInstalledEmpty
                        : t.capabilityLaunchForRole
                    }
                  >
                    <Play className="h-3.5 w-3.5" />
                    {t.capabilityLaunchForRole}
                  </Button>
                  {bound && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPendingPrimaryConnection(prev => omitKey(prev, role));
                        setPendingFallbackConnection(prev => omitKey(prev, role));
                        setBinding(role, null);
                      }}
                      className="w-full sm:w-auto"
                    >
                      {t.capabilityClear}
                    </Button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <span className="mb-1 block text-xs-tight text-book-ink-muted">
                    {t.capabilityConnection}
                  </span>
                  <Select
                    value={selectedConnectionId}
                    onValueChange={v => {
                      // Switching the connection invalidates stale manual
                      // text. If we already have a model option, commit a full
                      // binding immediately; otherwise keep a UI-only pending
                      // connection so manual entry can complete it without
                      // persisting an invalid half-binding.
                      setManualModel(prev => omitKey(prev, role));
                      const next = bindingForConnectionSelection(
                        v,
                        modelOptionsFor(role, v),
                        binding,
                      );
                      if (next) {
                        setPendingPrimaryConnection(prev => omitKey(prev, role));
                        setPendingFallbackConnection(prev => omitKey(prev, role));
                        setBinding(role, next);
                      } else {
                        setPendingPrimaryConnection(prev => ({ ...prev, [role]: v }));
                        setPendingFallbackConnection(prev => omitKey(prev, role));
                        setBinding(role, null);
                      }
                    }}
                    disabled={connections.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t.capabilitySelectConnection} />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.map(c => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <span className="mb-1 block text-xs-tight text-book-ink-muted">
                    {t.capabilityModel}
                  </span>
                  {renderModelControl(
                    role,
                    selectedConnectionId,
                    selectedModelId,
                    role,
                    modelId => {
                      if (!selectedConnectionId) return;
                      setPendingPrimaryConnection(prev => omitKey(prev, role));
                      setBinding(role, {
                        connectionId: selectedConnectionId,
                        modelId,
                        fallback: binding?.fallback,
                      });
                    },
                  )}
                </div>
              </div>

              {bound && (
                <div className="mt-2">
                  <span className="mb-1 block text-xs-tight text-book-ink-muted">
                    {t.capabilityFallback}
                  </span>
                  <Select
                    value={selectedFallbackConnectionId}
                    onValueChange={v => {
                      // Switching the fallback connection invalidates the
                      // fallback model + its manual-entry draft. If no model
                      // can be committed yet, keep the connection UI-only
                      // until manual entry supplies a complete fallback.
                      setManualModel(prev => omitKey(prev, `${role}:fallback`));
                      if (v === NONE) {
                        setPendingFallbackConnection(prev => omitKey(prev, role));
                        setBinding(role, {
                          connectionId: binding!.connectionId,
                          modelId: binding!.modelId,
                        });
                        return;
                      }
                      const fc = connById.get(v);
                      const fModels = fc ? modelOptionsFor(role, v) : [];
                      const fallbackModelId = fModels.map(m => m.trim()).find(Boolean);
                      if (!fallbackModelId) {
                        setPendingFallbackConnection(prev => ({ ...prev, [role]: v }));
                        setBinding(role, {
                          connectionId: binding!.connectionId,
                          modelId: binding!.modelId,
                        });
                        return;
                      }
                      setPendingFallbackConnection(prev => omitKey(prev, role));
                      setBinding(role, {
                        connectionId: binding!.connectionId,
                        modelId: binding!.modelId,
                        fallback: { connectionId: v, modelId: fallbackModelId },
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t.capabilityFallbackNone} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>
                        {t.capabilityFallbackNone}
                      </SelectItem>
                      {connections
                        .filter(c => c.id !== selectedConnectionId)
                        .map(c => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.label}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {selectedFallbackConnectionId !== NONE && (
                    <div className="mt-1.5">
                      {renderModelControl(
                        role,
                        selectedFallbackConnectionId,
                        selectedFallbackModelId,
                        `${role}:fallback`,
                        modelId => {
                          if (selectedFallbackConnectionId === NONE) return;
                          setPendingFallbackConnection(prev => omitKey(prev, role));
                          setBinding(role, {
                            connectionId: binding!.connectionId,
                            modelId: binding!.modelId,
                            fallback: {
                              connectionId: selectedFallbackConnectionId,
                              modelId,
                            },
                          });
                        },
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
          })}
      </div>

      {pendingLaunch && (
        <RoleSpecificEngineLaunchDialog
          open={true}
          role={pendingLaunch.role}
          plan={{
            modelPath: pendingLaunch.modelPath,
            format: pendingLaunch.format,
            modelLabel: pendingLaunch.modelLabel,
          }}
          onOpenChange={value => {
            if (!value) handleLaunchCancel();
          }}
          onSuccess={handleLaunchSuccess}
          onCancel={handleLaunchCancel}
        />
      )}
    </section>
  );
}
