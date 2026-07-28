import {
  isLocalEngineConnectionId,
  localEngineConnectionId,
} from '@/lib/model-supply/local-engine';
import {
  CAPABILITY_ROLES,
  type CapabilityBinding,
  type CapabilityProfile,
  type CapabilityRole,
  type RuntimeConnection,
} from '@/lib/model-supply/types';

export const EMPTY_CAPABILITY_PROFILE: CapabilityProfile = {
  draft: null,
  rewrite: null,
  planning: null,
  recall: null,
};

/** Bound non-local health probes; keep sparse so offline providers stay honest. */
export const CAPABILITY_HEALTH_REFRESH_MS = 60_000;

export function collectBoundNonLocalConnections(
  profile: CapabilityProfile,
  connections: readonly RuntimeConnection[],
): RuntimeConnection[] {
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  const seen = new Set<string>();
  const targets: RuntimeConnection[] = [];
  for (const role of CAPABILITY_ROLES) {
    const binding = profile[role];
    if (!binding) continue;
    for (const target of [binding, binding.fallback ?? null]) {
      if (
        !target
        || isLocalEngineConnectionId(target.connectionId)
        || seen.has(target.connectionId)
      ) {
        continue;
      }
      const connection = byId.get(target.connectionId);
      if (!connection) continue;
      seen.add(connection.id);
      targets.push(connection);
    }
  }
  return targets;
}

type CapabilityCoverageStatus = 'ready' | 'stopped' | 'unbound';
type CapabilityCoverageSource = 'primary' | 'fallback' | null;

export interface CapabilityCoverageRole {
  role: CapabilityRole;
  status: CapabilityCoverageStatus;
  source: CapabilityCoverageSource;
  binding: CapabilityBinding | null;
  connection: RuntimeConnection | null;
  modelId: string | null;
  isLocalEngine: boolean;
}

export interface CapabilityCoverageSummary {
  roles: CapabilityCoverageRole[];
  readyCount: number;
  totalCount: number;
  readyRoles: CapabilityRole[];
  stoppedRoles: CapabilityRole[];
  unboundRoles: CapabilityRole[];
  notReadyRoles: CapabilityRole[];
  complete: boolean;
}

/**
 * Sidebar / Models coverage: a bound role is ready only when its selected
 * target is runnable right now.
 *
 * - Bundled local-engine connections: live `engineStatus` membership.
 * - All other connections: a successful current health probe
 *   (`reachable && transportOk`) plus exact advertised model membership
 *   recorded in `healthyConnectionModels`.
 *
 * Auth shape / loopback URL alone never imply ready — configured ≠ runnable.
 * Omitting `healthyConnectionModels` treats every non-local target as stopped so
 * coverage cannot flash complete before probes finish.
 */
export function buildCapabilityCoverageSummary({
  profile,
  connections,
  runningEngines,
  healthyConnectionModels = new Map<string, ReadonlySet<string>>(),
  roles = CAPABILITY_ROLES,
}: {
  profile: CapabilityProfile;
  connections: readonly RuntimeConnection[];
  runningEngines: readonly { engineId: string }[];
  healthyConnectionModels?: ReadonlyMap<string, ReadonlySet<string>>;
  roles?: readonly CapabilityRole[];
}): CapabilityCoverageSummary {
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  const liveLocalConnectionIds = new Set(
    runningEngines.map(engine => localEngineConnectionId(engine.engineId)),
  );
  const rows = roles.map(role => {
    const binding = profile[role] ?? null;
    return resolveRoleCoverage(
      role,
      binding,
      byId,
      liveLocalConnectionIds,
      healthyConnectionModels,
    );
  });
  const readyRoles = rows.filter(row => row.status === 'ready').map(row => row.role);
  const stoppedRoles = rows.filter(row => row.status === 'stopped').map(row => row.role);
  const unboundRoles = rows.filter(row => row.status === 'unbound').map(row => row.role);
  return {
    roles: rows,
    readyCount: readyRoles.length,
    totalCount: rows.length,
    readyRoles,
    stoppedRoles,
    unboundRoles,
    notReadyRoles: rows.filter(row => row.status !== 'ready').map(row => row.role),
    complete: rows.length > 0 && readyRoles.length === rows.length,
  };
}

function resolveRoleCoverage(
  role: CapabilityRole,
  binding: CapabilityBinding | null,
  byId: ReadonlyMap<string, RuntimeConnection>,
  liveLocalConnectionIds: ReadonlySet<string>,
  healthyConnectionModels: ReadonlyMap<string, ReadonlySet<string>>,
): CapabilityCoverageRole {
  if (!binding) {
    return emptyRole(role, 'unbound');
  }

  const primary = resolveBindingTarget(
    role,
    binding,
    'primary',
    byId,
    liveLocalConnectionIds,
    healthyConnectionModels,
  );
  if (primary.status === 'ready') return primary;

  if (binding.fallback) {
    const fallback = resolveBindingTarget(
      role,
      binding,
      'fallback',
      byId,
      liveLocalConnectionIds,
      healthyConnectionModels,
    );
    if (fallback.status === 'ready') return fallback;
    if (primary.status === 'unbound') return fallback;
  }

  return primary.status === 'unbound' ? emptyRole(role, 'unbound') : primary;
}

function resolveBindingTarget(
  role: CapabilityRole,
  binding: CapabilityBinding,
  source: Exclude<CapabilityCoverageSource, null>,
  byId: ReadonlyMap<string, RuntimeConnection>,
  liveLocalConnectionIds: ReadonlySet<string>,
  healthyConnectionModels: ReadonlyMap<string, ReadonlySet<string>>,
): CapabilityCoverageRole {
  const target = source === 'primary' ? binding : binding.fallback;
  if (!target) return emptyRole(role, 'unbound');

  const connection = byId.get(target.connectionId) ?? null;
  if (!connection) {
    return {
      role,
      status: 'stopped',
      source,
      binding,
      connection: null,
      modelId: target.modelId,
      isLocalEngine: isLocalEngineConnectionId(target.connectionId),
    };
  }

  const isLocalEngine = isLocalEngineConnectionId(connection.id);
  const ready = isLocalEngine
    ? liveLocalConnectionIds.has(connection.id)
    : healthyConnectionModels.get(connection.id)?.has(target.modelId) === true;
  return {
    role,
    status: ready ? 'ready' : 'stopped',
    source,
    binding,
    connection,
    modelId: target.modelId,
    isLocalEngine,
  };
}

function emptyRole(
  role: CapabilityRole,
  status: Extract<CapabilityCoverageStatus, 'unbound'>,
): CapabilityCoverageRole {
  return {
    role,
    status,
    source: null,
    binding: null,
    connection: null,
    modelId: null,
    isLocalEngine: false,
  };
}
