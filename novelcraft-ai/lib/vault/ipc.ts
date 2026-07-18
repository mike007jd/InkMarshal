// Wave 2 commit B — thin wrappers over the Rust tauri commands exported by
// `src-tauri/src/vault.rs`. Kept separate from the higher-level `Vault` class
// so test code (and the migration runner) can drive the commands directly
// without booting React.

import { isTauriRuntime } from '@/lib/desktop-runtime';
import type {
  VaultFileMeta,
  VaultReadResult,
  VaultReachable,
} from '@/lib/vault/types';

export const VAULT_COMMANDS = {
  vaultInit: 'vault_init',
  vaultWalk: 'vault_walk',
  vaultReadFile: 'vault_read_file',
  vaultWriteFile: 'vault_write_file',
  vaultDeleteFile: 'vault_delete_file',
  vaultMove: 'vault_move',
  vaultWatchStart: 'vault_watch_start',
  vaultWatchStop: 'vault_watch_stop',
  vaultRevealInFinder: 'vault_reveal_in_finder',
  vaultReachable: 'vault_reachable',
} as const;

function requireTauri(cmd: string): void {
  if (!isTauriRuntime()) {
    throw new Error(`${cmd} is only available inside the desktop runtime`);
  }
}

async function invokeTauri<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export async function vaultInit(novelId: string, vaultPath: string): Promise<{
  vaultPath: string;
  created: boolean;
  manifestPath: string;
}> {
  requireTauri('vaultInit');
  return invokeTauri(VAULT_COMMANDS.vaultInit, { novelId, vaultPath });
}

export async function vaultWalk(vaultPath: string): Promise<VaultFileMeta[]> {
  requireTauri('vaultWalk');
  return invokeTauri<VaultFileMeta[]>(VAULT_COMMANDS.vaultWalk, { vaultPath });
}

export async function vaultReadFile(vaultPath: string, relPath: string): Promise<VaultReadResult> {
  requireTauri('vaultReadFile');
  return invokeTauri<VaultReadResult>(VAULT_COMMANDS.vaultReadFile, { vaultPath, relPath });
}

export async function vaultWatchStart(
  novelId: string,
  vaultPath: string,
  watchId?: string | null,
): Promise<void> {
  requireTauri('vaultWatchStart');
  await invokeTauri<void>(VAULT_COMMANDS.vaultWatchStart, {
    novelId,
    vaultPath,
    watchId: watchId ?? null,
  });
}

export async function vaultWatchStop(
  novelId: string,
  vaultPath?: string | null,
  watchId?: string | null,
): Promise<void> {
  requireTauri('vaultWatchStop');
  await invokeTauri<void>(VAULT_COMMANDS.vaultWatchStop, {
    novelId,
    vaultPath: vaultPath ?? null,
    watchId: watchId ?? null,
  });
}

export async function vaultRevealInFinder(novelId: string, vaultPath: string): Promise<void> {
  requireTauri('vaultRevealInFinder');
  await invokeTauri<void>(VAULT_COMMANDS.vaultRevealInFinder, { novelId, vaultPath });
}

export async function vaultReachable(vaultPath: string): Promise<VaultReachable> {
  requireTauri('vaultReachable');
  return invokeTauri<VaultReachable>(VAULT_COMMANDS.vaultReachable, { vaultPath });
}
