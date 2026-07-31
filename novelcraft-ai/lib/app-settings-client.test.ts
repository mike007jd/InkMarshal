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

  it('hydrate treats SQLite as authoritative and clears missing allowed keys', async () => {
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
    localStorage.setItem('inkmarshal_engine_launch_plans_v1', '{"stale":"plan"}');
    localStorage.setItem('inkmarshal_capability_profile_v1', '{"stale":"binding"}');
    localStorage.setItem('inkmarshal_workspace_views_v1', '{"stale":"story-deck"}');
    localStorage.setItem('inkmarshal_manuscript_recovery_v1', '{"stale":"draft"}');

    const { hydrateAppSettings, getStoredSetting, isAppSettingsHydrated } = await load();
    await expect(hydrateAppSettings()).resolves.toEqual({ ok: true });

    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[]'); // from SQLite
    // Authoritative absence clears stale mirrors for missing allowed keys.
    expect(getStoredSetting('inkmarshal_settings')).toBeNull();
    expect(getStoredSetting('inkmarshal_engine_launch_plans_v1')).toBeNull();
    expect(getStoredSetting('inkmarshal_capability_profile_v1')).toBeNull();
    expect(getStoredSetting('inkmarshal_workspace_views_v1')).toBeNull();
    expect(getStoredSetting('inkmarshal_manuscript_recovery_v1')).toBeNull();
    expect(isAppSettingsHydrated()).toBe(true);
    expect(patchCalls(fetchMock)).toHaveLength(0);
  });

  it('lets post-GET-start mutations win over an older hydration response', async () => {
    isTauri.mockReturnValue(true);
    let resolveFirstGet!: (value: {
      ok: boolean;
      json: () => Promise<{ settings: Record<string, string> }>;
    }) => void;
    let getCount = 0;
    const persisted = new Map<string, string>([
      ['inkmarshal_settings', '{"theme":"dark"}'],
      ['inkmarshal_engine_launch_plans_v1', '{"stale":true}'],
    ]);
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (!opts || opts.method === 'GET') {
        getCount += 1;
        if (getCount === 1) {
          return new Promise(resolve => {
            resolveFirstGet = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ settings: Object.fromEntries(persisted) }),
        });
      }
      const body = JSON.parse(opts.body as string) as { key: string; value: string | null };
      if (body.value === null) persisted.delete(body.key);
      else persisted.set(body.key, body.value);
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const {
      hydrateAppSettings,
      getStoredSetting,
      setStoredSetting,
      removeStoredSetting,
    } = await load();

    const pending = hydrateAppSettings();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    setStoredSetting('inkmarshal_settings', '{"theme":"light"}');
    removeStoredSetting('inkmarshal_engine_launch_plans_v1');
    setStoredSetting('inkmarshal_capability_profile_v1', '{"role":"new"}');

    resolveFirstGet({
      ok: true,
      json: async () => ({
        settings: {
          inkmarshal_settings: '{"theme":"dark"}',
          inkmarshal_engine_launch_plans_v1: '{"stale":true}',
          // capability absent in GET — must not clear the newer set
        },
      }),
    });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"light"}');
    expect(getStoredSetting('inkmarshal_engine_launch_plans_v1')).toBeNull();
    expect(getStoredSetting('inkmarshal_capability_profile_v1')).toBe('{"role":"new"}');
    expect(getCount).toBe(2);
  });

  it('waits for a pre-hydration PATCH before taking the authoritative GET snapshot', async () => {
    isTauri.mockReturnValue(true);
    let persisted = '{"theme":"old"}';
    let finishPatch!: () => void;
    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        order.push('PATCH');
        const body = JSON.parse(opts.body as string) as { value: string };
        return new Promise(resolve => {
          finishPatch = () => {
            persisted = body.value;
            order.push('PATCH resolved');
            resolve({ ok: true, json: async () => ({}) });
          };
        });
      }
      order.push('GET');
      return Promise.resolve({
        ok: true,
        json: async () => ({ settings: { inkmarshal_settings: persisted } }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getStoredSetting, hydrateAppSettings, setStoredSetting } = await load();

    setStoredSetting('inkmarshal_settings', '{"theme":"new"}');
    const hydration = hydrateAppSettings();
    await Promise.resolve();
    expect(order).toEqual(['PATCH']);

    finishPatch();
    await expect(hydration).resolves.toEqual({ ok: true });
    expect(order).toEqual(['PATCH', 'PATCH resolved', 'GET']);
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"new"}');
  });

  it('drains a PATCH enqueued synchronously after hydration starts before GET', async () => {
    isTauri.mockReturnValue(true);
    let persisted = '{"theme":"old"}';
    let finishPatch!: () => void;
    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        order.push('PATCH');
        const body = JSON.parse(opts.body as string) as { value: string };
        return new Promise(resolve => {
          finishPatch = () => {
            persisted = body.value;
            order.push('PATCH resolved');
            resolve({ ok: true, json: async () => ({}) });
          };
        });
      }
      order.push('GET');
      return Promise.resolve({
        ok: true,
        json: async () => ({ settings: { inkmarshal_settings: persisted } }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getStoredSetting, hydrateAppSettings, setStoredSetting } = await load();

    const hydration = hydrateAppSettings();
    setStoredSetting('inkmarshal_settings', '{"theme":"new"}');
    await Promise.resolve();
    expect(order).toEqual(['PATCH']);

    finishPatch();
    await expect(hydration).resolves.toEqual({ ok: true });
    expect(order).toEqual(['PATCH', 'PATCH resolved', 'GET']);
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"new"}');
  });

  it('preserves a mutation queued in the hydration microtask boundary', async () => {
    isTauri.mockReturnValue(true);
    let resolveFirstGet!: (value: {
      ok: boolean;
      json: () => Promise<{ settings: Record<string, string> }>;
    }) => void;
    let getCount = 0;
    let persisted = '{"theme":"old"}';
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        const body = JSON.parse(opts.body as string) as { value: string };
        persisted = body.value;
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      getCount += 1;
      if (getCount > 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ settings: { inkmarshal_settings: persisted } }),
        });
      }
      return new Promise(resolve => {
        resolveFirstGet = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getStoredSetting, hydrateAppSettings, setStoredSetting } = await load();

    const hydration = hydrateAppSettings();
    queueMicrotask(() => {
      setStoredSetting('inkmarshal_settings', '{"theme":"queued"}');
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveFirstGet({
      ok: true,
      json: async () => ({
        settings: { inkmarshal_settings: '{"theme":"old"}' },
      }),
    });

    await expect(hydration).resolves.toEqual({ ok: true });
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"queued"}');
    expect(getCount).toBe(2);
  });

  it('retains the first-paint mirror after a failed GET until a later successful retry', async () => {
    vi.useFakeTimers();
    isTauri.mockReturnValue(true);
    localStorage.setItem('inkmarshal_engine_launch_plans_v1', '{"mirror":true}');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ settings: {} }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { hydrateAppSettings, getStoredSetting, isAppSettingsHydrated } = await load();

    const pending = hydrateAppSettings();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'app-settings GET returned HTTP 503',
    });
    expect(isAppSettingsHydrated()).toBe(false);
    expect(getStoredSetting('inkmarshal_engine_launch_plans_v1')).toBe('{"mirror":true}');

    const retry = hydrateAppSettings();
    await vi.runAllTimersAsync();
    await expect(retry).resolves.toEqual({ ok: true });
    expect(getStoredSetting('inkmarshal_engine_launch_plans_v1')).toBeNull();
    vi.useRealTimers();
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
    let getCount = 0;
    let persisted = '[{"id":"old"}]';
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'GET') {
        getCount += 1;
        if (getCount === 1) return pendingGet;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            settings: { inkmarshal_connections_v1: persisted },
          }),
        });
      }
      const body = JSON.parse(opts?.body as string) as { value: string };
      persisted = body.value;
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

    await expect(hydration).resolves.toEqual({ ok: true });
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[{"id":"new"}]');
    expect(localStorage.getItem('inkmarshal_connections_v1')).toBe('[{"id":"new"}]');
    expect(getCount).toBe(2);
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

    await expect(hydration).resolves.toEqual({ ok: true });
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe(authoritative);
    expect(getCount).toBe(2);
  });

  it('refetches when GET resolves before an overlapping durable PATCH fails', async () => {
    isTauri.mockReturnValue(true);
    let finishFirstGet!: () => void;
    let finishPatch!: () => void;
    let getCount = 0;
    const authoritative = '[{"id":"authoritative"}]';
    const fetchMock = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') {
        return new Promise(resolve => {
          finishPatch = () => resolve({ ok: false });
        });
      }
      getCount += 1;
      if (getCount === 1) {
        return new Promise(resolve => {
          finishFirstGet = () => resolve({
            ok: true,
            json: async () => ({
              settings: { inkmarshal_connections_v1: '[{"id":"old-snapshot"}]' },
            }),
          });
        });
      }
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
    await vi.waitFor(() => expect(getCount).toBe(1));
    const attempted = '[{"id":"attempted"}]';
    const durableWrite = setStoredSettingDurable('inkmarshal_connections_v1', attempted);
    finishFirstGet();
    await Promise.resolve();
    finishPatch();
    await expect(durableWrite).resolves.toBe(false);
    rollbackStoredSettingMirrorAfterFailedDurableAttempt(
      'inkmarshal_connections_v1',
      attempted,
      '[{"id":"stale-mirror"}]',
    );

    await expect(hydration).resolves.toEqual({ ok: true });
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe(authoritative);
    expect(getCount).toBeGreaterThanOrEqual(2);
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

  it('retries a transient GET failure then succeeds without treating failure as empty hydration', async () => {
    vi.useFakeTimers();
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ settings: { inkmarshal_connections_v1: '[]' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { hydrateAppSettings, getStoredSetting, isAppSettingsHydrated, onAppSettingsHydrated } = await load();
    const cb = vi.fn();
    onAppSettingsHydrated(cb);

    const pending = hydrateAppSettings();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getStoredSetting('inkmarshal_connections_v1')).toBe('[]');
    expect(isAppSettingsHydrated()).toBe(true);
    expect(cb).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('fails closed on persistent non-2xx and does not mark hydrated or notify listeners', async () => {
    vi.useFakeTimers();
    isTauri.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { hydrateAppSettings, isAppSettingsHydrated, onAppSettingsHydrated } = await load();
    const cb = vi.fn();
    onAppSettingsHydrated(cb);

    const pending = hydrateAppSettings();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'app-settings GET returned HTTP 503',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(isAppSettingsHydrated()).toBe(false);
    expect(cb).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fails closed on a malformed 200 payload without clearing first-paint mirrors', async () => {
    vi.useFakeTimers();
    isTauri.mockReturnValue(true);
    localStorage.setItem('inkmarshal_settings', '{"theme":"mirror"}');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ settings: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getStoredSetting, hydrateAppSettings, isAppSettingsHydrated } = await load();

    const pending = hydrateAppSettings();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'app-settings GET returned an invalid payload',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(isAppSettingsHydrated()).toBe(false);
    expect(getStoredSetting('inkmarshal_settings')).toBe('{"theme":"mirror"}');
    vi.useRealTimers();
  });

  it('deduplicates concurrent hydrate callers onto one in-flight GET chain', async () => {
    vi.useFakeTimers();
    isTauri.mockReturnValue(true);
    let resolveFetch!: (value: { ok: boolean; json: () => Promise<{ settings: Record<string, string> }> }) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise(resolve => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { hydrateAppSettings } = await load();

    const first = hydrateAppSettings();
    const second = hydrateAppSettings();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch({
      ok: true,
      json: async () => ({ settings: { inkmarshal_settings: '{"theme":"dark"}' } }),
    });
    await vi.runAllTimersAsync();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('DesktopShell hydrate sequencing contract', () => {
  it('awaits hydrate result before restoreEnginesOnLaunch and binds focus/online retry only after failure', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'components/DesktopShellLayout.tsx'), 'utf8');
    expect(source).toContain('const result = await hydrateAppSettings()');
    expect(source).toContain('if (!mounted) return;');
    expect(source).toContain('if (!result.ok)');
    expect(source).toContain('setSettingsLoadFailed(true)');
    expect(source).toContain('await restoreEnginesOnLaunch()');
    expect(source).toContain("window.addEventListener('focus', retry)");
    expect(source).toContain("window.addEventListener('online', retry)");
    expect(source.indexOf('if (!result.ok)')).toBeLessThan(
      source.indexOf('await restoreEnginesOnLaunch()'),
    );
  });
});
