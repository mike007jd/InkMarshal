import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

import { VAULT_COMMANDS, vaultRevealInFinder, vaultWatchStart, vaultWatchStop } from '@/lib/vault/ipc';

describe('vault IPC command contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('starts and stops watchers with the vault path in the argument envelope', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });

    await vaultWatchStart('novel-1', '/vault/a', 'watch-1');
    await vaultWatchStop('novel-1', '/vault/a', 'watch-1');

    expect(mocks.invoke).toHaveBeenCalledWith(VAULT_COMMANDS.vaultWatchStart, {
      novelId: 'novel-1',
      vaultPath: '/vault/a',
      watchId: 'watch-1',
    });
    expect(mocks.invoke).toHaveBeenCalledWith(VAULT_COMMANDS.vaultWatchStop, {
      novelId: 'novel-1',
      vaultPath: '/vault/a',
      watchId: 'watch-1',
    });
  });

  it('reveals a vault only with novel ownership context in the argument envelope', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });

    await vaultRevealInFinder('novel-1', '/external/InkMarshal Vault');

    expect(mocks.invoke).toHaveBeenCalledWith(VAULT_COMMANDS.vaultRevealInFinder, {
      novelId: 'novel-1',
      vaultPath: '/external/InkMarshal Vault',
    });
  });
});
