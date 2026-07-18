'use client';

// CLIENT module. Thin helper over B.2's Rust `runtime_health` (via the B.1
// `runtimeHealth` desktop wrapper) for probing a RuntimeConnection's
// reachability/transport/models.
//
// Web/non-Tauri: real health checks need the desktop runtime (raw cross-origin
// probes to localhost runtimes are blocked by the browser). Return a sensible
// DEGRADED `ConnectionHealth` (reachable:false) instead of throwing — B.4
// surfaces it as "Runtime health checks require the desktop app".

import { isTauriRuntime, runtimeHealth } from '@/lib/desktop-runtime';
import { getConnectionSecret } from './connections';
import type { ConnectionHealth, RuntimeConnection } from './types';

function webDegradedHealth(): ConnectionHealth {
  return {
    reachable: false,
    transportOk: false,
    models: [],
    latencyMs: 0,
    message: 'Runtime health checks require the desktop app',
  };
}

/**
 * Probe a {@link RuntimeConnection}. Maps the connection → the
 * `{ connectionId, baseUrl, transport }` input the Rust command expects.
 * Never throws: a non-desktop environment or a probe failure resolves to a
 * degraded `ConnectionHealth` so callers can render status without try/catch.
 */
export async function checkConnectionHealth(
  connection: RuntimeConnection,
): Promise<ConnectionHealth> {
  if (!isTauriRuntime()) return webDegradedHealth();
  try {
    const secret = connection.secretRef
      ? await getConnectionSecret(connection.id)
      : null;
    return await runtimeHealth({
      connectionId: connection.id,
      baseUrl: connection.baseUrl,
      transport: connection.transport,
      secret,
    });
  } catch (error) {
    return {
      reachable: false,
      transportOk: false,
      models: [],
      latencyMs: 0,
      message:
        error instanceof Error && error.message
          ? error.message
          : 'Runtime health probe failed',
    };
  }
}
