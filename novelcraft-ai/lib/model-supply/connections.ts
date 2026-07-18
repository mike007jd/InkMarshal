'use client';

// Multi-connection store + capability profile.
//
// Storage split (CONTRACT):
//   - Non-secret connection fields  -> localStorage `inkmarshal_connections_v1`
//   - Capability profile (role→bind)-> localStorage `inkmarshal_capability_profile_v1`
//   - Secrets (API keys)            -> secret-store ONLY, under the namespaced
//                                      account `connection:<id>` (keychain on
//                                      desktop). Plaintext keys NEVER touch the
//                                      connections localStorage blob.

import {
  CAPABILITY_ROLES,
  connectionSecretAccount,
  connectionSecretRef,
  isRuntimeConnectionKind,
  isRuntimeTransport,
  type CapabilityBinding,
  type CapabilityProfile,
  type CapabilityRole,
  type RuntimeConnection,
} from './types';
import { deleteSecret, getSecret, setSecret } from './secret-store';
import { isLoopbackHttpUrl } from '@/lib/loopback-hosts';
import {
  getStoredSetting,
  onAppSettingsHydrated,
  setStoredSetting,
} from '@/lib/app-settings-client';

const CONNECTIONS_KEY = 'inkmarshal_connections_v1';
const PROFILE_KEY = 'inkmarshal_capability_profile_v1';
const MAX_CONNECTION_ID_LENGTH = 2_048;
const MAX_CONNECTION_LABEL_LENGTH = 200;
const MAX_CONNECTION_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 512;
function boundedTrim(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function normalizeConnectionId(value: unknown): string | null {
  const id = boundedTrim(value, MAX_CONNECTION_ID_LENGTH);
  if (!id || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

// ── Same-document reactivity (purely additive — no signature/behavior change) ─
//
// The store is plain localStorage with no change notification, so a mutation in
// one React subtree (e.g. binding a model in Settings) can't re-render a sibling
// subtree (the writing-panel status strip). This is a tiny same-document
// pub/sub: every mutation calls `emitConnectionsChanged()`, and clients
// `subscribeConnectionsStore(cb)` to re-read. It is SSR-safe — no `window`
// access at module top-level, and the cross-tab `storage` listener attaches
// lazily and only when a real `window.addEventListener` exists.

type ConnectionsListener = () => void;

const connectionsListeners = new Set<ConnectionsListener>();
let storageListenerAttached = false;

/**
 * Subscribe to any connection/profile mutation (and cross-tab `storage`
 * events). Returns an unsubscribe function. Safe to call during render-effects;
 * never fires synchronously on subscribe and never during SSR.
 */
export function subscribeConnectionsStore(cb: ConnectionsListener): () => void {
  connectionsListeners.add(cb);
  // Attach the cross-tab listener lazily on first subscribe — guarded so SSR
  // (no window) and the node test shim (window without addEventListener) are
  // both no-ops.
  if (
    !storageListenerAttached &&
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  ) {
    storageListenerAttached = true;
    window.addEventListener('storage', e => {
      if (e.key === CONNECTIONS_KEY || e.key === PROFILE_KEY) {
        emitConnectionsChanged();
      }
    });
  }
  return () => {
    connectionsListeners.delete(cb);
  };
}

let emitScheduled = false;

/**
 * Notify all same-document subscribers that the store changed. Coalesced to
 * one async fan-out per tick: a single user action that performs several
 * mutations (e.g. binding all four capability roles + upserting the engine
 * connection on "Use") would otherwise trigger one full re-read/refresh per
 * mutation. Subscribers only need the post-batch state, so collapse them.
 */
function emitConnectionsChanged(): void {
  if (emitScheduled) return;
  emitScheduled = true;
  const flush = () => {
    emitScheduled = false;
    for (const cb of Array.from(connectionsListeners)) {
      try {
        cb();
      } catch {
        // A throwing listener must not abort the rest of the fan-out or the
        // mutation that triggered it.
      }
    }
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(flush);
  else Promise.resolve().then(flush);
}

function nowIso(): string {
  return new Date().toISOString();
}

function canAttachConnectionSecret(connection: Pick<RuntimeConnection, 'baseUrl'>): boolean {
  try {
    const url = new URL(connection.baseUrl);
    return url.protocol === 'https:' || isLoopbackHttpUrl(url);
  } catch {
    return false;
  }
}

export function normalizeConnectionBaseUrl(
  raw: string,
  kind: RuntimeConnection['kind'] = 'custom',
): string | null {
  try {
    const value = raw.trim();
    if (!value) return null;
    if (value.length > MAX_CONNECTION_BASE_URL_LENGTH) return null;
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (kind === 'provider' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function sanitizeSecretRef(value: unknown, connectionId: string): RuntimeConnection['secretRef'] {
  if (!value || typeof value !== 'object') return null;
  const account = (value as { account?: unknown }).account;
  if (typeof account !== 'string' || !account.trim()) return null;
  const trimmed = account.trim();
  if (trimmed !== connectionSecretAccount(connectionId)) return null;
  return { account: trimmed };
}

function sanitizeConnection(value: unknown): RuntimeConnection | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<RuntimeConnection> & { apiKey?: unknown };
  const id = normalizeConnectionId(raw.id);
  const label = boundedTrim(raw.label, MAX_CONNECTION_LABEL_LENGTH);
  if (!id || !label || !isRuntimeConnectionKind(raw.kind) || !isRuntimeTransport(raw.transport)) {
    return null;
  }
  const baseUrl = typeof raw.baseUrl === 'string' ? normalizeConnectionBaseUrl(raw.baseUrl, raw.kind) : null;
  if (!baseUrl) return null;
  const sanitized = {
    id,
    label,
    kind: raw.kind,
    transport: raw.transport,
    baseUrl,
    secretRef: sanitizeSecretRef(raw.secretRef, id),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
  if (sanitized.secretRef && !canAttachConnectionSecret(sanitized)) {
    sanitized.secretRef = null;
  }
  return sanitized;
}

/**
 * Generate a stable unique id for a connection. Prefers a platform UUID but
 * has a non-UUID fallback (`conn-<base36>-<rand>`) for older embedded
 * webviews — so the result is NOT guaranteed to be a UUID. B.3/B.4 must treat
 * it as an opaque stable unique id and MUST NOT parse/validate it as a UUID.
 */
function newId(): string {
  // Prefer the platform UUID; fall back to a sufficiently-unique id when
  // crypto.randomUUID is unavailable (older embedded webviews).
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Connections CRUD ────────────────────────────────────────────────────────

type ConnectionUpsertInput = Omit<RuntimeConnection, 'id' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<RuntimeConnection, 'id' | 'createdAt' | 'updatedAt'>>;

interface PreparedConnectionUpsert {
  connection: RuntimeConnection;
  list: RuntimeConnection[];
  shouldWrite: boolean;
  staleSecretAccount: string | null;
}

function readConnections(): RuntimeConnection[] {
  if (!hasStorage()) return [];
  try {
    const raw = getStoredSetting(CONNECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cleaned = parsed
      .map(item => sanitizeConnection(item))
      .filter((item): item is RuntimeConnection => item !== null);
    if (JSON.stringify(cleaned) !== JSON.stringify(parsed)) {
      writeConnections(cleaned);
    }
    return cleaned;
  } catch {
    return [];
  }
}

function writeConnections(list: RuntimeConnection[]): void {
  if (!hasStorage()) return;
  setStoredSetting(CONNECTIONS_KEY, JSON.stringify(list));
}

export function getConnections(): RuntimeConnection[] {
  return readConnections();
}

export function getConnection(id: string): RuntimeConnection | undefined {
  return readConnections().find(c => c.id === id);
}

/**
 * Insert or update a connection. New connections get a stable unique id +
 * createdAt; existing ones (matched by `id`) keep their id/createdAt and only refresh
 * updatedAt. The plaintext key is never accepted here — use
 * {@link setConnectionSecret}; `secretRef` is only a pointer to an already
 * configured secret, not proof that a key exists.
 */
function prepareConnectionUpsert(
  input: ConnectionUpsertInput,
  list: RuntimeConnection[],
  ts: string,
): PreparedConnectionUpsert {
  const inputId = input.id === undefined ? undefined : normalizeConnectionId(input.id);
  if (input.id !== undefined && !inputId) {
    throw new Error('Runtime connection id is invalid');
  }
  const label = boundedTrim(input.label, MAX_CONNECTION_LABEL_LENGTH);
  if (!label) {
    throw new Error('Runtime connection label is invalid');
  }
  const existingIndex = inputId ? list.findIndex(c => c.id === inputId) : -1;
  const baseUrl = normalizeConnectionBaseUrl(input.baseUrl, input.kind);
  if (!baseUrl) {
    throw new Error('Runtime connection base URL must be a valid allowed URL without credentials, query, or fragment');
  }

  if (existingIndex >= 0) {
    const prev = list[existingIndex];
    const endpointUnchanged =
      prev.kind === input.kind &&
      prev.transport === input.transport &&
      prev.baseUrl === baseUrl;
    const secretRef = endpointUnchanged
      ? sanitizeSecretRef(input.secretRef, prev.id) ?? prev.secretRef ?? null
      : null;
    // Re-registering an unchanged connection (e.g. clicking "Use" again on the
    // already-running engine) must not churn storage or wake subscribers —
    // only the timestamp would differ, which is not a meaningful change.
    const unchanged =
      endpointUnchanged &&
      prev.label === label &&
      (prev.secretRef?.account ?? null) === (secretRef?.account ?? null);
    if (unchanged) {
      return {
        connection: prev,
        list,
        shouldWrite: false,
        staleSecretAccount: null,
      };
    }
    const merged: RuntimeConnection = {
      ...prev,
      label,
      kind: input.kind,
      transport: input.transport,
      baseUrl,
      secretRef,
      updatedAt: ts,
    };
    const next = list.slice();
    next[existingIndex] = merged;
    return {
      connection: merged,
      list: next,
      shouldWrite: true,
      staleSecretAccount:
        !endpointUnchanged && prev.secretRef ? connectionSecretAccount(prev.id) : null,
    };
  }

  const id = inputId ?? newId();
  const created: RuntimeConnection = {
    id,
    label,
    kind: input.kind,
    transport: input.transport,
    baseUrl,
    secretRef: sanitizeSecretRef(input.secretRef, id),
    createdAt: input.createdAt ?? ts,
    updatedAt: ts,
  };
  return {
    connection: created,
    list: [...list, created],
    shouldWrite: true,
    staleSecretAccount: null,
  };
}

export function upsertConnection(input: ConnectionUpsertInput): RuntimeConnection {
  const prepared = prepareConnectionUpsert(input, readConnections(), nowIso());
  if (prepared.staleSecretAccount) {
    throw new Error('Runtime connection endpoint change requires clearing the existing secret first');
  }
  if (prepared.shouldWrite) {
    writeConnections(prepared.list);
    emitConnectionsChanged();
  }
  return prepared.connection;
}

/**
 * Insert/update a connection when endpoint-defining fields may change.
 *
 * If the previous connection had a secret and the endpoint changes, delete the
 * secret before mutating the connection row. A keychain failure must leave the
 * old row visible so the user can retry instead of orphaning `connection:<id>`.
 */
export async function upsertConnectionWithSecretCleanup(
  input: ConnectionUpsertInput,
): Promise<RuntimeConnection> {
  const prepared = prepareConnectionUpsert(input, readConnections(), nowIso());
  if (prepared.staleSecretAccount) {
    await deleteSecret(prepared.staleSecretAccount);
  }
  if (prepared.shouldWrite) {
    writeConnections(prepared.list);
    emitConnectionsChanged();
  }
  return prepared.connection;
}

/**
 * Save a provider/custom connection and an optional newly-entered key as one
 * ordered operation. When a key is provided, write it before mutating the row
 * so a keychain failure cannot leave the UI pointing at a half-saved endpoint.
 */
export async function saveConnectionWithOptionalSecret(
  input: ConnectionUpsertInput,
  secretValue?: string,
): Promise<RuntimeConnection> {
  const trimmedSecret = typeof secretValue === 'string' ? secretValue.trim() : '';
  if (!trimmedSecret) return upsertConnectionWithSecretCleanup(input);

  const prepared = prepareConnectionUpsert(input, readConnections(), nowIso());
  if (!canAttachConnectionSecret(prepared.connection)) {
    throw new Error('Runtime connection API keys require HTTPS or a loopback HTTP runtime');
  }
  await setSecret(connectionSecretAccount(prepared.connection.id), trimmedSecret);
  const nextList = prepared.list.map(connection =>
    connection.id === prepared.connection.id
      ? {
          ...connection,
          secretRef: connectionSecretRef(prepared.connection.id),
          updatedAt: nowIso(),
        }
      : connection,
  );
  if (prepared.shouldWrite || !prepared.connection.secretRef) {
    writeConnections(nextList);
  }
  emitConnectionsChanged();
  return {
    ...prepared.connection,
    secretRef: connectionSecretRef(prepared.connection.id),
  };
}

/**
 * Remove a connection and delete its secret from secret-store.
 *
 * Order matters: delete the secret FIRST, then write the connections list
 * without it. A failed secret delete must leave the connection visible so the
 * user can retry removal; otherwise the keychain entry becomes orphaned with no
 * UI path to clear it. Idempotent: a missing connection row is a no-op.
 */
export async function removeConnection(id: string): Promise<void> {
  const connectionId = normalizeConnectionId(id);
  if (!connectionId) return;
  const list = readConnections();
  const idx = list.findIndex(c => c.id === connectionId);
  if (idx < 0) return;

  // Only touch secret-store when a secret is actually bound; a keyless row
  // (local-engine, always secretRef:null) has no keychain entry and off-desktop
  // the fail-closed store would throw.
  if (list[idx].secretRef) {
    await deleteSecret(connectionSecretAccount(connectionId));
  }
  const next = list.filter(c => c.id !== connectionId);
  writeConnections(next);
  emitConnectionsChanged();
}

// ── Per-connection secret (keychain on desktop, never the localStorage blob) ─

/** Store a connection's API key/token in secret-store under its namespaced account. */
export async function setConnectionSecret(id: string, value: string): Promise<void> {
  const connectionId = normalizeConnectionId(id);
  if (!connectionId) {
    throw new Error('Runtime connection id is invalid');
  }
  const list = readConnections();
  const idx = list.findIndex(c => c.id === connectionId);
  if (idx < 0) {
    throw new Error('Runtime connection does not exist');
  }
  if (!canAttachConnectionSecret(list[idx])) {
    throw new Error('Runtime connection API keys require HTTPS or a loopback HTTP runtime');
  }

  await setSecret(connectionSecretAccount(connectionId), value);
  // Ensure the connection record references the secret (idempotent).
  if (!list[idx].secretRef) {
    list[idx] = { ...list[idx], secretRef: connectionSecretRef(connectionId), updatedAt: nowIso() };
    writeConnections(list);
  }
  // The "Key set" badge is driven by secret presence; notify subscribers so
  // sibling panels reflect it without a manual refresh.
  emitConnectionsChanged();
}

/**
 * Resolve a connection's plaintext secret (from keychain/localStorage), or null.
 *
 * Contract: a resolved `null` means ONLY "no secret stored for this
 * connection" (unbound). A real keychain failure (keyring locked/unavailable)
 * does NOT collapse to `null` — it REJECTS. Callers (B.3 resolver / B.4 UI)
 * must distinguish "unbound" (null) from "keychain error" (catch) and surface
 * an actionable message instead of treating a rejection as "no key".
 */
export async function getConnectionSecret(id: string): Promise<string | null> {
  const connectionId = normalizeConnectionId(id);
  if (!connectionId) return null;
  const connection = readConnections().find(c => c.id === connectionId);
  // No row, or a row with no secret bound (e.g. a local-engine connection, which
  // is always secretRef:null) → unbound. Skip secret-store entirely: it has no
  // entry, and off-desktop the fail-closed store rejects rather than answering.
  if (!connection?.secretRef) return null;
  return getSecret(connectionSecretAccount(connectionId));
}

/** Delete only the secret for a connection, leaving the connection record. */
export async function clearConnectionSecret(id: string): Promise<void> {
  const connectionId = normalizeConnectionId(id);
  if (!connectionId) return;
  const list = readConnections();
  const idx = list.findIndex(c => c.id === connectionId);
  if (idx < 0) return;

  // Nothing bound → nothing to clear (and off-desktop deleteSecret would throw).
  if (!list[idx].secretRef) return;
  await deleteSecret(connectionSecretAccount(connectionId));
  list[idx] = { ...list[idx], secretRef: null, updatedAt: nowIso() };
  writeConnections(list);
  emitConnectionsChanged();
}

// ── Capability profile (role → binding) ─────────────────────────────────────

function emptyProfile(): CapabilityProfile {
  return { draft: null, rewrite: null, planning: null, recall: null };
}

function sanitizeBinding(
  value: unknown,
  validConnectionIds: Set<string>,
): CapabilityBinding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<CapabilityBinding>;
  const connectionId = normalizeConnectionId(raw.connectionId);
  const modelId = boundedTrim(raw.modelId, MAX_MODEL_ID_LENGTH);
  if (!connectionId || !modelId || !validConnectionIds.has(connectionId)) return null;

  const binding: CapabilityBinding = { connectionId, modelId };
  const fallback = raw.fallback;
  if (fallback && typeof fallback === 'object') {
    const fallbackRaw = fallback as Partial<CapabilityBinding>;
    const fallbackConnectionId = normalizeConnectionId(fallbackRaw.connectionId);
    const fallbackModelId = boundedTrim(fallbackRaw.modelId, MAX_MODEL_ID_LENGTH);
    if (
      fallbackConnectionId &&
      fallbackModelId &&
      fallbackConnectionId !== connectionId &&
      validConnectionIds.has(fallbackConnectionId)
    ) {
      binding.fallback = {
        connectionId: fallbackConnectionId,
        modelId: fallbackModelId,
      };
    }
  }
  return binding;
}

function readProfile(): CapabilityProfile {
  if (!hasStorage()) return emptyProfile();
  try {
    const raw = getStoredSetting(PROFILE_KEY);
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyProfile();
    const validConnectionIds = new Set(readConnections().map(connection => connection.id));
    const cleaned = emptyProfile();
    for (const role of CAPABILITY_ROLES) {
      cleaned[role] = sanitizeBinding(
        (parsed as Partial<Record<CapabilityRole, unknown>>)[role],
        validConnectionIds,
      );
    }
    if (JSON.stringify(cleaned) !== JSON.stringify(parsed)) {
      writeProfile(cleaned);
    }
    return cleaned;
  } catch {
    return emptyProfile();
  }
}

function writeProfile(profile: CapabilityProfile): void {
  if (!hasStorage()) return;
  setStoredSetting(PROFILE_KEY, JSON.stringify(profile));
}

export function getCapabilityProfile(): CapabilityProfile {
  return readProfile();
}

export function getBindingForRole(role: CapabilityRole): CapabilityBinding | null {
  return readProfile()[role] ?? null;
}

/** Bind a capability role to a connection + model (optional fallback). */
export function saveCapabilityBinding(
  role: CapabilityRole,
  connectionId: string,
  modelId: string,
  fallback?: { connectionId: string; modelId: string },
): CapabilityProfile {
  const profile = readProfile();
  const validConnectionIds = new Set(readConnections().map(connection => connection.id));
  const binding = sanitizeBinding(
    { connectionId, modelId, fallback },
    validConnectionIds,
  );
  if (!binding) {
    profile[role] = null;
    writeProfile(profile);
    emitConnectionsChanged();
    return profile;
  }
  const prev = profile[role];
  if (prev && JSON.stringify(prev) === JSON.stringify(binding)) return profile;
  profile[role] = binding;
  writeProfile(profile);
  emitConnectionsChanged();
  return profile;
}

/** Clear a role's binding (set it back to unbound/null). */
export function clearCapabilityBinding(role: CapabilityRole): CapabilityProfile {
  const profile = readProfile();
  profile[role] = null;
  writeProfile(profile);
  emitConnectionsChanged();
  return profile;
}

// After desktop boot hydration swaps the cache from the (possibly empty,
// port-changed) localStorage mirror to the SQLite-authoritative values, wake
// every `subscribeConnectionsStore` consumer so status strips / binding panels
// re-read instead of showing a stale first-paint "no connections" state.
onAppSettingsHydrated(emitConnectionsChanged);
