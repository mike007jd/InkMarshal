import { describe, expect, it } from 'vitest';

import { safeParseJson, safeParseJsonObject } from '@/lib/utils';

describe('safeParseJson', () => {
  it('parses valid JSON and rejects malformed JSON', async () => {
    const ok = await safeParseJson<{ value: number }>(new Request('http://test.local', {
      method: 'POST',
      body: JSON.stringify({ value: 1 }),
    }));
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual({ value: 1 });

    const bad = await safeParseJson(new Request('http://test.local', {
      method: 'POST',
      body: '{',
    }));
    expect(bad.error?.status).toBe(400);
  });

  it('rejects bodies over the byte limit before JSON parsing', async () => {
    const result = await safeParseJson(new Request('http://test.local', {
      method: 'POST',
      body: JSON.stringify({ value: 'x'.repeat(20) }),
    }), { maxBytes: 10 });

    expect(result.error?.status).toBe(413);
  });

  it('rejects oversized content-length headers without reading the stream', async () => {
    const result = await safeParseJson(new Request('http://test.local', {
      method: 'POST',
      headers: { 'content-length': '999' },
      body: JSON.stringify({ value: 1 }),
    }), { maxBytes: 10 });

    expect(result.error?.status).toBe(413);
  });

  it('rejects valid JSON values that are not objects when an object body is required', async () => {
    const result = await safeParseJsonObject(new Request('http://test.local', {
      method: 'POST',
      body: JSON.stringify(null),
    }));

    expect(result.data).toBeNull();
    expect(result.error?.status).toBe(400);
    expect(await result.error?.json()).toEqual({ error: 'JSON body must be an object' });
  });
});
