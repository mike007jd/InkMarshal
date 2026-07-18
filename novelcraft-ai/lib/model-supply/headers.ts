'use client';

// CLIENT module. Builds the role-aware `x-im-*` request header set for a single
// writing operation.
//
// Flow: operation → OPERATION_ROLE[operation] → capability binding for that
// role → its RuntimeConnection → that connection's secret (keychain on desktop,
// localStorage transitional on web). ONLY the resolved role's connection +
// secret are emitted — no other role's binding/secret can leak into the
// headers (we read exactly one binding and never iterate the profile). The
// connection kind also rides along so the server can distinguish hosted
// OpenAI-compatible providers from keyless loopback runtimes.
//
// If the role is unbound or the connection is missing, we return `{}` — the
// server then sees no binding for this role and surfaces a "bind a model"
// error (AIUsageError); there is no silent server-side fallback. A missing
// binding is NOT an error here (graceful physical degradation, surfaced by
// B.4's capability status, not by a thrown header). A configured secret that
// cannot be read is different: that means the user explicitly selected a
// runtime/provider but the keychain is unavailable, so we throw to prevent a
// silent fallback to another provider.
//
// SECURITY: `x-im-secret` is only emitted client-side; the server only honors
// it behind the shared `requestAllowsUserRuntime` localhost gate. The header
// is omitted entirely when the connection has no secret — never sent empty.
// The secret value is never logged here.

import {
  getBindingForRole,
  getConnection,
  getConnectionSecret,
} from './connections';
import {
  engineStatus,
  isTauriRuntime,
  type EngineInfo,
} from '@/lib/desktop-runtime';
import {
  isLocalEngineConnectionId,
  localEngineConnectionId,
} from './local-engine';
import { OPERATION_ROLE, type CapabilityRole, type OperationKind, type RuntimeTransport } from './types';
import type { CapabilityBinding, RuntimeConnection } from './types';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import { normalizeStyleId } from '@/lib/style-id';
import { clientAllowsUserRuntimeHeaders } from '@/lib/user-runtime-origin';

/**
 * Optional knobs that ride alongside the role-aware `x-im-*` set:
 *
 * - `creativity`  → header `x-im-creativity` (`conservative|balanced|wild`),
 *   parsed server-side via {@link resolvePreset} to drive temperature/topP.
 * - `styleId`     → header `x-im-style-id`, the knowledge_entries id of a
 *   `style_reference` selected by the user (wave 4 commit F connects the
 *   server side; this commit only ships the transport).
 *
 * Both are best-effort: an invalid/empty value is omitted entirely so
 * the server sees no header rather than a garbage one.
 */
export interface AIHeaderOptions {
  creativity?: CreativityLevel;
  styleId?: string;
}

/**
 * Resolve `operation` → role → bound connection → secret and produce the
 * `x-im-*` header set for that one role. Returns `{}` (caller falls back) when
 * the role is unbound or the connection record is gone. Throws when a
 * configured secret cannot be read, preventing silent provider fallback.
 *
 * Optional `opts` enriches the set with `x-im-creativity`/`x-im-style-id` when
 * supplied. These are stand-alone hints — they're emitted
 * even when the role binding is missing (server reads them independently).
 */
export async function buildRoleAwareHeaders(
  operation: OperationKind,
  opts?: AIHeaderOptions,
): Promise<Record<string, string>> {
  const role = OPERATION_ROLE[operation];
  const base = await buildHeadersForRole(role, 'single');
  return { ...base, ...buildHintHeaders(opts) };
}

/**
 * Resolve every operation needed by one long-running request. The existing
 * `x-im-role` contract can only represent one role, so multi-phase routes send
 * role-scoped headers (`x-im-draft-model`, `x-im-planning-model`, ...). The
 * server checks those scoped headers after the legacy single-role shape.
 */
export async function buildRoleAwareHeadersForOperations(
  operations: readonly OperationKind[],
  opts?: AIHeaderOptions,
): Promise<Record<string, string>> {
  const roles = Array.from(new Set(operations.map(operation => OPERATION_ROLE[operation])));
  // A missing binding returns `{}`; the server then surfaces a "bind a model"
  // error for that role — there is no silent fallback. A configured-but-broken
  // binding is different: buildHeadersForRole rejects, and that rejection must
  // propagate so the request cannot silently run that role on the wrong model.
  const resolved = await Promise.all(roles.map(role => buildHeadersForRole(role, 'scoped')));
  return Object.assign({}, ...resolved, buildHintHeaders(opts));
}

function buildHintHeaders(opts: AIHeaderOptions | undefined): Record<string, string> {
  if (!opts) return {};
  const out: Record<string, string> = {};
  if (opts.creativity) {
    out['x-im-creativity'] = opts.creativity;
  }
  const styleId = normalizeStyleId(opts.styleId);
  if (styleId) {
    out['x-im-style-id'] = styleId;
  }
  return out;
}

async function buildHeadersForRole(
  role: CapabilityRole,
  mode: 'single' | 'scoped',
): Promise<Record<string, string>> {
  if (!clientAllowsUserRuntimeHeaders()) return {};
  const binding = getBindingForRole(role);
  if (!binding) return {};

  try {
    const primary = await buildHeadersForBinding(role, mode, binding);
    if (primary) return primary;
    if (!binding.fallback) return {};
    return (await buildHeadersForBinding(role, mode, binding.fallback)) ?? {};
  } catch (error) {
    if (!binding.fallback) throw error;
    try {
      const fallback = await buildHeadersForBinding(role, mode, binding.fallback);
      if (fallback) return fallback;
      const primary = error instanceof Error ? error.message : String(error);
      throw new Error(`Primary model is unavailable and fallback binding is incomplete. Primary: ${primary}`);
    } catch (fallbackError) {
      const primary = error instanceof Error ? error.message : String(error);
      const fallback = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Primary and fallback models are unavailable. Primary: ${primary} Fallback: ${fallback}`);
    }
  }
}

async function buildHeadersForBinding(
  role: CapabilityRole,
  mode: 'single' | 'scoped',
  binding: CapabilityBinding,
): Promise<Record<string, string> | null> {
  const connection = getConnection(binding.connectionId);
  if (!connection || !connection.baseUrl || !binding.modelId) {
    return null;
  }

  const runtime = await resolveVerifiedConnectionRuntime(connection);

  const prefix = mode === 'single' ? 'x-im' : `x-im-${role}`;
  const headers: Record<string, string> = mode === 'single'
    ? {
        'x-im-role': role,
        'x-im-kind': runtime.kind,
        'x-im-transport': runtime.transport,
        'x-im-base-url': runtime.baseUrl,
        'x-im-model': binding.modelId,
      }
    : {
        [`${prefix}-kind`]: runtime.kind,
        [`${prefix}-transport`]: runtime.transport,
        [`${prefix}-base-url`]: runtime.baseUrl,
        [`${prefix}-model`]: binding.modelId,
      };

  // Resolve the secret for THIS connection only. Connections without a
  // configured secretRef do not need keychain access (local runtimes commonly
  // use no key). If a configured secretRef exists but the keychain read fails,
  // block the request instead of silently falling through to any other runtime.
  let secret: string | null = null;
  if (connection.secretRef) {
    try {
      secret = await getConnectionSecret(connection.id);
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` ${error.message}` : '';
      throw new Error(`Unable to read the API key for "${connection.label}".${detail}`);
    }
    if (!secret || secret.trim().length === 0) {
      throw new Error(`The API key for "${connection.label}" is missing. Re-enter it in Settings.`);
    }
  }
  // OMIT the header entirely when there is no secret — never send it empty.
  // When `secret` is non-null it was already validated as non-blank above.
  if (secret) {
    headers[`${prefix}-secret`] = secret;
  }

  return headers;
}

async function resolveVerifiedConnectionRuntime(
  connection: Pick<RuntimeConnection, 'id' | 'label' | 'kind' | 'transport' | 'baseUrl'>,
): Promise<{ kind: RuntimeConnection['kind']; transport: RuntimeTransport; baseUrl: string }> {
  if (!isLocalEngineConnectionId(connection.id)) {
    return { kind: connection.kind, transport: connection.transport, baseUrl: connection.baseUrl };
  }
  if (!isTauriRuntime()) {
    throw new Error(`Local model runtime "${connection.label}" is only available in the desktop app.`);
  }

  let running: EngineInfo[];
  try {
    running = await engineStatus();
  } catch {
    throw new Error(`Unable to verify local model runtime "${connection.label}". Restart the local model.`);
  }

  const engine = running.find(item => localEngineConnectionId(item.engineId) === connection.id);
  if (!engine) {
    throw new Error(
      `Local model runtime "${connection.label}" is not running. Open Models, start the model again, or switch this task to a Standard (GGUF) model if it stops repeatedly.`,
    );
  }

  return {
    kind: 'local',
    transport: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${engine.port}/v1`,
  };
}
