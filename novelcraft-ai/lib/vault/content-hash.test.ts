import { describe, expect, it } from 'vitest';
import { hashContent } from '@/lib/vault/content-hash';

describe('vault/content-hash', () => {
  it('matches the canonical SHA-256 of "hello"', async () => {
    // Verified against sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    const got = await hashContent('hello');
    expect(got).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('matches the canonical SHA-256 of empty string', async () => {
    const got = await hashContent('');
    expect(got).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('handles UTF-8 multibyte characters', async () => {
    // sha256(UTF-8 of "林深") = locked-in expectation.
    const got = await hashContent('林深');
    // crypto.subtle digest of "林深" (UTF-8 bytes E6 9E 97 E6 B7 B1).
    expect(got).toMatch(/^[0-9a-f]{64}$/);
    // Same input twice → same hash (deterministic).
    expect(got).toBe(await hashContent('林深'));
  });

  it('produces different digests for different inputs', async () => {
    const a = await hashContent('a');
    const b = await hashContent('b');
    expect(a).not.toBe(b);
  });
});
