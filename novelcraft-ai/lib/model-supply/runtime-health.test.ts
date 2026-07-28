import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
  runtimeHealth: vi.fn(),
  getConnectionSecretForSnapshot: vi.fn(),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: mocks.isTauriRuntime,
  runtimeHealth: mocks.runtimeHealth,
}));

vi.mock('./connections', () => ({
  getConnectionSecretForSnapshot: mocks.getConnectionSecretForSnapshot,
}));

import { checkConnectionHealth } from './runtime-health';
import type { RuntimeConnection } from './types';

function connection(overrides: Partial<RuntimeConnection> = {}): RuntimeConnection {
  return {
    id: 'conn-1',
    label: 'Provider',
    kind: 'provider',
    transport: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    secretRef: { account: 'connection:conn-1' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('checkConnectionHealth', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.isTauriRuntime.mockReturnValue(true);
  });

  it('passes the stored connection secret into the desktop health probe', async () => {
    mocks.getConnectionSecretForSnapshot.mockResolvedValue('sk-live');
    mocks.runtimeHealth.mockResolvedValue({
      reachable: true,
      transportOk: true,
      models: ['model-a'],
      latencyMs: 12,
      message: 'Reachable, 1 model(s)',
    });

    await expect(checkConnectionHealth(connection())).resolves.toMatchObject({
      transportOk: true,
      models: ['model-a'],
    });

    expect(mocks.getConnectionSecretForSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1' }),
    );
    expect(mocks.runtimeHealth).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      baseUrl: 'https://api.example.com/v1',
      transport: 'openai-compatible',
      secret: 'sk-live',
    });
  });

  it('does not touch secret storage for keyless local runtimes', async () => {
    mocks.runtimeHealth.mockResolvedValue({
      reachable: true,
      transportOk: true,
      models: ['qwen3.5:4b'],
      latencyMs: 10,
      message: 'Ollama reachable, 1 model(s)',
    });

    await checkConnectionHealth(
      connection({
        kind: 'local',
        transport: 'ollama-native',
        baseUrl: 'http://127.0.0.1:11434',
        secretRef: null,
      }),
    );

    expect(mocks.getConnectionSecretForSnapshot).not.toHaveBeenCalled();
    expect(mocks.runtimeHealth).toHaveBeenCalledWith({
      connectionId: 'conn-1',
      baseUrl: 'http://127.0.0.1:11434',
      transport: 'ollama-native',
      secret: null,
    });
  });

  it('surfaces keychain failures as degraded health instead of probing without the key', async () => {
    mocks.getConnectionSecretForSnapshot.mockRejectedValue(new Error('keyring locked'));

    await expect(checkConnectionHealth(connection())).resolves.toMatchObject({
      reachable: false,
      transportOk: false,
      models: [],
      message: 'keyring locked',
    });

    expect(mocks.runtimeHealth).not.toHaveBeenCalled();
  });

  it('keeps web mode degraded without reading secrets', async () => {
    mocks.isTauriRuntime.mockReturnValue(false);

    await expect(checkConnectionHealth(connection())).resolves.toMatchObject({
      reachable: false,
      transportOk: false,
      models: [],
      message: 'Runtime health checks require the desktop app',
    });

    expect(mocks.getConnectionSecretForSnapshot).not.toHaveBeenCalled();
    expect(mocks.runtimeHealth).not.toHaveBeenCalled();
  });
});
