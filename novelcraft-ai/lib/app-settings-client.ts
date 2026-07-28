'use client';

// Client-side durable-config cache (Phase 1). A localStorage-shaped synchronous
// shim whose authoritative backend is SQLite (origin-independent) on desktop,
// so durable config survives a runtime-port change. Each client store
// (settings / connections / capability profile / engine launch plans) swaps its
// three localStorage primitives for the ones here and keeps all of its own
// sanitize/serialize logic unchanged.
//
// Behaviour by runtime:
//   - Desktop (Tauri): reads serve from an in-memory cache hydrated once at boot
//     from SQLite (hydrateAppSettings); writes go write-through to SQLite AND a
//     localStorage mirror. The mirror is non-authoritative — it only feeds the
//     inline theme/locale FOUC scripts and the first paint before hydration. A
//     port change empties the mirror, so the first paint may briefly show
//     defaults, then hydration restores the real values (vastly better than the
//     old behaviour, where a port change lost the config permanently).
//   - Web / tests (no Tauri): reads and writes go straight to localStorage. This
//     keeps every existing localStorage-mocking test working with zero changes,
//     and the web landing site never touches SQLite.

import { isTauriRuntime } from '@/lib/desktop-runtime';
import { isWritableAppSettingKey } from '@/lib/app-settings-keys';

const cache = new Map<string, string>();
const settingPatchTails = new Map<string, Promise<boolean>>();
const preHydrationMutatedKeys = new Set<string>();
const preHydrationPatchResults = new Map<string, Promise<boolean>>();
let hydrated = false;
let hydrationPromise: Promise<boolean> | null = null;
const hydratedListeners = new Set<() => void>();

function markPreHydrationMutation(key: string): void {
  if (!hydrated) preHydrationMutatedKeys.add(key);
}

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
    // Storage can fail in private mode; the in-memory cache still holds it.
  }
}

function safeLocalRemove(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Non-fatal — see safeLocalSet.
  }
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
      // Best-effort: the localStorage mirror still holds the value this session.
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

function patchSettingTrackedForHydration(
  key: string,
  value: string | null,
): Promise<boolean> {
  const request = patchSetting(key, value);
  if (!hydrated) preHydrationPatchResults.set(key, request);
  return request;
}

/** Synchronous read — localStorage.getItem semantics (string | null). */
export function getStoredSetting(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null;
  // Once desktop SQLite hydration succeeds, cache absence is authoritative.
  // The localStorage mirror is only permitted before hydration for first paint.
  if (isTauriRuntime() && hydrated) return null;
  return safeLocalGet(key);
}

/**
 * Synchronous write-through. Desktop: in-memory cache + SQLite (authoritative)
 * + localStorage mirror (first-paint/FOUC). Web/test: localStorage only. Never
 * throws — callers (saveSettings, writeConnections, …) treat persistence as
 * best-effort.
 */
export function setStoredSetting(key: string, value: string): void {
  if (isTauriRuntime()) {
    markPreHydrationMutation(key);
    cache.set(key, value);
    safeLocalSet(key, value);
    if (isWritableAppSettingKey(key)) {
      void patchSettingTrackedForHydration(key, value);
    }
  } else {
    safeLocalSet(key, value);
  }
}

export function removeStoredSetting(key: string): void {
  if (isTauriRuntime()) {
    markPreHydrationMutation(key);
    cache.delete(key);
    safeLocalRemove(key);
    if (isWritableAppSettingKey(key)) {
      void patchSettingTrackedForHydration(key, null);
    }
  } else {
    safeLocalRemove(key);
  }
}

/**
 * Persist a value and resolve only after the authoritative desktop SQLite
 * write has completed. The synchronous API remains for low-risk preferences;
 * crash-recovery payloads use this barrier so callers can observe failure.
 */
export function setStoredSettingDurable(key: string, value: string): Promise<boolean> {
  if (!isTauriRuntime()) {
    safeLocalSet(key, value);
    return Promise.resolve(true);
  }
  markPreHydrationMutation(key);
  cache.set(key, value);
  safeLocalSet(key, value);
  return isWritableAppSettingKey(key)
    ? patchSettingTrackedForHydration(key, value)
    : Promise.resolve(false);
}

export function removeStoredSettingDurable(key: string): Promise<boolean> {
  if (!isTauriRuntime()) {
    safeLocalRemove(key);
    return Promise.resolve(true);
  }
  markPreHydrationMutation(key);
  cache.delete(key);
  safeLocalRemove(key);
  return isWritableAppSettingKey(key)
    ? patchSettingTrackedForHydration(key, null)
    : Promise.resolve(false);
}

/**
 * Compare-and-restore the in-memory cache + localStorage mirror after a failed
 * durable SQLite attempt. Restores `previousValue` only when the current cache
 * still equals the attempted value (string for set, absent/null for remove), so
 * a newer queued write is never clobbered. Never enqueues another SQLite PATCH.
 */
export function rollbackStoredSettingMirrorAfterFailedDurableAttempt(
  key: string,
  attemptedValue: string | null,
  previousValue: string | null,
): void {
  if (isTauriRuntime()) {
    const current = cache.has(key) ? (cache.get(key) ?? null) : null;
    if (current !== attemptedValue) return;
    if (previousValue === null) {
      cache.delete(key);
      safeLocalRemove(key);
    } else {
      cache.set(key, previousValue);
      safeLocalSet(key, previousValue);
    }
    return;
  }

  // Web/test: no SQLite queue, but keep the same compare-and-restore contract
  // against the localStorage mirror for callers/tests that exercise it.
  const current = safeLocalGet(key);
  if (current !== attemptedValue) return;
  if (previousValue === null) safeLocalRemove(key);
  else safeLocalSet(key, previousValue);
}

/**
 * Desktop boot: pull the one current product shape from SQLite into the cache.
 * localStorage is only a first-paint mirror and is never imported into the
 * authoritative store. No-op off-desktop. Fires hydration listeners on
 * completion so already-mounted consumers re-read the authoritative values.
 */
export function hydrateAppSettings(): Promise<boolean> {
  if (!isTauriRuntime() || hydrated) return Promise.resolve(true);
  if (hydrationPromise) return hydrationPromise;

  const request = (async (): Promise<boolean> => {
    const fetchSnapshot = async (): Promise<Record<string, string> | null> => {
      try {
        const res = await fetch('/api/app-settings', { method: 'GET' });
        if (!res.ok) return null;
        const json = (await res.json()) as { settings?: Record<string, string> };
        return json.settings ?? {};
      } catch {
        return null;
      }
    };

    let settings = await fetchSnapshot();
    if (!settings) return false;

    // Reconcile every mutation that began before hydration completed. A
    // successful final PATCH owns its cache value; a failed final PATCH forces
    // a fresh authoritative snapshot so an earlier successful write in the same
    // per-key queue is also represented correctly.
    const successfulOverlapKeys = new Set<string>();
    while (preHydrationPatchResults.size > 0) {
      const batch = Array.from(preHydrationPatchResults.entries());
      const results = await Promise.all(
        batch.map(async ([key, pending]) => ({
          key,
          pending,
          ok: await pending,
        })),
      );
      let refetch = false;
      for (const { key, pending, ok } of results) {
        if (preHydrationPatchResults.get(key) !== pending) continue;
        preHydrationPatchResults.delete(key);
        if (ok) {
          successfulOverlapKeys.add(key);
        } else {
          successfulOverlapKeys.delete(key);
          refetch = true;
        }
      }
      if (refetch) {
        settings = await fetchSnapshot();
        if (!settings) return false;
      }
    }

    const preserveLocalValue = (key: string): boolean =>
      successfulOverlapKeys.has(key)
      || (preHydrationMutatedKeys.has(key) && !isWritableAppSettingKey(key));
    for (const key of Array.from(cache.keys())) {
      if (!preserveLocalValue(key) && !Object.hasOwn(settings, key)) {
        cache.delete(key);
      }
    }
    for (const [key, value] of Object.entries(settings)) {
      if (!preserveLocalValue(key)) cache.set(key, value);
    }

    hydrated = true;
    preHydrationMutatedKeys.clear();
    preHydrationPatchResults.clear();
    for (const cb of Array.from(hydratedListeners)) {
      try {
        cb();
      } catch {
        // A throwing listener must not abort the rest of the fan-out.
      }
    }
    return true;
  })().finally(() => {
    if (hydrationPromise === request) hydrationPromise = null;
  });
  hydrationPromise = request;
  return request;
}

/**
 * Run `cb` once hydration has populated the cache (immediately if already
 * hydrated). Stores that drive React subscriptions use this to refresh
 * consumers after a port-change first paint. Returns an unsubscribe fn.
 */
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
  settingPatchTails.clear();
  preHydrationMutatedKeys.clear();
  preHydrationPatchResults.clear();
  hydrated = false;
  hydrationPromise = null;
  hydratedListeners.clear();
}
