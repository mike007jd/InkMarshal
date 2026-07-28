// Phase 1 — durable-config cache layer. Verifies the runtime split: web/test
// goes straight to localStorage (no fetch), desktop write-throughs to SQLite +
// mirrors localStorage and reads from the in-memory cache, and boot hydration
// pulls SQLite into the cache without importing unpublished localStorage shapes.

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

  it('writes manuscript recovery through the current-only SQLite allowlist', async () => {
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { setStoredSetting } = await load();
    const value = '{"novel-1":{"1":{"content":"draft","version":2,"savedAt":1}}}';

    setStoredSetting('inkmarshal_manuscript_recovery_v1', value);

    await vi.waitFor(() => expect(patchCalls(fetchMock)).toContainEqual({
      key: 'inkmarshal_manuscript_recovery_v1',
      value,
    }));
    expect(localStorage.getItem('inkmarshal_manuscript_recovery_v1')).toBe(value);
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

  it('hydrate treats SQLite presence and absence as authoritative over localStorage', async () => {
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
    localStorage.setItem('inkmarshal_settings', '{"theme":"dark"}');
    localStorage.setItem('inkmarshal_workspace_views_v1', '{"stale":"story-deck"}');

    const { hydrateAppSettings, getStoredSetting } = await load();
    await hydrateAppSettings();

    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[]'); // from SQLite
    expect(getStoredSetting('inkmarshal_settings')).toBeNull();
    expect(getStoredSetting('inkmarshal_workspace_views_v1')).toBeNull();
    expect(patchCalls(fetchMock)).toHaveLength(0);
  });

  it('does not revive stale connection or profile mirrors when SQLite has no keys', async () => {
    isTauri.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ settings: {} }),
      }),
    );
    localStorage.setItem(
      'inkmarshal_connections_v1',
      '[{"id":"stale","baseUrl":"https://stale.invalid/v1"}]',
    );
    localStorage.setItem(
      'inkmarshal_capability_profile_v1',
      '{"draft":{"connectionId":"stale","modelId":"stale-model"}}',
    );

    const { getStoredSetting, hydrateAppSettings } = await load();
    await expect(hydrateAppSettings()).resolves.toBe(true);

    expect(getStoredSetting('inkmarshal_connections_v1')).toBeNull();
    expect(getStoredSetting('inkmarshal_capability_profile_v1')).toBeNull();
  });

  it('fires hydration listeners once on completion', async () => {
    isTauri.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ settings: {} }) }),
    );
    const { hydrateAppSettings, onAppSettingsHydrated } = await load();
    const cb = vi.fn();
    onAppSettingsHydrated(cb);
    await hydrateAppSettings();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('preserves a successful durable mutation that overlaps an older hydration snapshot', async () => {
    isTauri.mockReturnValue(true);
    let finishGet!: (value: {
      ok: boolean;
      json: () => Promise<{ settings: Record<string, string> }>;
    }) => void;
    const pendingGet = new Promise<{
      ok: boolean;
      json: () => Promise<{ settings: Record<string, string> }>;
    }>(resolve => {
      finishGet = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'GET') return pendingGet;
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const {
      getStoredSetting,
      hydrateAppSettings,
      setStoredSettingDurable,
    } = await load();

    const hydration = hydrateAppSettings();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/app-settings',
      { method: 'GET' },
    ));
    await expect(
      setStoredSettingDurable('inkmarshal_connections_v1', '[{"id":"new"}]'),
    ).resolves.toBe(true);
    finishGet({
      ok: true,
      json: async () => ({
        settings: { inkmarshal_connections_v1: '[{"id":"old"}]' },
      }),
    });

    await expect(hydration).resolves.toBe(true);
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[{"id":"new"}]');
    expect(localStorage.getItem('inkmarshal_connections_v1')).toBe('[{"id":"new"}]');
  });

  it('uses the authoritative snapshot when an overlapping durable mutation fails', async () => {
    isTauri.mockReturnValue(true);
    let finishFirstGet!: (value: {
      ok: boolean;
      json: () => Promise<{ settings: Record<string, string> }>;
    }) => void;
    const firstGet = new Promise<{
      ok: boolean;
      json: () => Promise<{ settings: Record<string, string> }>;
    }>(resolve => {
      finishFirstGet = resolve;
    });
    let getCount = 0;
    const authoritative = '[{"id":"authoritative"}]';
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return Promise.resolve({ ok: false });
      getCount += 1;
      if (getCount === 1) return firstGet;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          settings: { inkmarshal_connections_v1: authoritative },
        }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('inkmarshal_connections_v1', '[{"id":"stale-mirror"}]');
    const {
      getStoredSetting,
      hydrateAppSettings,
      rollbackStoredSettingMirrorAfterFailedDurableAttempt,
      setStoredSettingDurable,
    } = await load();

    const hydration = hydrateAppSettings();
    const attempted = '[{"id":"attempted"}]';
    await expect(
      setStoredSettingDurable('inkmarshal_connections_v1', attempted),
    ).resolves.toBe(false);
    rollbackStoredSettingMirrorAfterFailedDurableAttempt(
      'inkmarshal_connections_v1',
      attempted,
      '[{"id":"stale-mirror"}]',
    );
    finishFirstGet({
      ok: true,
      json: async () => ({
        settings: { inkmarshal_connections_v1: '[{"id":"old-snapshot"}]' },
      }),
    });

    await expect(hydration).resolves.toBe(true);
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe(authoritative);
    expect(getCount).toBe(2);
  });

  it('deduplicates concurrent desktop hydration requests', async () => {
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ settings: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { hydrateAppSettings } = await load();

    await Promise.all([hydrateAppSettings(), hydrateAppSettings()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('onAppSettingsHydrated fires immediately if already hydrated', async () => {
    isTauri.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ settings: {} }) }),
    );
    const { hydrateAppSettings, onAppSettingsHydrated } = await load();
    await hydrateAppSettings();
    const cb = vi.fn();
    onAppSettingsHydrated(cb);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('setStoredSettingDurable awaits the authoritative write on desktop', async () => {
    isTauri.mockReturnValue(true);
    let finish!: (value: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>(resolve => {
      finish = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(() => pending);
    vi.stubGlobal('fetch', fetchMock);
    const { getStoredSetting, setStoredSettingDurable } = await load();

    const resultPromise = setStoredSettingDurable('inkmarshal_settings', '{"theme":"dark"}');
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"dark"}');
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finish({ ok: true });
    await expect(resultPromise).resolves.toBe(true);
    expect(settled).toBe(true);
  });

  it('rollback restores the previous mirror only when cache still equals the attempted set', async () => {
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    const {
      getStoredSetting,
      rollbackStoredSettingMirrorAfterFailedDurableAttempt,
      setStoredSetting,
      setStoredSettingDurable,
    } = await load();

    setStoredSetting('inkmarshal_connections_v1', '[{"id":"prior"}]');
    await Promise.resolve();
    fetchMock.mockClear();

    await expect(setStoredSettingDurable('inkmarshal_connections_v1', '[{"id":"attempted"}]')).resolves.toBe(
      false,
    );
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[{"id":"attempted"}]');

    rollbackStoredSettingMirrorAfterFailedDurableAttempt(
      'inkmarshal_connections_v1',
      '[{"id":"attempted"}]',
      '[{"id":"prior"}]',
    );
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[{"id":"prior"}]');
    expect(localStorage.getItem('inkmarshal_connections_v1')).toBe('[{"id":"prior"}]');
    expect(patchCalls(fetchMock)).toEqual([
      { key: 'inkmarshal_connections_v1', value: '[{"id":"attempted"}]' },
    ]);
  });

  it('rollback does not clobber a newer queued cache write after a failed durable attempt', async () => {
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const {
      getStoredSetting,
      rollbackStoredSettingMirrorAfterFailedDurableAttempt,
      setStoredSetting,
      setStoredSettingDurable,
    } = await load();

    setStoredSetting('inkmarshal_connections_v1', '[{"id":"prior"}]');
    await vi.waitFor(() => expect(patchCalls(fetchMock)).toHaveLength(1));

    let finishDurable!: (value: { ok: boolean }) => void;
    const durablePending = new Promise<{ ok: boolean }>(resolve => {
      finishDurable = resolve;
    });
    fetchMock.mockImplementationOnce(() => durablePending).mockResolvedValue({ ok: true });

    const failedDurable = setStoredSettingDurable(
      'inkmarshal_connections_v1',
      '[{"id":"attempted"}]',
    );
    setStoredSetting('inkmarshal_connections_v1', '[{"id":"newer"}]');
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[{"id":"newer"}]');

    finishDurable({ ok: false });
    await expect(failedDurable).resolves.toBe(false);

    const patchesBeforeRollback = patchCalls(fetchMock).length;
    rollbackStoredSettingMirrorAfterFailedDurableAttempt(
      'inkmarshal_connections_v1',
      '[{"id":"attempted"}]',
      '[{"id":"prior"}]',
    );
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[{"id":"newer"}]');
    expect(localStorage.getItem('inkmarshal_connections_v1')).toBe('[{"id":"newer"}]');
    expect(patchCalls(fetchMock)).toHaveLength(patchesBeforeRollback);
  });

  it('rollback restores a previous value after a failed durable remove only when still absent', async () => {
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    const {
      getStoredSetting,
      removeStoredSettingDurable,
      rollbackStoredSettingMirrorAfterFailedDurableAttempt,
      setStoredSetting,
    } = await load();

    setStoredSetting('inkmarshal_connections_v1', '[{"id":"prior"}]');
    await Promise.resolve();
    fetchMock.mockClear();

    await expect(removeStoredSettingDurable('inkmarshal_connections_v1')).resolves.toBe(false);
    expect(getStoredSetting('inkmarshal_connections_v1')).toBeNull();

    rollbackStoredSettingMirrorAfterFailedDurableAttempt(
      'inkmarshal_connections_v1',
      null,
      '[{"id":"prior"}]',
    );
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[{"id":"prior"}]');
    expect(patchCalls(fetchMock)).toEqual([
      { key: 'inkmarshal_connections_v1', value: null },
    ]);

    await expect(removeStoredSettingDurable('inkmarshal_connections_v1')).resolves.toBe(false);
    setStoredSetting('inkmarshal_connections_v1', '[{"id":"newer"}]');
    rollbackStoredSettingMirrorAfterFailedDurableAttempt(
      'inkmarshal_connections_v1',
      null,
      '[{"id":"prior"}]',
    );
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[{"id":"newer"}]');
  });

  it('web durable writes resolve success via localStorage without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { setStoredSettingDurable, getStoredSetting } = await load();

    await expect(setStoredSettingDurable('inkmarshal_connections_v1', '[]')).resolves.toBe(true);
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[]');
    expect(localStorage.getItem('inkmarshal_connections_v1')).toBe('[]');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
