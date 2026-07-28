'use client';

import type { EngineInfo } from '@/lib/desktop-runtime';
import { engineStart, engineStop } from '@/lib/desktop-runtime';
import { upsertConnectionWithSecretCleanup } from './connections';
import type { RuntimeConnection } from './types';

const LOCAL_ENGINE_LABEL_PREFIX = 'Local engine';
const LOCAL_ENGINE_CONNECTION_PREFIX = 'local-engine:';
const LOCAL_ENGINE_REGISTRATION_FAILED = 'Failed to register local engine connection';
const LOCAL_ENGINE_REGISTRATION_AND_STOP_FAILED =
  'Failed to register local engine connection and stop the spawned engine';

/**
 * Build the connection id for one running engine. Each engine instance gets
 * its own connection row so the broker can route different capability roles
 * to different localhost ports without rows overwriting each other.
 *
 * The engineId is the Rust-side escaped identity (`{fmt}:v2:{path}[#{label}]`);
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
 *
 * The connection row is awaited durably before success. If registration fails
 * after a new process was spawned, that exact engine is stopped and a stable
 * registration error is surfaced — callers must not treat the engine as usable.
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
  try {
    const connection = await upsertConnectionWithSecretCleanup({
      id: connectionId,
      ...base,
    });
    return {
      connection,
      modelId: modelLabel,
      engineId: info.engineId,
      footprintBytes: info.footprintBytes ?? 0,
      info,
    };
  } catch {
    try {
      await engineStop(info.engineId);
    } catch {
      // The process is live but has no durable connection row. Surface this
      // stronger state instead of pretending cleanup succeeded.
      throw new Error(LOCAL_ENGINE_REGISTRATION_AND_STOP_FAILED);
    }
    throw new Error(LOCAL_ENGINE_REGISTRATION_FAILED);
  }
}
