'use client';

import type { EngineInfo } from '@/lib/desktop-runtime';
import { engineStart } from '@/lib/desktop-runtime';
import { upsertConnection } from './connections';
import type { RuntimeConnection } from './types';

const LOCAL_ENGINE_LABEL_PREFIX = 'Local engine';
const LOCAL_ENGINE_CONNECTION_PREFIX = 'local-engine:';

/**
 * Build the connection id for one running engine. Each engine instance gets
 * its own connection row so the broker can route different capability roles
 * to different localhost ports without rows overwriting each other.
 *
 * The engineId is the Rust-side identity ("{fmt}:{path}" or "{fmt}:{path}#{label}");
 * prefixing with `local-engine:` keeps it visibly local in the connections list.
 */
export function localEngineConnectionId(engineId: string): string {
  return `${LOCAL_ENGINE_CONNECTION_PREFIX}${engineId}`;
}

/** True when a connection id was minted by {@link localEngineConnectionId}. */
export function isLocalEngineConnectionId(id: string): boolean {
  return id.startsWith(LOCAL_ENGINE_CONNECTION_PREFIX);
}

/** The connection record (minus id/createdAt/updatedAt) for a running engine.
 * No secret — a localhost bundled server needs no API key. */
export function localEngineConnectionInput(info: EngineInfo, modelLabel: string) {
  const labelSuffix = info.engineLabel ? ` · ${info.engineLabel}` : '';
  return {
    label: `${LOCAL_ENGINE_LABEL_PREFIX} · ${modelLabel}${labelSuffix}`,
    kind: 'local' as const,
    transport: 'openai-compatible' as const,
    baseUrl: `http://127.0.0.1:${info.port}/v1`,
    secretRef: null,
  };
}

/**
 * Start the bundled engine for a downloaded model and upsert its
 * openai-compatible connection so the broker can resolve it. Returns the
 * upserted connection + the model id + engine metadata. One call here = one
 * engine process + one connection row.
 */
export async function startAndRegisterLocalEngine(
  modelPath: string,
  format: 'gguf' | 'mlx',
  modelLabel: string,
  opts?: { engineLabel?: string },
): Promise<{
  connection: RuntimeConnection;
  modelId: string;
  engineId: string;
  footprintBytes: number;
  info: EngineInfo;
}> {
  const info = await engineStart({
    modelPath,
    format,
    engineLabel: opts?.engineLabel ?? null,
  });
  const base = localEngineConnectionInput(info, modelLabel);
  const connectionId = localEngineConnectionId(info.engineId);
  const connection = upsertConnection({ id: connectionId, ...base });
  return {
    connection,
    modelId: modelLabel,
    engineId: info.engineId,
    footprintBytes: info.footprintBytes ?? 0,
    info,
  };
}
