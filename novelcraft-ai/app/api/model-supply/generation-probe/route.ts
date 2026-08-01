import { NextResponse } from 'next/server';

import { requestAllowsUserRuntime } from '@/lib/ai-providers';
import {
  runGenerationProbe,
  type GenerationProbeInput,
} from '@/lib/model-supply/generation-probe';
import {
  isRuntimeConnectionKind,
  isRuntimeTransport,
} from '@/lib/model-supply/types';

export const runtime = 'nodejs';

function parseBody(value: unknown): GenerationProbeInput | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isRuntimeConnectionKind(raw.kind)) return null;
  if (!isRuntimeTransport(raw.transport)) return null;
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) return null;
  if (typeof raw.modelId !== 'string' || !raw.modelId.trim()) return null;
  if (raw.secret != null && typeof raw.secret !== 'string') return null;
  const secret = typeof raw.secret === 'string' ? raw.secret : null;
  return {
    kind: raw.kind,
    transport: raw.transport,
    baseUrl: raw.baseUrl.trim(),
    modelId: raw.modelId.trim(),
    secret,
  };
}

/**
 * Loopback-only real-generation probe. Body carries ephemeral endpoint + key;
 * nothing is persisted. Response is only `{ ok: true }` or
 * `{ ok: false, category }` — never prompts, outputs, or secrets.
 */
export async function POST(req: Request) {
  if (!requestAllowsUserRuntime(req)) {
    return NextResponse.json(
      { ok: false, category: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, category: 'generation-failed' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const input = parseBody(json);
  if (!input) {
    return NextResponse.json(
      { ok: false, category: 'generation-failed' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const result = await runGenerationProbe(req, input);
  return NextResponse.json(result, {
    status: result.ok ? 200 : 422,
    headers: { 'Cache-Control': 'no-store' },
  });
}
