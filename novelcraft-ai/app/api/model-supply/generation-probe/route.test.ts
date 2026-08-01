import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runGenerationProbe: vi.fn(),
}));

vi.mock('@/lib/model-supply/generation-probe', async () => {
  const actual = await vi.importActual<typeof import('@/lib/model-supply/generation-probe')>(
    '@/lib/model-supply/generation-probe',
  );
  return { ...actual, runGenerationProbe: mocks.runGenerationProbe };
});

import { POST } from './route';

beforeEach(() => {
  mocks.runGenerationProbe.mockReset();
});

describe('POST /api/model-supply/generation-probe', () => {
  it('rejects non-loopback callers before handling a secret', async () => {
    const response = await POST(new Request('https://example.com/api/model-supply/generation-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'provider',
        transport: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'example-model',
        secret: 'must-not-leak',
      }),
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: false, category: 'forbidden' });
    expect(mocks.runGenerationProbe).not.toHaveBeenCalled();
  });

  it('rejects malformed secret values without running generation', async () => {
    const response = await POST(new Request('http://localhost/api/model-supply/generation-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'provider',
        transport: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'example-model',
        secret: 123,
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, category: 'generation-failed' });
    expect(mocks.runGenerationProbe).not.toHaveBeenCalled();
  });

  it('returns only the safe probe result and never echoes credentials', async () => {
    mocks.runGenerationProbe.mockResolvedValue({ ok: true });
    const secret = 'sensitive-test-secret';
    const response = await POST(new Request('http://127.0.0.1/api/model-supply/generation-probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'provider',
        transport: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'example-model',
        secret,
      }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({ ok: true });
    expect(responseText).not.toContain(secret);
    expect(mocks.runGenerationProbe).toHaveBeenCalledTimes(1);
  });
});
