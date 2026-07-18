// Phase 1 — durable-config cache layer. Verifies the runtime split: web/test
// goes straight to localStorage (no fetch), desktop write-throughs to SQLite +
// mirrors localStorage and reads from the in-memory cache, and boot hydration
// pulls SQLite into the cache then migrates legacy localStorage exactly once.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isTauri = vi.fn<() => boolean>(() => false);
vi.mock('@/lib/desktop-runtime', () => ({ isTauriRuntime: () => isTauri() }));

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) ?? null) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(): string | null {
    return null;
  }
  get length(): number {
    return this.m.size;
  }
}

async function load() {
  return import('@/lib/app-settings-client');
}

function patchCalls(fetchMock: ReturnType<typeof vi.fn>): Array<{ key: string; value: unknown }> {
  return fetchMock.mock.calls
    .filter(([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH')
    .map(([, opts]) => JSON.parse((opts as RequestInit).body as string));
}

beforeEach(() => {
  vi.resetModules();
  isTauri.mockReturnValue(false);
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('app-settings-client', () => {
  it('web runtime reads/writes localStorage only, never fetches', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { setStoredSetting, getStoredSetting } = await load();

    setStoredSetting('inkmarshal_settings', '{"theme":"dark"}');
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"dark"}');
    expect(localStorage.getItem('inkmarshal_settings')).toBe('{"theme":"dark"}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('desktop write-throughs to SQLite, mirrors localStorage, reads from cache', async () => {
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { setStoredSetting, getStoredSetting } = await load();

    setStoredSetting('inkmarshal_settings', '{"theme":"dark"}');
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"dark"}');
    expect(localStorage.getItem('inkmarshal_settings')).toBe('{"theme":"dark"}');

    await Promise.resolve(); // flush the void patchSetting microtask
    expect(patchCalls(fetchMock)).toContainEqual({
      key: 'inkmarshal_settings',
      value: '{"theme":"dark"}',
    });
  });

  it('serializes desktop writes to the same key', async () => {
    isTauri.mockReturnValue(true);
    let finishFirst!: (value: { ok: boolean }) => void;
    const first = new Promise<{ ok: boolean }>(resolve => {
      finishFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { getStoredSetting, setStoredSetting } = await load();

    setStoredSetting('inkmarshal_settings', '{"theme":"dark"}');
    setStoredSetting('inkmarshal_settings', '{"theme":"light"}');

    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"light"}');
    expect(patchCalls(fetchMock)).toEqual([
      { key: 'inkmarshal_settings', value: '{"theme":"dark"}' },
    ]);

    finishFirst({ ok: true });
    await vi.waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(2));
    expect(patchCalls(fetchMock)[1]).toEqual({
      key: 'inkmarshal_settings',
      value: '{"theme":"light"}',
    });
  });

  it('continues the same-key write queue after a failed request', async () => {
    isTauri.mockReturnValue(true);
    let failFirst!: (reason: Error) => void;
    const first = new Promise<never>((_resolve, reject) => {
      failFirst = reject;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { removeStoredSetting, setStoredSetting } = await load();

    setStoredSetting('inkmarshal_settings', '{"theme":"dark"}');
    removeStoredSetting('inkmarshal_settings');
    expect(patchCalls(fetchMock)).toHaveLength(1);

    failFirst(new Error('offline'));
    await vi.waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(2));
    expect(patchCalls(fetchMock)[1]).toEqual({
      key: 'inkmarshal_settings',
      value: null,
    });
  });

  it('hydrate pulls SQLite into cache and migrates legacy localStorage once', async () => {
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (!opts || opts.method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ settings: { inkmarshal_connections_v1: '[]' } }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    // A legacy value present only in localStorage (SQLite doesn't have it yet).
    localStorage.setItem('inkmarshal_settings', '{"theme":"dark"}');
    localStorage.setItem('inkmarshal_workspace_views_v1', '{"stale":"story-deck"}');

    const { hydrateAppSettings, getStoredSetting } = await load();
    await hydrateAppSettings();

    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[]'); // from SQLite
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"dark"}'); // migrated
    const keys = patchCalls(fetchMock).map(c => c.key);
    expect(keys).toContain('inkmarshal_settings');
    expect(keys).not.toContain('inkmarshal_workspace_views_v1');
    expect(keys).toContain('ls_migrated_v1');
  });

  it('hydrate does not re-migrate when the sentinel is already set', async () => {
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ settings: { ls_migrated_v1: '1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('inkmarshal_settings', '{"theme":"dark"}');

    const { hydrateAppSettings, getStoredSetting } = await load();
    await hydrateAppSettings();

    // Legacy localStorage value must NOT be migrated back into SQLite.
    expect(patchCalls(fetchMock)).toHaveLength(0);
    // Reads still fall back to the localStorage mirror for an un-hydrated key.
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"dark"}');
  });

  it('fires hydration listeners once on completion', async () => {
    isTauri.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ settings: { ls_migrated_v1: '1' } }) }),
    );
    const { hydrateAppSettings, onAppSettingsHydrated } = await load();
    const cb = vi.fn();
    onAppSettingsHydrated(cb);
    await hydrateAppSettings();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('onAppSettingsHydrated fires immediately if already hydrated', async () => {
    isTauri.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ settings: { ls_migrated_v1: '1' } }) }),
    );
    const { hydrateAppSettings, onAppSettingsHydrated } = await load();
    await hydrateAppSettings();
    const cb = vi.fn();
    onAppSettingsHydrated(cb);
    expect(cb).toHaveBeenCalledOnce();
  });
});
