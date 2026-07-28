import { beforeEach, describe, expect, it, vi } from 'vitest';

const desktopMocks = vi.hoisted(() => ({
  engineStart: vi.fn(),
  engineStop: vi.fn(),
}));

const connectionMocks = vi.hoisted(() => ({
  upsertConnectionWithSecretCleanup: vi.fn(),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  engineStart: desktopMocks.engineStart,
  engineStop: desktopMocks.engineStop,
}));

vi.mock('./connections', () => ({
  upsertConnectionWithSecretCleanup: connectionMocks.upsertConnectionWithSecretCleanup,
}));

import {
  isLocalEngineConnectionId,
  localEngineConnectionId,
  localEngineConnectionInput,
  startAndRegisterLocalEngine,
} from './local-engine';

describe('localEngineConnectionInput', () => {
  it('builds an openai-compatible local connection at the engine port', () => {
    const c = localEngineConnectionInput(
      {
        engineId: 'gguf:/m/x.gguf',
        format: 'gguf',
        modelPath: '/m/x.gguf',
        port: 51817,
        footprintBytes: 4_700_000_000,
      },
      'x.gguf',
    );
    expect(c.kind).toBe('local');
    expect(c.transport).toBe('openai-compatible');
    expect(c.baseUrl).toBe('http://127.0.0.1:51817/v1');
    expect(c.label).toContain('x.gguf');
    expect(c.secretRef).toBeNull();
  });

  it('appends engineLabel to the connection label when present', () => {
    const c = localEngineConnectionInput(
      {
        engineId: 'gguf:/m/x.gguf#draft',
        format: 'gguf',
        modelPath: '/m/x.gguf',
        port: 51818,
        footprintBytes: 4_700_000_000,
        engineLabel: 'draft',
      },
      'x.gguf',
    );
    expect(c.label).toContain('draft');
  });
});

describe('localEngineConnectionId / isLocalEngineConnectionId', () => {
  it('prefixes engineIds with the local-engine namespace', () => {
    expect(localEngineConnectionId('gguf:/m/x.gguf')).toBe('local-engine:gguf:/m/x.gguf');
  });

  it('treats prefixed ids as local-engine ids and others as not', () => {
    expect(isLocalEngineConnectionId('local-engine:gguf:/m/x.gguf')).toBe(true);
    expect(isLocalEngineConnectionId('provider-openai')).toBe(false);
  });
});

describe('startAndRegisterLocalEngine durable registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopMocks.engineStop.mockResolvedValue(undefined);
  });

  it('awaits durable connection registration before returning success', async () => {
    desktopMocks.engineStart.mockResolvedValueOnce({
      engineId: 'gguf:/m/x.gguf',
      format: 'gguf',
      modelPath: '/m/x.gguf',
      port: 51817,
      footprintBytes: 4_700_000_000,
    });
    connectionMocks.upsertConnectionWithSecretCleanup.mockResolvedValueOnce({
      id: 'local-engine:gguf:/m/x.gguf',
      label: 'Local engine · x.gguf',
      kind: 'local',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:51817/v1',
      secretRef: null,
      createdAt: 't0',
      updatedAt: 't0',
    });

    const result = await startAndRegisterLocalEngine('/m/x.gguf', 'gguf', 'x.gguf');

    expect(connectionMocks.upsertConnectionWithSecretCleanup).toHaveBeenCalledWith({
      id: 'local-engine:gguf:/m/x.gguf',
      label: 'Local engine · x.gguf',
      kind: 'local',
      transport: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:51817/v1',
      secretRef: null,
    });
    expect(result.connection.id).toBe('local-engine:gguf:/m/x.gguf');
    expect(result.engineId).toBe('gguf:/m/x.gguf');
    expect(desktopMocks.engineStop).not.toHaveBeenCalled();
  });

  it('stops the exact newly spawned engine and surfaces a stable error when registration fails', async () => {
    desktopMocks.engineStart.mockResolvedValueOnce({
      engineId: 'gguf:/m/new.gguf',
      format: 'gguf',
      modelPath: '/m/new.gguf',
      port: 51819,
      footprintBytes: 1,
    });
    connectionMocks.upsertConnectionWithSecretCleanup.mockRejectedValueOnce(
      new Error('Failed to persist connection settings'),
    );

    await expect(
      startAndRegisterLocalEngine('/m/new.gguf', 'gguf', 'new.gguf'),
    ).rejects.toThrow('Failed to register local engine connection');

    expect(desktopMocks.engineStop).toHaveBeenCalledTimes(1);
    expect(desktopMocks.engineStop).toHaveBeenCalledWith('gguf:/m/new.gguf');
  });

  it('surfaces when registration and exact-engine cleanup both fail', async () => {
    desktopMocks.engineStart.mockResolvedValueOnce({
      engineId: 'gguf:/m/leaked.gguf',
      format: 'gguf',
      modelPath: '/m/leaked.gguf',
      port: 51820,
      footprintBytes: 1,
    });
    connectionMocks.upsertConnectionWithSecretCleanup.mockRejectedValueOnce(
      new Error('Failed to persist connection settings'),
    );
    desktopMocks.engineStop.mockRejectedValueOnce(new Error('native stop failed'));

    await expect(
      startAndRegisterLocalEngine('/m/leaked.gguf', 'gguf', 'leaked.gguf'),
    ).rejects.toThrow('Failed to register local engine connection and stop the spawned engine');
    expect(desktopMocks.engineStop).toHaveBeenCalledWith('gguf:/m/leaked.gguf');
  });
});
