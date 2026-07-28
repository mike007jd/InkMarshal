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
  rollbackStoredSettingMirrorAfterFailedDurableAttempt,
  setStoredSetting,
  setStoredSettingDurable,
} from '@/lib/app-settings-client';

const CONNECTIONS_KEY = 'inkmarshal_connections_v1';
const PROFILE_KEY = 'inkmarshal_capability_profile_v1';
const MAX_CONNECTION_ID_LENGTH = 2_048;
const MAX_CONNECTION_LABEL_LENGTH = 200;
const MAX_CONNECTION_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 512;
const CONNECTION_PERSISTENCE_FAILED = 'Failed to persist connection settings';
const CONNECTION_PERSISTENCE_AND_COMPENSATION_FAILED =
  'Failed to persist connection settings, and secret compensation also failed';
const PROFILE_PERSISTENCE_FAILED = 'Failed to persist capability profile';

let connectionMutationTail: Promise<void> = Promise.resolve();
let profileMutationTail: Promise<void> = Promise.resolve();

function enqueueConnectionMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = connectionMutationTail.then(mutation, mutation);
  connectionMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function enqueueProfileMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = profileMutationTail.then(mutation, mutation);
  profileMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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

/**
 * Await the authoritative connections-row write. On failure, restore the
 * previous cache/localStorage mirror (without enqueueing another SQLite PATCH)
 * and throw a stable persistence error. Callers must emit change notifications
 * only after this resolves.
 */
async function writeConnectionsDurable(list: RuntimeConnection[]): Promise<void> {
  if (!hasStorage()) {
    throw new Error(CONNECTION_PERSISTENCE_FAILED);
  }
  const previous = getStoredSetting(CONNECTIONS_KEY);
  const attempted = JSON.stringify(list);
  const ok = await setStoredSettingDurable(CONNECTIONS_KEY, attempted);
  if (ok) return;
  rollbackStoredSettingMirrorAfterFailedDurableAttempt(CONNECTIONS_KEY, attempted, previous);
  throw new Error(CONNECTION_PERSISTENCE_FAILED);
}

async function captureConnectionSecret(account: string): Promise<string | null> {
  return getSecret(account);
}

async function restoreConnectionSecret(account: string, prior: string | null): Promise<void> {
  if (prior === null) {
    await deleteSecret(account);
  } else {
    await setSecret(account, prior);
  }
}

async function compensateConnectionSecretOrThrow(
  account: string,
  prior: string | null,
): Promise<never> {
  try {
    await restoreConnectionSecret(account, prior);
  } catch {
    throw new Error(CONNECTION_PERSISTENCE_AND_COMPENSATION_FAILED);
  }
  throw new Error(CONNECTION_PERSISTENCE_FAILED);
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
 * If the previous connection had a secret and the endpoint changes, capture and
 * delete the secret before awaiting the durable connection row. A keychain
 * failure must leave the old row visible so the user can retry instead of
 * orphaning `connection:<id>`. A failed row write restores the captured key.
 */
async function upsertConnectionWithSecretCleanupNow(
  input: ConnectionUpsertInput,
): Promise<RuntimeConnection> {
  const prepared = prepareConnectionUpsert(input, readConnections(), nowIso());
  let capturedStaleSecret: string | null = null;
  if (prepared.staleSecretAccount) {
    // Locked read/delete must leave the visible row untouched.
    capturedStaleSecret = await captureConnectionSecret(prepared.staleSecretAccount);
    await deleteSecret(prepared.staleSecretAccount);
  }
  if (prepared.shouldWrite) {
    try {
      await writeConnectionsDurable(prepared.list);
    } catch (error) {
      if (prepared.staleSecretAccount) {
        await compensateConnectionSecretOrThrow(
          prepared.staleSecretAccount,
          capturedStaleSecret,
        );
      }
      throw error;
    }
    emitConnectionsChanged();
  }
  return prepared.connection;
}

export function upsertConnectionWithSecretCleanup(
  input: ConnectionUpsertInput,
): Promise<RuntimeConnection> {
  return enqueueConnectionMutation(() => upsertConnectionWithSecretCleanupNow(input));
}

/**
 * Save a provider/custom connection and an optional newly-entered key as one
 * ordered operation. When a key is provided, write it before mutating the row
 * so a keychain failure cannot leave the UI pointing at a half-saved endpoint.
 * The connections row is awaited durably; on failure the prior key is restored
 * or the newly created key is deleted.
 */
async function saveConnectionWithOptionalSecretNow(
  input: ConnectionUpsertInput,
  secretValue?: string,
): Promise<RuntimeConnection> {
  const trimmedSecret = typeof secretValue === 'string' ? secretValue.trim() : '';
  if (!trimmedSecret) return upsertConnectionWithSecretCleanupNow(input);

  const prepared = prepareConnectionUpsert(input, readConnections(), nowIso());
  if (!canAttachConnectionSecret(prepared.connection)) {
    throw new Error('Runtime connection API keys require HTTPS or a loopback HTTP runtime');
  }
  const account = connectionSecretAccount(prepared.connection.id);
  // Endpoint changes clear secretRef on the prepared row but keep the same
  // `connection:<id>` account; capture any prior key before overwriting.
  const priorSecret =
    prepared.connection.secretRef || prepared.staleSecretAccount
      ? await captureConnectionSecret(account)
      : null;
  await setSecret(account, trimmedSecret);
  const nextList = prepared.list.map(connection =>
    connection.id === prepared.connection.id
      ? {
          ...connection,
          secretRef: connectionSecretRef(prepared.connection.id),
          updatedAt: nowIso(),
        }
      : connection,
  );
  try {
    await writeConnectionsDurable(nextList);
  } catch {
    await compensateConnectionSecretOrThrow(account, priorSecret);
  }
  emitConnectionsChanged();
  return {
    ...prepared.connection,
    secretRef: connectionSecretRef(prepared.connection.id),
  };
}

export function saveConnectionWithOptionalSecret(
  input: ConnectionUpsertInput,
  secretValue?: string,
): Promise<RuntimeConnection> {
  return enqueueConnectionMutation(() => saveConnectionWithOptionalSecretNow(input, secretValue));
}

/**
 * Remove a connection and delete its secret from secret-store.
 *
 * Order matters: delete the secret FIRST, then await the durable connections
 * list without it. A failed secret delete must leave the connection visible so
 * the user can retry removal; otherwise the keychain entry becomes orphaned with
 * no UI path to clear it. A failed row write restores the captured key.
 * Idempotent: a missing connection row is a no-op.
 */
async function removeConnectionNow(id: string): Promise<void> {
  const connectionId = normalizeConnectionId(id);
  if (!connectionId) return;
  const list = readConnections();
  const idx = list.findIndex(c => c.id === connectionId);
  if (idx < 0) return;

  // Only touch secret-store when a secret is actually bound; a keyless row
  // (local-engine, always secretRef:null) has no keychain entry and off-desktop
  // the fail-closed store would throw.
  const account = connectionSecretAccount(connectionId);
  let capturedSecret: string | null = null;
  if (list[idx].secretRef) {
    capturedSecret = await captureConnectionSecret(account);
    await deleteSecret(account);
  }
  const next = list.filter(c => c.id !== connectionId);
  try {
    await writeConnectionsDurable(next);
  } catch (error) {
    if (list[idx].secretRef) {
      await compensateConnectionSecretOrThrow(account, capturedSecret);
    }
    throw error;
  }
  emitConnectionsChanged();
}

export function removeConnection(id: string): Promise<void> {
  return enqueueConnectionMutation(() => removeConnectionNow(id));
}

// ── Per-connection secret (keychain on desktop, never the localStorage blob) ─

/** Store a connection's API key/token in secret-store under its namespaced account. */
async function setConnectionSecretNow(id: string, value: string): Promise<void> {
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

  const account = connectionSecretAccount(connectionId);
  const hadSecretRef = Boolean(list[idx].secretRef);
  const priorSecret = hadSecretRef ? await captureConnectionSecret(account) : null;
  await setSecret(account, value);
  // Ensure the connection record references the secret (idempotent).
  if (!hadSecretRef) {
    const next = list.slice();
    next[idx] = {
      ...list[idx],
      secretRef: connectionSecretRef(connectionId),
      updatedAt: nowIso(),
    };
    try {
      await writeConnectionsDurable(next);
    } catch {
      await compensateConnectionSecretOrThrow(account, priorSecret);
    }
  }
  // The "Key set" badge is driven by secret presence; notify subscribers so
  // sibling panels reflect it without a manual refresh.
  emitConnectionsChanged();
}

export function setConnectionSecret(id: string, value: string): Promise<void> {
  return enqueueConnectionMutation(() => setConnectionSecretNow(id, value));
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
async function getConnectionSecretNow(id: string): Promise<string | null> {
  const connectionId = normalizeConnectionId(id);
  if (!connectionId) return null;
  const connection = readConnections().find(c => c.id === connectionId);
  // No row, or a row with no secret bound (e.g. a local-engine connection, which
  // is always secretRef:null) → unbound. Skip secret-store entirely: it has no
  // entry, and off-desktop the fail-closed store rejects rather than answering.
  if (!connection?.secretRef) return null;
  return getSecret(connectionSecretAccount(connectionId));
}

export function getConnectionSecret(id: string): Promise<string | null> {
  return enqueueConnectionMutation(() => getConnectionSecretNow(id));
}

function matchesSecretEndpointSnapshot(
  current: RuntimeConnection,
  snapshot: RuntimeConnection,
): boolean {
  return (
    current.id === snapshot.id
    && current.kind === snapshot.kind
    && current.transport === snapshot.transport
    && current.baseUrl === snapshot.baseUrl
    && (current.secretRef?.account ?? null) === (snapshot.secretRef?.account ?? null)
  );
}

/**
 * Resolve a secret only while the supplied endpoint snapshot is still current.
 *
 * The comparison and keychain read share the connection-mutation queue. An
 * endpoint+key update therefore cannot expose its new key to a health/header
 * request that already captured the old endpoint.
 */
export function getConnectionSecretForSnapshot(
  snapshot: RuntimeConnection,
): Promise<string | null> {
  return enqueueConnectionMutation(async () => {
    const current = readConnections().find(connection => connection.id === snapshot.id);
    if (!current || !matchesSecretEndpointSnapshot(current, snapshot)) {
      throw new Error('Runtime connection changed before secret resolution');
    }
    return getConnectionSecretNow(snapshot.id);
  });
}

/** Delete only the secret for a connection, leaving the connection record. */
async function clearConnectionSecretNow(id: string): Promise<void> {
  const connectionId = normalizeConnectionId(id);
  if (!connectionId) return;
  const list = readConnections();
  const idx = list.findIndex(c => c.id === connectionId);
  if (idx < 0) return;

  // Nothing bound → nothing to clear (and off-desktop deleteSecret would throw).
  if (!list[idx].secretRef) return;
  const account = connectionSecretAccount(connectionId);
  const priorSecret = await captureConnectionSecret(account);
  await deleteSecret(account);
  const next = list.slice();
  next[idx] = { ...list[idx], secretRef: null, updatedAt: nowIso() };
  try {
    await writeConnectionsDurable(next);
  } catch {
    await compensateConnectionSecretOrThrow(account, priorSecret);
  }
  emitConnectionsChanged();
}

export function clearConnectionSecret(id: string): Promise<void> {
  return enqueueConnectionMutation(() => clearConnectionSecretNow(id));
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

/**
 * Await the authoritative capability-profile write. On failure, restore the
 * previous cache/localStorage mirror (without enqueueing another SQLite PATCH)
 * and throw a stable persistence error. Callers must emit change notifications
 * only after this resolves.
 */
async function writeProfileDurable(profile: CapabilityProfile): Promise<void> {
  if (!hasStorage()) {
    throw new Error(PROFILE_PERSISTENCE_FAILED);
  }
  const previous = getStoredSetting(PROFILE_KEY);
  const attempted = JSON.stringify(profile);
  const ok = await setStoredSettingDurable(PROFILE_KEY, attempted);
  if (ok) return;
  rollbackStoredSettingMirrorAfterFailedDurableAttempt(PROFILE_KEY, attempted, previous);
  throw new Error(PROFILE_PERSISTENCE_FAILED);
}

export function getCapabilityProfile(): CapabilityProfile {
  return readProfile();
}

export function getBindingForRole(role: CapabilityRole): CapabilityBinding | null {
  return readProfile()[role] ?? null;
}

export type CapabilityBindingMutation =
  | {
      role: CapabilityRole;
      connectionId: string;
      modelId: string;
      fallback?: { connectionId: string; modelId: string };
    }
  | { role: CapabilityRole; binding: null };

export interface CapabilityProfileExclusiveContext {
  /** Re-read the latest profile while the mutation queue is exclusively held. */
  read(): CapabilityProfile;
  /** Persist mutations without re-entering (and deadlocking) the same queue. */
  save(mutations: readonly CapabilityBindingMutation[]): Promise<CapabilityProfile>;
}

function applyCapabilityBindingMutations(
  profile: CapabilityProfile,
  mutations: readonly CapabilityBindingMutation[],
): { profile: CapabilityProfile; changed: boolean } {
  const next: CapabilityProfile = { ...profile };
  const validConnectionIds = new Set(readConnections().map(connection => connection.id));
  let changed = false;
  for (const mutation of mutations) {
    if ('binding' in mutation && mutation.binding === null) {
      if (next[mutation.role] !== null) {
        next[mutation.role] = null;
        changed = true;
      }
      continue;
    }
    if (!('connectionId' in mutation)) continue;
    const binding = sanitizeBinding(
      {
        connectionId: mutation.connectionId,
        modelId: mutation.modelId,
        fallback: mutation.fallback,
      },
      validConnectionIds,
    );
    if (JSON.stringify(next[mutation.role]) !== JSON.stringify(binding)) {
      next[mutation.role] = binding;
      changed = true;
    }
  }
  return { profile: next, changed };
}

/**
 * Bind a capability role to a connection + model (optional fallback).
 *
 * Synchronous mirror write retained for tests / read-only fixtures. Production
 * UI and orchestrator mutations must use {@link saveCapabilityBindingDurable}
 * or {@link saveCapabilityBindingsDurable}.
 */
export function saveCapabilityBinding(
  role: CapabilityRole,
  connectionId: string,
  modelId: string,
  fallback?: { connectionId: string; modelId: string },
): CapabilityProfile {
  const { profile, changed } = applyCapabilityBindingMutations(readProfile(), [
    { role, connectionId, modelId, fallback },
  ]);
  if (!changed) return profile;
  writeProfile(profile);
  emitConnectionsChanged();
  return profile;
}

/**
 * Clear a role's binding (set it back to unbound/null).
 *
 * Synchronous mirror write retained for tests / read-only fixtures. Production
 * UI and orchestrator mutations must use {@link clearCapabilityBindingDurable}
 * or {@link saveCapabilityBindingsDurable}.
 */
export function clearCapabilityBinding(role: CapabilityRole): CapabilityProfile {
  const { profile, changed } = applyCapabilityBindingMutations(readProfile(), [
    { role, binding: null },
  ]);
  if (!changed) return profile;
  writeProfile(profile);
  emitConnectionsChanged();
  return profile;
}

/**
 * Apply one or more capability-role mutations in a single durable profile write.
 * On SQLite failure the mirror is compare-and-restored and subscribers are not
 * notified — callers must not treat the rejection as a successful bind/clear.
 */
export async function saveCapabilityBindingsDurable(
  mutations: readonly CapabilityBindingMutation[],
): Promise<CapabilityProfile> {
  return enqueueProfileMutation(() => saveCapabilityBindingsDurableNow(mutations));
}

async function saveCapabilityBindingsDurableNow(
  mutations: readonly CapabilityBindingMutation[],
): Promise<CapabilityProfile> {
  if (mutations.length === 0) return readProfile();
  const { profile, changed } = applyCapabilityBindingMutations(readProfile(), mutations);
  if (!changed) return profile;
  await writeProfileDurable(profile);
  emitConnectionsChanged();
  return profile;
}

/**
 * Hold the capability-profile queue across a lifecycle decision and its
 * associated side effects. This is reserved for engine compensation/stop
 * paths that must compare current bindings and act before a newer bind can
 * interleave. The callback must use the supplied `save` helper instead of
 * calling a public durable profile mutation (which would re-enter the queue).
 */
export function runCapabilityProfileExclusive<T>(
  operation: (context: CapabilityProfileExclusiveContext) => Promise<T>,
): Promise<T> {
  return enqueueProfileMutation(() =>
    operation({
      read: readProfile,
      save: saveCapabilityBindingsDurableNow,
    }),
  );
}

/** Durable single-role bind. Prefer {@link saveCapabilityBindingsDurable} for batches. */
export async function saveCapabilityBindingDurable(
  role: CapabilityRole,
  connectionId: string,
  modelId: string,
  fallback?: { connectionId: string; modelId: string },
): Promise<CapabilityProfile> {
  return saveCapabilityBindingsDurable([{ role, connectionId, modelId, fallback }]);
}

/** Durable single-role clear. Prefer {@link saveCapabilityBindingsDurable} for batches. */
export async function clearCapabilityBindingDurable(
  role: CapabilityRole,
): Promise<CapabilityProfile> {
  return saveCapabilityBindingsDurable([{ role, binding: null }]);
}

// After desktop boot hydration swaps the cache from the (possibly empty,
// port-changed) localStorage mirror to the SQLite-authoritative values, wake
// every `subscribeConnectionsStore` consumer so status strips / binding panels
// re-read instead of showing a stale first-paint "no connections" state.
onAppSettingsHydrated(emitConnectionsChanged);
