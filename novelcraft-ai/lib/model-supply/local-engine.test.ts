import { describe, it, expect } from 'vitest';
import {
  isLocalEngineConnectionId,
  localEngineConnectionId,
  localEngineConnectionInput,
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
