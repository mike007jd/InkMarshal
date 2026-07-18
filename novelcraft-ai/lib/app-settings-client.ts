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
import {
  APP_SETTINGS_KEYS,
  APP_SETTINGS_MIGRATION_SENTINEL,
  isWritableAppSettingKey,
} from '@/lib/app-settings-keys';

const cache = new Map<string, string>();
const settingPatchTails = new Map<string, Promise<boolean>>();
let hydrated = false;
const hydratedListeners = new Set<() => void>();

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

/** Synchronous read — localStorage.getItem semantics (string | null). */
export function getStoredSetting(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null;
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
    cache.set(key, value);
    safeLocalSet(key, value);
    if (isWritableAppSettingKey(key)) void patchSetting(key, value);
  } else {
    safeLocalSet(key, value);
  }
}

export function removeStoredSetting(key: string): void {
  if (isTauriRuntime()) {
    cache.delete(key);
    safeLocalRemove(key);
    if (isWritableAppSettingKey(key)) void patchSetting(key, null);
  } else {
    safeLocalRemove(key);
  }
}

/**
 * One-time desktop boot: pull SQLite into the cache, then migrate any durable
 * localStorage key SQLite doesn't have yet. Idempotent across calls and
 * crash-safe: the per-key "only when SQLite is empty" guard plus the
 * sentinel-written-last ordering make a partial run safe to re-run, and the old
 * localStorage keys are intentionally left in place this release as a rollback
 * fallback. No-op off-desktop. Fires hydration listeners on completion so
 * already-mounted consumers re-read the now-authoritative values.
 */
export async function hydrateAppSettings(): Promise<void> {
  if (hydrated || !isTauriRuntime()) return;

  let settings: Record<string, string> = {};
  try {
    const res = await fetch('/api/app-settings', { method: 'GET' });
    if (res.ok) {
      const json = (await res.json()) as { settings?: Record<string, string> };
      settings = json.settings ?? {};
    }
  } catch {
    // Leave the cache empty → reads fall back to the localStorage mirror this
    // session; a later mutation still write-throughs to SQLite.
    return;
  }

  for (const [key, value] of Object.entries(settings)) cache.set(key, value);

  if (!settings[APP_SETTINGS_MIGRATION_SENTINEL]) {
    // Migrate each legacy key SQLite doesn't have yet. Cache writes are sync; the
    // SQLite write-throughs run in parallel, and the sentinel is written only
    // after they all settle so a crash mid-migration safely re-runs.
    const migrations: Promise<boolean>[] = [];
    for (const key of APP_SETTINGS_KEYS) {
      if (cache.has(key)) continue; // SQLite already authoritative — never overwrite.
      const legacy = safeLocalGet(key);
      if (legacy != null) {
        cache.set(key, legacy);
        migrations.push(patchSetting(key, legacy));
      }
    }
    // Mark migration done ONLY when every key reached SQLite. A failed write
    // leaves the sentinel unset so the next boot retries that key (this session
    // still has it cached, and the localStorage original remains the fallback) —
    // critical because a later release deletes the localStorage mirror.
    const results = await Promise.all(migrations);
    if (results.every(Boolean)) {
      cache.set(APP_SETTINGS_MIGRATION_SENTINEL, '1');
      await patchSetting(APP_SETTINGS_MIGRATION_SENTINEL, '1');
    }
  }

  hydrated = true;
  for (const cb of Array.from(hydratedListeners)) {
    try {
      cb();
    } catch {
      // A throwing listener must not abort the rest of the fan-out.
    }
  }
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
  hydrated = false;
  hydratedListeners.clear();
}
