import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import { GET } from './route';

describe('/api/health', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a minimal public web health payload for the proxy allowlist', async () => {
    vi.stubEnv('INKMARSHAL_RUNTIME', '');

    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ ok: true, runtime: 'web' });
  });

  it('reports the desktop runtime without a proof when no session token is set', async () => {
    vi.stubEnv('INKMARSHAL_RUNTIME', 'desktop');
    vi.stubEnv('INKMARSHAL_DESKTOP_SESSION', '');

    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ ok: true, runtime: 'desktop' });
  });

  it('returns sha256(token) as the readiness identity proof in desktop runtime', async () => {
    const token = 'f'.repeat(64);
    vi.stubEnv('INKMARSHAL_RUNTIME', 'desktop');
    vi.stubEnv('INKMARSHAL_DESKTOP_SESSION', token);

    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.runtime).toBe('desktop');
    // The proof is the hash, never the raw token.
    expect(body.session).toBe(createHash('sha256').update(token).digest('hex'));
    expect(body.session).not.toBe(token);
  });
});
