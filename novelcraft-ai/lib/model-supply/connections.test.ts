import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The repo's vitest environment is `node` (vitest.config.ts) and no existing
// client test mocks browser globals — so this file installs a minimal
// in-memory localStorage + window shim itself, and a desktop-keychain mock,
// then restores everything in afterEach so the other 39 tests stay green.

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
  /** test helper: every key currently held (to assert no secret leaked). */
  __entries(): [string, string][] {
    return Array.from(this.map.entries());
  }
}

// In-memory desktop keychain so we can assert secrets go HERE, not localStorage.
const keychain = new Map<string, string>();
const mockIsTauriRuntime = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: mockIsTauriRuntime, // simulate desktop unless a test overrides it
  keychainSet: vi.fn(async (account: string, secret: string) => {
    keychain.set(account, secret);
  }),
  keychainGet: vi.fn(async (account: string) =>
    keychain.has(account) ? keychain.get(account)! : null,
  ),
  keychainDelete: vi.fn(async (account: string) => {
    keychain.delete(account);
  }),
  engineStatus: vi.fn(async () => []),
}));

let savedWindow: PropertyDescriptor | undefined;
let savedLocalStorage: PropertyDescriptor | undefined;
let memory: MemoryStorage;

beforeEach(() => {
  vi.resetModules();
  keychain.clear();
  mockIsTauriRuntime.mockReturnValue(true);
  memory = new MemoryStorage();
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: memory, location: { hostname: 'localhost' } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: memory,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else delete (globalThis as Record<string, unknown>).window;
  if (savedLocalStorage)
    Object.defineProperty(globalThis, 'localStorage', savedLocalStorage);
  else delete (globalThis as Record<string, unknown>).localStorage;
  vi.restoreAllMocks();
});

async function loadModule() {
  return import('./connections');
}

describe('connections CRUD', () => {
  it('upsertConnection assigns a uuid + timestamps and getConnections returns it', async () => {
    const mod = await loadModule();
    const created = mod.upsertConnection({
      label: 'My OpenAI',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();

    const all = mod.getConnections();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(created.id);
    expect(all[0].label).toBe('My OpenAI');
    expect(all[0].baseUrl).toBe('https://api.openai.com/v1');
    expect(all[0].secretRef).toBeNull();
  });

  it('upsertConnection with an existing id updates in place (same id, new updatedAt)', async () => {
    const mod = await loadModule();
    const created = mod.upsertConnection({
      label: 'Local Ollama',
      kind: 'local',
      transport: 'ollama-native',
      baseUrl: 'http://127.0.0.1:11434',
    });
    const updated = mod.upsertConnection({
      ...created,
      label: 'Local Ollama (renamed)',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(mod.getConnections()).toHaveLength(1);
    expect(mod.getConnection(created.id)?.label).toBe('Local Ollama (renamed)');
  });

  it('removeConnection deletes the connection and its secret', async () => {
    const mod = await loadModule();
    const dr = await import('@/lib/desktop-runtime');
    const conn = mod.upsertConnection({
      label: 'DeepSeek',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    await mod.setConnectionSecret(conn.id, 'sk-secret-value');
    expect(keychain.get(`connection:${conn.id}`)).toBe('sk-secret-value');

    await mod.removeConnection(conn.id);
    expect(mod.getConnections()).toHaveLength(0);
    expect(mod.getConnection(conn.id)).toBeUndefined();
    expect(
      (dr.keychainDelete as unknown as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith(`connection:${conn.id}`);
    expect(keychain.has(`connection:${conn.id}`)).toBe(false);
  });

  it('keeps the connection visible when secret deletion fails so removal can be retried', async () => {
    const mod = await loadModule();
    const dr = await import('@/lib/desktop-runtime');
    const conn = mod.upsertConnection({
      label: 'Retryable provider',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.retryable.test/v1',
    });
    await mod.setConnectionSecret(conn.id, 'sk-retry-delete');

    (dr.keychainDelete as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('keychain locked'),
    );
    await expect(mod.removeConnection(conn.id)).rejects.toThrow('keychain locked');
    expect(mod.getConnection(conn.id)).toBeDefined();
    expect(keychain.get(`connection:${conn.id}`)).toBe('sk-retry-delete');

    await mod.removeConnection(conn.id);
    expect(mod.getConnection(conn.id)).toBeUndefined();
    expect(keychain.has(`connection:${conn.id}`)).toBe(false);
  });

  it('secretRef tracks configured key presence instead of claiming an empty slot is set', async () => {
    const mod = await loadModule();
    const conn = mod.upsertConnection({
      label: 'Anthropic',
      kind: 'provider',
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(mod.getConnection(conn.id)?.secretRef).toBeNull();

    await mod.setConnectionSecret(conn.id, 'sk-ant-test');
    expect(mod.getConnection(conn.id)?.secretRef).toEqual({
      account: `connection:${conn.id}`,
    });

    await mod.clearConnectionSecret(conn.id);
    expect(await mod.getConnectionSecret(conn.id)).toBeNull();
    expect(mod.getConnection(conn.id)?.secretRef).toBeNull();
  });

  it('does not write keychain secrets for missing connection rows', async () => {
    const mod = await loadModule();

    await expect(mod.setConnectionSecret('missing-provider', 'sk-orphan')).rejects.toThrow(
      'Runtime connection does not exist',
    );

    expect(keychain.has('connection:missing-provider')).toBe(false);
  });

  it('does not expose or delete orphaned secrets through missing connection ids', async () => {
    const mod = await loadModule();
    const dr = await import('@/lib/desktop-runtime');
    keychain.set('connection:missing-provider', 'sk-orphan');

    (dr.keychainGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    await expect(mod.getConnectionSecret('missing-provider')).resolves.toBeNull();
    expect(dr.keychainGet).not.toHaveBeenCalled();
    expect(keychain.get('connection:missing-provider')).toBe('sk-orphan');

    (dr.keychainDelete as unknown as ReturnType<typeof vi.fn>).mockClear();
    await mod.clearConnectionSecret('missing-provider');
    await mod.removeConnection('missing-provider');
    expect(dr.keychainDelete).not.toHaveBeenCalled();
    expect(keychain.get('connection:missing-provider')).toBe('sk-orphan');
  });

  it('requires secret cleanup before endpoint-defining fields change', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const dr = await import('@/lib/desktop-runtime');
    const conn = mod.upsertConnection({
      label: 'Provider',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.provider.test/v1',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'provider-model');
    await mod.setConnectionSecret(conn.id, 'sk-provider-should-not-move');

    const renamed = mod.upsertConnection({
      ...mod.getConnection(conn.id)!,
      label: 'Provider renamed',
    });
    expect(renamed.secretRef).toEqual({ account: `connection:${conn.id}` });

    expect(() =>
      mod.upsertConnection({
        ...mod.getConnection(conn.id)!,
        baseUrl: 'https://api.other-provider.test/v1',
      }),
    ).toThrow(/clearing the existing secret/);
    expect(mod.getConnection(conn.id)?.baseUrl).toBe('https://api.provider.test/v1');
    expect(keychain.get(`connection:${conn.id}`)).toBe('sk-provider-should-not-move');

    (dr.keychainDelete as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('keychain locked'),
    );
    await expect(
      mod.upsertConnectionWithSecretCleanup({
        ...mod.getConnection(conn.id)!,
        baseUrl: 'https://api.other-provider.test/v1',
      }),
    ).rejects.toThrow('keychain locked');
    expect(mod.getConnection(conn.id)?.baseUrl).toBe('https://api.provider.test/v1');
    expect(keychain.get(`connection:${conn.id}`)).toBe('sk-provider-should-not-move');

    const moved = await mod.upsertConnectionWithSecretCleanup({
      ...mod.getConnection(conn.id)!,
      baseUrl: 'https://api.other-provider.test/v1',
    });
    expect(moved.secretRef).toBeNull();
    expect(keychain.has(`connection:${conn.id}`)).toBe(false);

    (dr.keychainGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    const resolved = await headers.buildRoleAwareHeaders('chapter');
    expect(resolved['x-im-base-url']).toBe('https://api.other-provider.test/v1');
    expect(resolved['x-im-secret']).toBeUndefined();
    expect(dr.keychainGet).not.toHaveBeenCalled();
  });

  it('normalizes clean base URLs and rejects credential-bearing connection URLs before storage', async () => {
    const mod = await loadModule();
    const created = mod.upsertConnection({
      label: 'Local runtime',
      kind: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1/',
    });
    expect(created.baseUrl).toBe('http://127.0.0.1:8000/v1');

    expect(() =>
      mod.upsertConnection({
        label: 'Bad runtime',
        kind: 'custom',
        transport: 'openai-compatible',
        baseUrl: 'http://user:pass@127.0.0.1:8000/v1',
      }),
    ).toThrow(/base URL/);
    expect(() =>
      mod.upsertConnection({
        label: 'Bad runtime',
        kind: 'custom',
        transport: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8000/v1?token=secret',
      }),
    ).toThrow(/base URL/);
  });

  it('requires HTTPS for provider endpoints and keeps API keys off non-loopback HTTP', async () => {
    const mod = await loadModule();

    expect(() =>
      mod.upsertConnection({
        label: 'Plain provider',
        kind: 'provider',
        transport: 'openai-compatible',
        baseUrl: 'http://api.provider.test/v1',
      }),
    ).toThrow(/base URL/);

    const remoteCustom = mod.upsertConnection({
      label: 'Remote custom',
      kind: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'http://192.0.2.10:8000/v1',
    });
    await expect(mod.setConnectionSecret(remoteCustom.id, 'sk-no-plaintext')).rejects.toThrow(
      'Runtime connection API keys require HTTPS or a loopback HTTP runtime',
    );
    expect(keychain.has(`connection:${remoteCustom.id}`)).toBe(false);

    const localCustom = mod.upsertConnection({
      label: 'Loopback custom',
      kind: 'custom',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
    });
    await mod.setConnectionSecret(localCustom.id, 'sk-local-runtime');
    expect(keychain.get(`connection:${localCustom.id}`)).toBe('sk-local-runtime');
  });

  it('drops persisted secret refs for non-loopback HTTP custom endpoints', async () => {
    memory.setItem(
      'inkmarshal_connections_v1',
      JSON.stringify([
        {
          id: 'remote-custom',
          label: 'Remote custom',
          kind: 'custom',
          transport: 'openai-compatible',
          baseUrl: 'http://192.0.2.20:8000/v1',
          secretRef: { account: 'connection:remote-custom' },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );

    const mod = await loadModule();
    expect(mod.getConnections()).toEqual([
      expect.objectContaining({
        id: 'remote-custom',
        baseUrl: 'http://192.0.2.20:8000/v1',
        secretRef: null,
      }),
    ]);
    expect(memory.getItem('inkmarshal_connections_v1')).not.toContain('connection:remote-custom');
  });

  it('cleans unsafe persisted connection rows before exposing them to headers or UI', async () => {
    memory.setItem(
      'inkmarshal_connections_v1',
      JSON.stringify([
        {
          id: 'safe',
          label: 'Safe runtime',
          kind: 'custom',
          transport: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8000/v1/',
          secretRef: { account: 'connection:safe', apiKey: 'sk-nested-must-drop' },
          apiKey: 'sk-plaintext-must-drop',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'bad',
          label: 'Bad runtime',
          kind: 'custom',
          transport: 'openai-compatible',
          baseUrl: 'http://user:pass@127.0.0.1:8001/v1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'bad\nid',
          label: 'Bad id runtime',
          kind: 'custom',
          transport: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8002/v1',
          secretRef: { account: 'connection:bad\nid' },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );

    const mod = await loadModule();
    const all = mod.getConnections();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('safe');
    expect(all[0].baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(all[0].secretRef).toEqual({ account: 'connection:safe' });
    expect(JSON.stringify(all)).not.toContain('sk-plaintext-must-drop');
    expect(JSON.stringify(all)).not.toContain('sk-nested-must-drop');
    expect(JSON.stringify(all)).not.toContain('user:pass');
    expect(JSON.stringify(all)).not.toContain('bad\\nid');

    const rewritten = memory.getItem('inkmarshal_connections_v1')!;
    expect(rewritten).not.toContain('sk-plaintext-must-drop');
    expect(rewritten).not.toContain('sk-nested-must-drop');
    expect(rewritten).not.toContain('user:pass');
    expect(rewritten).not.toContain('bad\\nid');
  });

  it('drops oversized persisted connection state and mismatched secret refs before UI exposure', async () => {
    memory.setItem(
      'inkmarshal_connections_v1',
      JSON.stringify([
        {
          id: 'safe',
          label: 'Safe runtime',
          kind: 'custom',
          transport: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8000/v1',
          secretRef: { account: 'connection:other' },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'oversized-label',
          label: 'x'.repeat(201),
          kind: 'custom',
          transport: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:8001/v1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'oversized-url',
          label: 'Oversized URL',
          kind: 'custom',
          transport: 'openai-compatible',
          baseUrl: `http://127.0.0.1:8002/${'v'.repeat(2_048)}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );

    const mod = await loadModule();
    expect(mod.getConnections()).toEqual([
      expect.objectContaining({
        id: 'safe',
        label: 'Safe runtime',
        baseUrl: 'http://127.0.0.1:8000/v1',
        secretRef: null,
      }),
    ]);

    const rewritten = memory.getItem('inkmarshal_connections_v1')!;
    expect(rewritten).not.toContain('oversized-label');
    expect(rewritten).not.toContain('oversized-url');
    expect(rewritten).not.toContain('connection:other');
  });

  it('rejects oversized connection input before storage', async () => {
    const mod = await loadModule();
    expect(() =>
      mod.upsertConnection({
        id: 'x'.repeat(2_049),
        label: 'Valid label',
        kind: 'custom',
        transport: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8000/v1',
      }),
    ).toThrow(/id is invalid/);

    expect(() =>
      mod.upsertConnection({
        id: 'bad\nid',
        label: 'Valid label',
        kind: 'custom',
        transport: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8000/v1',
      }),
    ).toThrow(/id is invalid/);

    expect(() =>
      mod.upsertConnection({
        label: 'x'.repeat(201),
        kind: 'custom',
        transport: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8000/v1',
      }),
    ).toThrow(/label is invalid/);

    expect(() =>
      mod.upsertConnection({
        label: 'Valid label',
        kind: 'custom',
        transport: 'openai-compatible',
        baseUrl: `http://127.0.0.1:8000/${'v'.repeat(2_048)}`,
      }),
    ).toThrow(/base URL/);
  });
});

describe('capability profile', () => {
  it('saveCapabilityBinding then getCapabilityProfile returns the binding; unbound roles are null', async () => {
    const mod = await loadModule();
    const conn = mod.upsertConnection({
      label: 'Local Ollama',
      kind: 'local',
      transport: 'ollama-native',
      baseUrl: 'http://127.0.0.1:11434',
    });

    mod.saveCapabilityBinding('draft', conn.id, 'qwen3.5:4b');

    const profile = mod.getCapabilityProfile();
    expect(profile.draft).toEqual({ connectionId: conn.id, modelId: 'qwen3.5:4b' });
    expect(profile.rewrite).toBeNull();
    expect(profile.planning).toBeNull();
    expect(profile.recall).toBeNull();

    expect(mod.getBindingForRole('draft')).toEqual({
      connectionId: conn.id,
      modelId: 'qwen3.5:4b',
    });
    expect(mod.getBindingForRole('rewrite')).toBeNull();
  });

  it('saveCapabilityBinding persists a fallback when provided', async () => {
    const mod = await loadModule();
    const primary = mod.upsertConnection({
      label: 'Primary',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.primary.test/v1',
    });
    const fallback = mod.upsertConnection({
      label: 'Fallback',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.fallback.test/v1',
    });
    mod.saveCapabilityBinding('rewrite', primary.id, 'm1', {
      connectionId: fallback.id,
      modelId: 'm2',
    });
    expect(mod.getBindingForRole('rewrite')).toEqual({
      connectionId: primary.id,
      modelId: 'm1',
      fallback: { connectionId: fallback.id, modelId: 'm2' },
    });
  });

  it('cleans bindings that point at missing connections before headers or UI state read them', async () => {
    const mod = await loadModule();
    const primary = mod.upsertConnection({
      label: 'Primary',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.primary.test/v1',
    });
    const fallback = mod.upsertConnection({
      label: 'Fallback',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.fallback.test/v1',
    });
    mod.saveCapabilityBinding('draft', primary.id, 'draft-model', {
      connectionId: fallback.id,
      modelId: 'fallback-model',
    });

    await mod.removeConnection(fallback.id);
    expect(mod.getBindingForRole('draft')).toEqual({
      connectionId: primary.id,
      modelId: 'draft-model',
    });

    await mod.removeConnection(primary.id);
    expect(mod.getBindingForRole('draft')).toBeNull();
    const rewritten = memory.getItem('inkmarshal_capability_profile_v1')!;
    expect(rewritten).not.toContain(primary.id);
    expect(rewritten).not.toContain(fallback.id);
  });

  it('drops oversized model bindings before headers or UI state read them', async () => {
    const mod = await loadModule();
    const primary = mod.upsertConnection({
      label: 'Primary',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.primary.test/v1',
    });
    const fallback = mod.upsertConnection({
      label: 'Fallback',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.fallback.test/v1',
    });

    mod.saveCapabilityBinding('draft', primary.id, 'x'.repeat(513));
    expect(mod.getBindingForRole('draft')).toBeNull();

    mod.saveCapabilityBinding('rewrite', primary.id, 'main-model', {
      connectionId: fallback.id,
      modelId: 'x'.repeat(513),
    });
    expect(mod.getBindingForRole('rewrite')).toEqual({
      connectionId: primary.id,
      modelId: 'main-model',
    });
  });

  it('buildRoleAwareHeadersForOperations emits role-scoped headers for multi-phase requests', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const conn = mod.upsertConnection({
      label: 'Bundled engine',
      kind: 'local',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'draft-model');
    mod.saveCapabilityBinding('planning', conn.id, 'planning-model');
    mod.saveCapabilityBinding('recall', conn.id, 'recall-model');
    mod.saveCapabilityBinding('rewrite', conn.id, 'rewrite-model');
    await mod.setConnectionSecret(conn.id, 'sk-local-test');

    const resolved = await headers.buildRoleAwareHeadersForOperations([
      'outline',
      'chapter',
      'summarize',
      'validate',
      'polish',
    ]);

    expect(resolved['x-im-role']).toBeUndefined();
    expect(resolved['x-im-draft-model']).toBe('draft-model');
    expect(resolved['x-im-planning-model']).toBe('planning-model');
    expect(resolved['x-im-recall-model']).toBe('recall-model');
    expect(resolved['x-im-rewrite-model']).toBe('rewrite-model');
    expect(resolved['x-im-draft-base-url']).toBe('http://127.0.0.1:8000/v1');
    expect(resolved['x-im-planning-secret']).toBe('sk-local-test');
    expect(resolved['x-im-rewrite-secret']).toBe('sk-local-test');
  });

  it('buildRoleAwareHeadersForOperations rejects a broken configured role instead of omitting it', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const conn = mod.upsertConnection({
      id: 'local-engine:gguf:/m/dead.gguf',
      label: 'Local engine · dead.gguf',
      kind: 'local',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:59999/v1',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'dead.gguf');

    await expect(headers.buildRoleAwareHeadersForOperations([
      'chapter',
      'outline',
    ])).rejects.toThrow(
      'Local model runtime "Local engine · dead.gguf" is not running',
    );
  });

  it('buildRoleAwareHeaders blocks silent provider fallback when a configured key cannot be read', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const dr = await import('@/lib/desktop-runtime');
    const conn = mod.upsertConnection({
      label: 'Anthropic',
      kind: 'provider',
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'claude-sonnet-4-6');
    await mod.setConnectionSecret(conn.id, 'sk-ant-test');
    (dr.keychainGet as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('keyring locked');
      },
    );

    await expect(headers.buildRoleAwareHeaders('chapter')).rejects.toThrow(
      'Unable to read the API key for "Anthropic". keyring locked',
    );
  });

  it('buildRoleAwareHeaders blocks silent provider fallback when a configured key is missing', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const conn = mod.upsertConnection({
      label: 'Anthropic',
      kind: 'provider',
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'claude-sonnet-4-6');
    await mod.setConnectionSecret(conn.id, 'sk-ant-test');
    keychain.delete(`connection:${conn.id}`);

    await expect(headers.buildRoleAwareHeaders('chapter')).rejects.toThrow(
      'The API key for "Anthropic" is missing. Re-enter it in Settings.',
    );
  });

  it('buildRoleAwareHeaders does not touch keychain for no-secret local runtime bindings', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const dr = await import('@/lib/desktop-runtime');
    const conn = mod.upsertConnection({
      label: 'Local runtime',
      kind: 'local',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8000/v1',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'local-model');
    (dr.keychainGet as unknown as ReturnType<typeof vi.fn>).mockClear();

    await expect(headers.buildRoleAwareHeaders('chapter')).resolves.toMatchObject({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-model': 'local-model',
    });
    expect(dr.keychainGet).not.toHaveBeenCalled();
  });

  it('buildRoleAwareHeaders rejects stale managed local-engine bindings instead of falling back', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const conn = mod.upsertConnection({
      id: 'local-engine:gguf:/m/dead.gguf',
      label: 'Local engine · dead.gguf',
      kind: 'local',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:59999/v1',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'dead.gguf');

    await expect(headers.buildRoleAwareHeaders('chapter')).rejects.toThrow(
      'Local model runtime "Local engine · dead.gguf" is not running',
    );
  });

  it('buildRoleAwareHeaders uses an explicit fallback when the primary runtime is unavailable', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const primary = mod.upsertConnection({
      id: 'local-engine:gguf:/m/dead.gguf',
      label: 'Local engine · dead.gguf',
      kind: 'local',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:59999/v1',
    });
    const fallback = mod.upsertConnection({
      label: 'Fallback provider',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.fallback.test/v1',
    });
    await mod.setConnectionSecret(fallback.id, 'sk-fallback');
    mod.saveCapabilityBinding('draft', primary.id, 'dead.gguf', {
      connectionId: fallback.id,
      modelId: 'fallback-model',
    });

    await expect(headers.buildRoleAwareHeaders('chapter')).resolves.toMatchObject({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'https://api.fallback.test/v1',
      'x-im-model': 'fallback-model',
      'x-im-secret': 'sk-fallback',
    });
  });

  it('buildRoleAwareHeaders omits runtime endpoints and secrets on non-local web origins', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const dr = await import('@/lib/desktop-runtime');
    (dr.isTauriRuntime as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: memory, location: { hostname: 'app.example.com' } },
      configurable: true,
      writable: true,
    });
    const conn = mod.upsertConnection({
      label: 'Anthropic',
      kind: 'provider',
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'claude-sonnet-4-6');
    // Secret storage is fail-closed off-desktop, so a web origin can't even
    // persist a key. The binding alone must still not leak the endpoint:
    // buildRoleAwareHeaders gates on a loopback/desktop origin (returning no
    // runtime headers) before it would ever resolve a connection or secret.

    const resolved = await headers.buildRoleAwareHeaders('chapter', {
      creativity: 'balanced',
    });

    expect(resolved).toEqual({ 'x-im-creativity': 'balanced' });
    expect(JSON.stringify(resolved)).not.toContain('api.anthropic.com');
  });

  it('buildRoleAwareHeaders emits managed local-engine headers only when the engine is still running', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const dr = await import('@/lib/desktop-runtime');
    const conn = mod.upsertConnection({
      id: 'local-engine:gguf:/m/live.gguf',
      label: 'Local engine · live.gguf',
      kind: 'local',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:51000/v1',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'live.gguf');
    (dr.engineStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        engineId: 'gguf:/m/live.gguf',
        format: 'gguf',
        modelPath: '/m/live.gguf',
        port: 51000,
        footprintBytes: 1,
      },
    ]);

    await expect(headers.buildRoleAwareHeaders('chapter')).resolves.toMatchObject({
      'x-im-role': 'draft',
      'x-im-base-url': 'http://127.0.0.1:51000/v1',
      'x-im-model': 'live.gguf',
    });
  });

  it('buildRoleAwareHeaders trusts native engine status over persisted local-engine endpoint fields', async () => {
    const mod = await loadModule();
    const headers = await import('./headers');
    const dr = await import('@/lib/desktop-runtime');
    const conn = mod.upsertConnection({
      id: 'local-engine:gguf:/m/live.gguf',
      label: 'Local engine · live.gguf',
      kind: 'local',
      transport: 'anthropic',
      baseUrl: 'https://wrong-provider.example/v1',
    });
    mod.saveCapabilityBinding('draft', conn.id, 'live.gguf');
    (dr.engineStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        engineId: 'gguf:/m/live.gguf',
        format: 'gguf',
        modelPath: '/m/live.gguf',
        port: 51042,
        footprintBytes: 1,
      },
    ]);

    await expect(headers.buildRoleAwareHeaders('chapter')).resolves.toMatchObject({
      'x-im-role': 'draft',
      'x-im-transport': 'openai-compatible',
      'x-im-base-url': 'http://127.0.0.1:51042/v1',
      'x-im-model': 'live.gguf',
    });
  });
});

describe('getSecret null-vs-reject contract (desktop)', () => {
  it('resolves null for an unbound connection without touching the keychain', async () => {
    const mod = await loadModule();
    const conn = mod.upsertConnection({
      label: 'Provider',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.provider.test/v1',
    });
    // secretRef:null (no key bound) → unbound; getConnectionSecret short-circuits.
    await expect(mod.getConnectionSecret(conn.id)).resolves.toBeNull();
  });

  it('REJECTS (does NOT collapse to null) when a bound key fails to read', async () => {
    const dr = await import('@/lib/desktop-runtime');
    const mod = await loadModule();
    const conn = mod.upsertConnection({
      label: 'Locked provider',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.locked.test/v1',
    });
    // Bind a secret so getConnectionSecret actually consults the keychain — an
    // unbound (secretRef:null) connection short-circuits to null by design.
    await mod.setConnectionSecret(conn.id, 'sk-locked');
    (dr.keychainGet as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new Error('keyring locked');
      },
    );
    await expect(mod.getConnectionSecret(conn.id)).rejects.toThrow('keyring locked');
  });
});

describe('secret isolation (desktop)', () => {
  it('rejects invalid secret accounts and oversized or control-character values before keychain access', async () => {
    const mod = await loadModule();
    const conn = mod.upsertConnection({
      label: 'Provider',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: 'https://api.provider.test/v1',
    });

    await expect(mod.setConnectionSecret('', 'sk-valid')).rejects.toThrow(/connection id/);
    await expect(mod.setConnectionSecret('bad\nid', 'sk-valid')).rejects.toThrow(/connection id/);
    await expect(mod.setConnectionSecret(conn.id, 'sk-valid')).resolves.toBeUndefined();
    await expect(mod.setConnectionSecret(conn.id, '')).rejects.toThrow(/Secret value/);
    await expect(mod.setConnectionSecret(conn.id, 'sk-line\nbreak')).rejects.toThrow(
      /Secret value/,
    );
    await expect(
      mod.setConnectionSecret(conn.id, 's'.repeat(16_385)),
    ).rejects.toThrow(/Secret value/);

    expect(keychain.get(`connection:${conn.id}`)).toBe('sk-valid');
    expect(keychain.has('connection:')).toBe(false);
    expect(keychain.has('connection:bad\nid')).toBe(false);
  });

  it('a connection secret NEVER lands in any localStorage key', async () => {
    const mod = await loadModule();
    const conn = mod.upsertConnection({
      label: 'Anthropic',
      kind: 'provider',
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    const SECRET = 'sk-ant-super-secret-DO-NOT-LEAK';
    await mod.setConnectionSecret(conn.id, SECRET);

    // keychain holds it under the namespaced account
    expect(keychain.get(`connection:${conn.id}`)).toBe(SECRET);

    // no localStorage value (any key) contains the secret substring
    const entries = memory.__entries();
    for (const [k, v] of entries) {
      expect(v).not.toContain(SECRET);
      expect(k).not.toContain(SECRET);
    }
    // and getConnections never re-exposes plaintext
    expect(JSON.stringify(mod.getConnections())).not.toContain(SECRET);

    // secretRef points at the namespaced account, not the value
    expect(mod.getConnection(conn.id)?.secretRef).toEqual({
      account: `connection:${conn.id}`,
    });
  });
});
