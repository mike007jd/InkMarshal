'use client';

// Client-side durable-config cache. A localStorage-shaped synchronous shim
// whose authoritative backend is SQLite (origin-independent) on desktop.
//
// Desktop reads serve from memory after one authoritative hydration. Writes go
// through to SQLite and a localStorage first-paint mirror. Web/test callers keep
// direct localStorage semantics.

import { isTauriRuntime } from '@/lib/desktop-runtime';
import {
  APP_SETTINGS_CURRENT_ONLY_KEYS,
  APP_SETTINGS_KEYS,
  isWritableAppSettingKey,
} from '@/lib/app-settings-keys';

const ALL_WRITABLE_KEYS: readonly string[] = [
  ...APP_SETTINGS_KEYS,
  ...APP_SETTINGS_CURRENT_ONLY_KEYS,
];

const cache = new Map<string, string>();
/** Hydration must never overwrite a local set/remove that started after its GET. */
const mutationGeneration = new Map<string, number>();
const settingPatchTails = new Map<string, Promise<boolean>>();
const hydratedListeners = new Set<() => void>();
let hydrated = false;
let hydrateInFlight: Promise<HydrateAppSettingsResult> | null = null;

const HYDRATE_MAX_ATTEMPTS = 3;
const HYDRATE_RETRY_DELAYS_MS = [0, 150, 400] as const;

export type HydrateAppSettingsResult =
  | { ok: true }
  | { ok: false; error: string };

function safeLocalGet(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSet(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // The in-memory cache still owns this session.
  }
}

function safeLocalRemove(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // The in-memory cache still owns this session.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function bumpMutation(key: string): void {
  mutationGeneration.set(key, (mutationGeneration.get(key) ?? 0) + 1);
}

function snapshotMutationGenerations(): Map<string, number> {
  return new Map(mutationGeneration);
}

async function patchSetting(key: string, value: string | null): Promise<boolean> {
  const send = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/app-settings', {
        method: 'PATCH',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const previous = settingPatchTails.get(key);
  const request = previous ? previous.then(send, send) : send();
  settingPatchTails.set(key, request);
  const clearTail = () => {
    if (settingPatchTails.get(key) === request) settingPatchTails.delete(key);
  };
  void request.then(clearTail, clearTail);
  return request;
}

/** Synchronous localStorage.getItem-compatible read. */
export function getStoredSetting(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null;
  // After desktop hydration, cache absence is authoritative. The mirror is
  // permitted only before hydration for first paint.
  if (isTauriRuntime() && hydrated) return null;
  return safeLocalGet(key);
}

export function setStoredSetting(key: string, value: string): void {
  if (!isTauriRuntime()) {
    safeLocalSet(key, value);
    return;
  }
  bumpMutation(key);
  cache.set(key, value);
  safeLocalSet(key, value);
  if (isWritableAppSettingKey(key)) void patchSetting(key, value);
}

export function removeStoredSetting(key: string): void {
  if (!isTauriRuntime()) {
    safeLocalRemove(key);
    return;
  }
  bumpMutation(key);
  cache.delete(key);
  safeLocalRemove(key);
  if (isWritableAppSettingKey(key)) void patchSetting(key, null);
}

/** Resolve only after the authoritative desktop PATCH has completed. */
export function setStoredSettingDurable(key: string, value: string): Promise<boolean> {
  if (!isTauriRuntime()) {
    safeLocalSet(key, value);
    return Promise.resolve(true);
  }
  bumpMutation(key);
  cache.set(key, value);
  safeLocalSet(key, value);
  return isWritableAppSettingKey(key) ? patchSetting(key, value) : Promise.resolve(false);
}

export function removeStoredSettingDurable(key: string): Promise<boolean> {
  if (!isTauriRuntime()) {
    safeLocalRemove(key);
    return Promise.resolve(true);
  }
  bumpMutation(key);
  cache.delete(key);
  safeLocalRemove(key);
  return isWritableAppSettingKey(key) ? patchSetting(key, null) : Promise.resolve(false);
}

/**
 * Compare-and-restore the mirror after a failed durable attempt. A newer write
 * wins because restoration only occurs while the attempted value is current.
 */
export function rollbackStoredSettingMirrorAfterFailedDurableAttempt(
  key: string,
  attemptedValue: string | null,
  previousValue: string | null,
): void {
  if (isTauriRuntime()) {
    const current = cache.has(key) ? (cache.get(key) ?? null) : null;
    if (current !== attemptedValue) return;
    bumpMutation(key);
    if (previousValue === null) {
      cache.delete(key);
      safeLocalRemove(key);
    } else {
      cache.set(key, previousValue);
      safeLocalSet(key, previousValue);
    }
    return;
  }

  if (safeLocalGet(key) !== attemptedValue) return;
  if (previousValue === null) safeLocalRemove(key);
  else safeLocalSet(key, previousValue);
}

function notifyHydrated(): void {
  for (const cb of Array.from(hydratedListeners)) {
    try {
      cb();
    } catch {
      // A throwing listener must not abort the rest of the fan-out.
    }
  }
}

async function fetchAuthoritativeSettings(): Promise<Record<string, string>> {
  const res = await fetch('/api/app-settings', { method: 'GET' });
  if (!res.ok) {
    throw new Error(`app-settings GET returned HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  if (
    !json
    || typeof json !== 'object'
    || Array.isArray(json)
    || !Object.prototype.hasOwnProperty.call(json, 'settings')
  ) {
    throw new Error('app-settings GET returned an invalid payload');
  }
  const settings = (json as { settings: unknown }).settings;
  if (
    !settings
    || typeof settings !== 'object'
    || Array.isArray(settings)
    || Object.values(settings).some(value => typeof value !== 'string')
  ) {
    throw new Error('app-settings GET returned an invalid payload');
  }
  return settings as Record<string, string>;
}

function applyAuthoritativeSettings(
  settings: Record<string, string>,
  gensAtStart: Map<string, number>,
): void {
  for (const key of ALL_WRITABLE_KEYS) {
    if ((mutationGeneration.get(key) ?? 0) !== (gensAtStart.get(key) ?? 0)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      const value = settings[key]!;
      cache.set(key, value);
      safeLocalSet(key, value);
    } else {
      cache.delete(key);
      safeLocalRemove(key);
    }
  }
}

async function waitForQueuedSettingPatches(): Promise<void> {
  while (settingPatchTails.size > 0) {
    await Promise.allSettled(Array.from(settingPatchTails.values()));
  }
}

async function beginAuthoritativeFetchAfterQueuedPatches(): Promise<{
  gensAtStart: Map<string, number>;
  request: Promise<Record<string, string>>;
}> {
  for (;;) {
    await waitForQueuedSettingPatches();
    // Dispatch GET in the same continuation as the empty-queue check.
    if (settingPatchTails.size === 0) {
      return {
        gensAtStart: snapshotMutationGenerations(),
        request: fetchAuthoritativeSettings(),
      };
    }
  }
}

function writableMutationChanged(gensAtStart: Map<string, number>): boolean {
  return ALL_WRITABLE_KEYS.some(
    key => (mutationGeneration.get(key) ?? 0) !== (gensAtStart.get(key) ?? 0),
  );
}

async function hydrateWithBoundedRetries(): Promise<HydrateAppSettingsResult> {
  let lastError = 'app-settings hydration failed';
  for (let attempt = 0; attempt < HYDRATE_MAX_ATTEMPTS; attempt++) {
    const delay = HYDRATE_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delay > 0) await sleep(delay);
    try {
      const { gensAtStart, request } = await beginAuthoritativeFetchAfterQueuedPatches();
      const settings = await request;
      // Any write that starts while GET is in flight makes that snapshot
      // temporally ambiguous. Start over: the next iteration first drains the
      // PATCH queue, then takes a snapshot that is newer than its outcome.
      // This also covers the reverse race where GET resolves before a durable
      // PATCH fails and its caller restores the previous mirror.
      if (writableMutationChanged(gensAtStart)) {
        lastError = 'app-settings changed during hydration';
        continue;
      }
      applyAuthoritativeSettings(settings, gensAtStart);
      hydrated = true;
      notifyHydrated();
      return { ok: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Pull authoritative SQLite settings. Failure never masquerades as an empty
 * successful snapshot; callers may retry on focus/online.
 */
export async function hydrateAppSettings(): Promise<HydrateAppSettingsResult> {
  if (!isTauriRuntime() || hydrated) return { ok: true };
  if (hydrateInFlight) return hydrateInFlight;

  hydrateInFlight = hydrateWithBoundedRetries().finally(() => {
    hydrateInFlight = null;
  });
  return hydrateInFlight;
}

export function isAppSettingsHydrated(): boolean {
  return hydrated || !isTauriRuntime();
}

export function onAppSettingsHydrated(cb: () => void): () => void {
  if (hydrated) {
    cb();
    return () => {};
  }
  hydratedListeners.add(cb);
  return () => {
    hydratedListeners.delete(cb);
  };
}

/** Test-only reset of module singletons. */
export function __resetAppSettingsClientForTest(): void {
  cache.clear();
  mutationGeneration.clear();
  settingPatchTails.clear();
  hydratedListeners.clear();
  hydrated = false;
  hydrateInFlight = null;
}
