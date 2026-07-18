'use client';

import { getCapabilityProfile, getConnections } from '@/lib/model-supply/connections';
import { isLocalEngineConnectionId, localEngineConnectionId } from '@/lib/model-supply/local-engine';
import { isLoopbackHttpUrl } from '@/lib/loopback-hosts';
import type { CapabilityBinding, CapabilityRole, RuntimeConnection } from '@/lib/model-supply/types';

const DEFAULT_WRITING_ROLES: readonly CapabilityRole[] = ['draft', 'planning'];

function isLoopbackRuntime(connection: RuntimeConnection): boolean {
  try {
    return isLoopbackHttpUrl(new URL(connection.baseUrl));
  } catch {
    return false;
  }
}

export function isOnDeviceRuntimeConnection(connection: RuntimeConnection): boolean {
  return connection.kind === 'local'
    || connection.transport === 'ollama-native'
    || isLoopbackRuntime(connection);
}

function hasUsableAuthShape(connection: RuntimeConnection): boolean {
  return Boolean(connection.secretRef) || isOnDeviceRuntimeConnection(connection);
}

function isUsableConnection(
  connection: RuntimeConnection,
  liveLocalEngineConnectionIds?: ReadonlySet<string>,
): boolean {
  if (!hasUsableAuthShape(connection)) return false;
  // A bundled local-engine connection is only usable when its engine process is
  // actually running. The persisted binding survives an app restart but the
  // subprocess does not, so "configured" must not be reported as "ready" — that
  // showed a green badge that failed the moment the writer pressed generate.
  // When no live set is supplied (legacy callers), keep the prior behaviour.
  if (isLocalEngineConnectionId(connection.id)) {
    return liveLocalEngineConnectionIds ? liveLocalEngineConnectionIds.has(connection.id) : true;
  }
  return true;
}

function hasUsableBinding(
  binding: CapabilityBinding | null | undefined,
  byId: Map<string, RuntimeConnection>,
  liveLocalEngineConnectionIds?: ReadonlySet<string>,
): boolean {
  if (!binding) return false;
  const primary = byId.get(binding.connectionId);
  if (primary && isUsableConnection(primary, liveLocalEngineConnectionIds)) return true;
  const fallback = binding.fallback ? byId.get(binding.fallback.connectionId) : null;
  return Boolean(fallback && isUsableConnection(fallback, liveLocalEngineConnectionIds));
}

/**
 * Whether a writing role has a connection that is ready to serve right now.
 *
 * Pass `liveLocalEngineConnectionIds` (the connection ids of currently-running
 * bundled engines, via {@link localEngineConnectionId}) so a bound-but-stopped
 * local engine is correctly reported as not-ready. Omitting it keeps the legacy
 * "configured = ready" behaviour for callers that can't observe liveness.
 */
export function hasConfiguredWritingConnection(
  roles: readonly CapabilityRole[] = DEFAULT_WRITING_ROLES,
  liveLocalEngineConnectionIds?: ReadonlySet<string>,
): boolean {
  const connections = getConnections();
  if (connections.length === 0) return false;
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  const profile = getCapabilityProfile();
  return roles.some(role => hasUsableBinding(profile[role], byId, liveLocalEngineConnectionIds));
}

/**
 * Liveness-aware writing readiness for the desktop shells. Ready = a writing
 * role has a usable binding right now: external/BYOK connections with auth, or a
 * bundled local-engine binding whose process is actually running. A random live
 * engine is not enough — if it is not bound to draft/planning, generation will
 * still fail when the writer presses generate.
 */
export function hasLiveWritingConnection(
  liveEngines: readonly { engineId: string }[],
  roles: readonly CapabilityRole[] = DEFAULT_WRITING_ROLES,
): boolean {
  const liveConnIds = new Set(liveEngines.map(engine => localEngineConnectionId(engine.engineId)));
  return hasConfiguredWritingConnection(roles, liveConnIds);
}
