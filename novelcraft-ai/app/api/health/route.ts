import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';

export function GET() {
  const runtime = process.env.INKMARSHAL_RUNTIME === 'desktop' ? 'desktop' : 'web';
  const token = process.env.INKMARSHAL_DESKTOP_SESSION;
  const body: { ok: true; runtime: 'desktop' | 'web'; session?: string } = { ok: true, runtime };

  // Identity proof for the Tauri readiness probe (AN-SEC-001): return
  // sha256(token) so the native layer can confirm THIS server is the Node
  // sidecar it spawned (the token was handed to us via env) before it navigates
  // the webview here. A process that pre-empted the loopback port has no token
  // and cannot reproduce the proof. sha256 is one-way, so publishing it cannot
  // leak the session token that gates the local API.
  if (runtime === 'desktop' && token) {
    body.session = createHash('sha256').update(token).digest('hex');
  }

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
