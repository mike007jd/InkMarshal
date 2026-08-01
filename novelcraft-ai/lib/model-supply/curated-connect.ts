// Client-side orchestration for curated / custom provider connect-and-use.
// Health (model availability) + real generation must both succeed before any
// secret or connection row is persisted. Four-role binding is atomic; binding
// failure compensates by deleting the new connection and key.

import {
  removeConnection,
  saveCapabilityBindingsDurable,
  saveConnectionWithOptionalSecret,
} from './connections';
import { CAPABILITY_ROLES, type RuntimeConnection, type RuntimeConnectionKind, type RuntimeTransport } from './types';
import type { GenerationProbeFailureCategory, GenerationProbeResult } from './generation-probe';

export type ConnectFailureCategory =
  | 'desktop-required'
  | 'unreachable'
  | 'verification-failed'
  | 'model-unavailable'
  | 'probe-failed'
  | GenerationProbeFailureCategory
  | 'bind-failed'
  | 'rollback-failed'
  | 'save-failed';

export type ConnectProviderResult =
  | { ok: true; connection: RuntimeConnection }
  | { ok: false; category: Exclude<ConnectFailureCategory, 'rollback-failed'>; saved: false }
  | {
      ok: false;
      category: 'rollback-failed';
      saved: true;
      connection: RuntimeConnection;
    };

export interface ConnectProviderInput {
  label: string;
  kind: RuntimeConnectionKind;
  transport: RuntimeTransport;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  /** Desktop runtimeHealth probe. */
  checkHealth: () => Promise<{
    reachable: boolean;
    transportOk: boolean;
    models: string[];
    failureKind?: 'desktop-required' | 'probe-failed';
  }>;
  /** Loopback generation probe (POST /api/model-supply/generation-probe). */
  runGenerationProbe: () => Promise<GenerationProbeResult>;
}

function healthCategory(
  health: Awaited<ReturnType<ConnectProviderInput['checkHealth']>>,
): Exclude<ConnectFailureCategory, 'rollback-failed'> {
  if (health.failureKind === 'desktop-required') return 'desktop-required';
  if (health.failureKind === 'probe-failed') return 'probe-failed';
  if (health.reachable && !health.transportOk) return 'verification-failed';
  return 'unreachable';
}

async function compensateNewConnection(connectionId: string): Promise<boolean> {
  // A transient durable-setting or keychain failure should not strand a
  // connection. Retry once; if both attempts fail, return an explicit retained
  // state so the UI can keep it visible and recoverable instead of claiming
  // that nothing was saved.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await removeConnection(connectionId);
      return true;
    } catch {
      // Retry once, then report the retained connection truthfully.
    }
  }
  return false;
}

/**
 * Probe → save → bind-all-roles for a new provider/custom connection.
 * On any failure before bind completes, nothing remains persisted (or the
 * just-created connection is compensated away).
 */
export async function connectProviderWithRealProbe(
  input: ConnectProviderInput,
): Promise<ConnectProviderResult> {
  const modelId = input.modelId.trim();
  const baseUrl = input.baseUrl.trim();
  const label = input.label.trim();
  const apiKey = input.apiKey.trim();
  if (!label || !baseUrl || !modelId) {
    return { ok: false, category: 'save-failed', saved: false };
  }

  const health = await input.checkHealth();
  if (!(health.reachable && health.transportOk)) {
    return { ok: false, category: healthCategory(health), saved: false };
  }
  // When the runtime advertises models, require the chosen id to be present.
  if (health.models.length > 0 && !health.models.includes(modelId)) {
    return { ok: false, category: 'model-unavailable', saved: false };
  }

  const probe = await input.runGenerationProbe();
  if (!probe.ok) {
    return { ok: false, category: probe.category, saved: false };
  }

  let connection: RuntimeConnection;
  try {
    connection = await saveConnectionWithOptionalSecret(
      {
        label,
        kind: input.kind,
        transport: input.transport,
        baseUrl,
      },
      apiKey || undefined,
    );
  } catch {
    return { ok: false, category: 'save-failed', saved: false };
  }

  try {
    await saveCapabilityBindingsDurable(
      CAPABILITY_ROLES.map(role => ({
        role,
        connectionId: connection.id,
        modelId,
      })),
    );
  } catch {
    const removed = await compensateNewConnection(connection.id);
    if (!removed) {
      return {
        ok: false,
        category: 'rollback-failed',
        saved: true,
        connection,
      };
    }
    return { ok: false, category: 'bind-failed', saved: false };
  }

  return { ok: true, connection };
}
