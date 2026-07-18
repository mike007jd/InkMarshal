import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  appDataDir: vi.fn(),
  homeDir: vi.fn(),
  join: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  Channel: class Channel<T> {
    onmessage?: (message: T) => void;
  },
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: mocks.appDataDir,
  homeDir: mocks.homeDir,
  join: mocks.join,
}));

import {
  DESKTOP_COMMANDS,
  engineStart,
  hfDownloadGguf,
  hfGetEndpoint,
  hfSetEndpoint,
  getDesktopStatus,
  isTauriRuntime,
  keychainSet,
  normalizeAllowedExternalUrl,
  runtimeHealth,
} from '@/lib/desktop-runtime';

function readText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function extractRustCommandNamesFromGenerateHandler(source: string): string[] {
  const block = source.match(/generate_handler!\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return [...block.matchAll(/(?:[A-Za-z0-9_]+::)*([A-Za-z0-9_]+)\s*,?/g)]
    .map(match => match[1])
    .filter(Boolean);
}

function extractRustCommandNamesFromBuildManifest(source: string): string[] {
  return [...source.matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1]);
}

function extractRustCommandNamesFromPermissionSet(source: string): string[] {
  return [...source.matchAll(/"allow-([a-z0-9-]+)"/g)]
    .map(match => match[1]?.replaceAll('-', '_'))
    .filter(Boolean);
}

describe('desktop runtime command contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps the JS command table aligned with Rust snake_case names', () => {
    expect(DESKTOP_COMMANDS).toMatchObject({
      desktopStatus: 'desktop_status',
      probeDefaultRuntimes: 'probe_default_runtimes',
      runtimeHealth: 'runtime_health',
      hfGetEndpoint: 'hf_get_endpoint',
      hfSetEndpoint: 'hf_set_endpoint',
      hfDownloadGguf: 'hf_download_gguf',
      hfDownloadRepoSnapshot: 'hf_download_repo_snapshot',
      listInstalledLocalModels: 'list_installed_local_models',
      engineStart: 'engine_start',
      engineStatus: 'engine_status',
    });
  });

  it('does not call Tauri commands from the web fallback runtime', async () => {
    vi.stubGlobal('window', {});

    expect(isTauriRuntime()).toBe(false);
    await expect(keychainSet('provider', 'secret')).rejects.toThrow('desktop-only');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('allowlists OS-open external links and rejects local or user-controlled targets', () => {
    expect(normalizeAllowedExternalUrl('https://github.com/mike007jd/InkMarshal/')).toBe(
      'https://github.com/mike007jd/InkMarshal',
    );
    expect(
      normalizeAllowedExternalUrl('https://github.com/mike007jd/InkMarshal/issues/new?template=bug'),
    ).toBe('https://github.com/mike007jd/InkMarshal/issues/new');

    expect(() => normalizeAllowedExternalUrl('http://github.com/mike007jd/InkMarshal')).toThrow(
      'HTTPS',
    );
    expect(() => normalizeAllowedExternalUrl('file:///Applications/Calculator.app')).toThrow(
      'HTTPS',
    );
    expect(() => normalizeAllowedExternalUrl('https://github.com/other/repo')).toThrow(
      'not allowed',
    );
  });

  it('keeps the native shell-open scope aligned with the external-link allowlist', () => {
    const config = JSON.parse(
      readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
    ) as { plugins?: { shell?: { open?: unknown } } };
    const openScope = config.plugins?.shell?.open;

    expect(typeof openScope).toBe('string');
    const scoped = new RegExp(`^${openScope}$`);

    expect(scoped.test('https://github.com/mike007jd/InkMarshal')).toBe(true);
    expect(scoped.test('https://github.com/mike007jd/InkMarshal/')).toBe(true);
    expect(scoped.test('https://github.com/mike007jd/InkMarshal/issues/new')).toBe(true);
    expect(scoped.test('https://github.com/mike007jd/InkMarshal/issues/new/')).toBe(true);
    expect(scoped.test('https://github.com/mike007jd/InkMarshal/issues/new?template=bug')).toBe(false);
    expect(scoped.test('http://github.com/mike007jd/InkMarshal')).toBe(false);
    expect(scoped.test('https://github.com/other/repo')).toBe(false);
    expect(scoped.test('mailto:support@example.com')).toBe(false);
    expect(scoped.test('file:///Applications/Calculator.app')).toBe(false);
  });

  it('allows the bundled desktop web runtime to use IPC capabilities', () => {
    const capability = JSON.parse(readText('../src-tauri/capabilities/default.json')) as {
      description?: string;
      remote?: { urls?: string[] };
      permissions?: string[];
    };
    // Commands are split across risk-grouped permission sets (Phase 4); the union
    // of all of them must still equal the registered command surface.
    const permissionSetFiles = ['default', 'secrets', 'inference', 'models', 'vault-write'];
    const allPermissions = permissionSetFiles
      .map(name => readText(`../src-tauri/permissions/${name}.toml`))
      .join('\n');

    // Release capability trusts ONLY the packaged runtime ports 1421/1422. The
    // dev-server origin (1420) must NOT be embedded here — it is injected at
    // runtime under debug_assertions from dev-remote-capability.json (AN-SEC-001).
    expect(capability.remote?.urls).toEqual(
      expect.arrayContaining(['http://127.0.0.1:1421', 'http://127.0.0.1:1422']),
    );
    expect(capability.remote?.urls).not.toContain('http://127.0.0.1:1420');
    expect(capability.permissions).toEqual(
      expect.arrayContaining([
        'core:path:default',
        'default',
        'secrets',
        'inference',
        'models',
        'vault-write',
      ]),
    );
    expect(capability.description).toContain('App-owned Tauri commands are exposed');
    expect(capability.description).not.toContain('without an ACL entry');

    const generateHandlerCommands = extractRustCommandNamesFromGenerateHandler(
      readText('../src-tauri/src/lib.rs'),
    );
    const buildManifestCommands = extractRustCommandNamesFromBuildManifest(
      readText('../src-tauri/build.rs'),
    );
    const permissionCommands = extractRustCommandNamesFromPermissionSet(allPermissions);

    expect(buildManifestCommands).toEqual(generateHandlerCommands);
    // The union spans several files in risk order, not build.rs order — compare
    // as sets so a regrouping doesn't break the "every command is permissioned"
    // invariant, only a missing/extra command does.
    expect([...permissionCommands].sort()).toEqual([...buildManifestCommands].sort());
  });

  it('invokes the registered Tauri command names with stable argument envelopes', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === DESKTOP_COMMANDS.desktopStatus) return { desktop: true, platform: 'darwin' };
      if (command === DESKTOP_COMMANDS.runtimeHealth) return { ok: true };
      if (command === DESKTOP_COMMANDS.hfGetEndpoint || command === DESKTOP_COMMANDS.hfSetEndpoint) {
        return { configuredEndpoint: null, effectiveEndpoint: 'https://huggingface.co', source: 'default' };
      }
      if (command === DESKTOP_COMMANDS.engineStart) {
        return { engineId: 'engine-1', format: 'gguf', modelPath: '/m/model.gguf', port: 7123 };
      }
      return undefined;
    });

    await keychainSet('connection:provider', 'secret');
    await runtimeHealth({ connectionId: 'c1', baseUrl: 'http://127.0.0.1:11434', transport: 'ollama-native' });
    await hfGetEndpoint();
    await hfSetEndpoint('https://hf-mirror.com');
    await hfDownloadGguf(
      {
        repoId: 'org/model',
        filename: 'model.Q4_K_M.gguf',
        destPath: '/models/model.Q4_K_M.gguf',
        expectedSha256: 'sha256:abc',
        expectedSizeBytes: 123,
      },
      () => {},
    );
    await engineStart({ modelPath: '/m/model.gguf', format: 'gguf' });
    await expect(getDesktopStatus()).resolves.toMatchObject({ desktop: true, platform: 'darwin' });

    expect(mocks.invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.keychainSet, {
      account: 'connection:provider',
      secret: 'secret',
    });
    expect(mocks.invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.runtimeHealth, {
      input: { connectionId: 'c1', baseUrl: 'http://127.0.0.1:11434', transport: 'ollama-native' },
    });
    expect(mocks.invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.hfGetEndpoint, undefined);
    expect(mocks.invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.hfSetEndpoint, {
      endpoint: 'https://hf-mirror.com',
    });
    expect(mocks.invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.hfDownloadGguf, {
      args: {
        repoId: 'org/model',
        filename: 'model.Q4_K_M.gguf',
        destPath: '/models/model.Q4_K_M.gguf',
        expectedSha256: 'sha256:abc',
        expectedSizeBytes: 123,
      },
      onProgress: expect.any(Object),
    });
    expect(mocks.invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.engineStart, {
      args: { modelPath: '/m/model.gguf', format: 'gguf' },
    });
    expect(mocks.invoke).toHaveBeenCalledWith(DESKTOP_COMMANDS.desktopStatus, undefined);
  });

  it('fills missing desktop model paths from the Tauri path API', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    mocks.invoke.mockResolvedValueOnce({
      desktop: true,
      platform: 'darwin',
      app_data_dir: null,
      model_dir: null,
    });
    mocks.homeDir.mockResolvedValue('/Users/me');
    mocks.join
      .mockResolvedValueOnce('/Users/me/.inkmarshal/app')
      .mockResolvedValueOnce('/Users/me/.inkmarshal/app/models');

    await expect(getDesktopStatus()).resolves.toMatchObject({
      desktop: true,
      platform: 'darwin',
      app_data_dir: '/Users/me/.inkmarshal/app',
      model_dir: '/Users/me/.inkmarshal/app/models',
    });
    expect(mocks.join).toHaveBeenCalledWith(
      '/Users/me',
      '.inkmarshal',
      'app',
    );
    expect(mocks.join).toHaveBeenCalledWith(
      '/Users/me/.inkmarshal/app',
      'models',
    );
  });

  it('falls back to Tauri paths when desktop_status rejects', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    mocks.invoke.mockRejectedValueOnce(new Error('command failed'));
    mocks.homeDir.mockResolvedValue('/Users/me');
    mocks.join
      .mockResolvedValueOnce('/Users/me/.inkmarshal/app')
      .mockResolvedValueOnce('/Users/me/.inkmarshal/app/models');

    await expect(getDesktopStatus()).resolves.toMatchObject({
      desktop: true,
      platform: 'MacIntel',
      app_data_dir: '/Users/me/.inkmarshal/app',
      model_dir: '/Users/me/.inkmarshal/app/models',
    });
  });
});
