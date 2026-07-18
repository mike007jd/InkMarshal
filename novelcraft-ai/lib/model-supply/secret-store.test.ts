// Phase 1 — secret storage is desktop-only and fail-closed: off-desktop every
// operation rejects rather than silently persisting to localStorage. Validation
// of the account/value shape runs before the runtime check.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const isTauri = vi.fn<() => boolean>(() => true);
const keychain = new Map<string, string>();

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => isTauri(),
  keychainSet: vi.fn(async (account: string, value: string) => {
    keychain.set(account, value);
    return 'keychain';
  }),
  keychainGet: vi.fn(async (account: string) =>
    keychain.has(account) ? (keychain.get(account) ?? null) : null,
  ),
  keychainDelete: vi.fn(async (account: string) => {
    keychain.delete(account);
    return 'keychain';
  }),
  keychainStatus: vi.fn(async () => 'keychain'),
}));

const ACCOUNT = 'connection:test-id';

async function load() {
  return import('@/lib/model-supply/secret-store');
}

beforeEach(() => {
  vi.resetModules();
  isTauri.mockReturnValue(true);
  keychain.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('secret-store (desktop-only, fail-closed)', () => {
  it('round-trips a secret through the keychain on desktop', async () => {
    const { setSecret, getSecret, deleteSecret } = await load();
    await setSecret(ACCOUNT, 'sk-live');
    expect(await getSecret(ACCOUNT)).toBe('sk-live');
    await deleteSecret(ACCOUNT);
    expect(await getSecret(ACCOUNT)).toBeNull();
  });

  it('rejects every operation off-desktop (never touches localStorage)', async () => {
    isTauri.mockReturnValue(false);
    const { setSecret, getSecret, deleteSecret } = await load();
    await expect(setSecret(ACCOUNT, 'sk')).rejects.toThrow(/desktop keychain runtime/);
    await expect(getSecret(ACCOUNT)).rejects.toThrow(/desktop keychain runtime/);
    await expect(deleteSecret(ACCOUNT)).rejects.toThrow(/desktop keychain runtime/);
  });

  it('validates account/value shape before the runtime check', async () => {
    isTauri.mockReturnValue(false);
    const { setSecret, getSecret } = await load();
    // Invalid shape → shape error, NOT the desktop-required error.
    await expect(getSecret('not-namespaced')).rejects.toThrow(/account is invalid/);
    await expect(setSecret('connection:x', '')).rejects.toThrow(/value is invalid/);
  });

  it('rejects control characters in account and value', async () => {
    const { setSecret } = await load();
    const NUL = String.fromCharCode(0);
    const LF = String.fromCharCode(10);
    await expect(setSecret(`connection:a${NUL}b`, 'v')).rejects.toThrow(/account is invalid/);
    await expect(setSecret(ACCOUNT, `line${LF}break`)).rejects.toThrow(/value is invalid/);
  });

  it('secretStoreStatus reflects runtime availability', async () => {
    const { secretStoreStatus } = await load();
    expect(secretStoreStatus()).toEqual({ backend: 'keychain', available: true });
    isTauri.mockReturnValue(false);
    expect(secretStoreStatus()).toEqual({ backend: 'keychain', available: false });
  });

  it('secretStoreActiveBackend probes keychain on desktop, rejects off-desktop', async () => {
    const { secretStoreActiveBackend } = await load();
    expect(await secretStoreActiveBackend()).toBe('keychain');
    isTauri.mockReturnValue(false);
    await expect(secretStoreActiveBackend()).rejects.toThrow(/desktop keychain runtime/);
  });
});
