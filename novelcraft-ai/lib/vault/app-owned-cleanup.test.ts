import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __appOwnedCleanupTest,
  quarantineAppOwnedNovelVault,
  quarantineAppOwnedVaultRoot,
  reconcileAppOwnedVaultCleanupIntents,
} from '@/lib/vault/app-owned-cleanup';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-vault-cleanup-intent-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function fakeDb(
  novelIds: readonly string[],
  novelVaults: Array<{ id: string; vault_path: string }> = [],
  seriesVaults: string[] = [],
) {
  const existing = new Set(novelIds);
  return {
    prepare(sql: string) {
      return {
        get(...params: unknown[]) {
          if (sql.includes('WHERE id')) {
            return existing.has(String(params[0])) ? { present: 1 } : undefined;
          }
          if (sql.includes('FROM series')) {
            return seriesVaults.length > 0 ? { present: 1 } : undefined;
          }
          return existing.size > 0 || novelVaults.length > 0 ? { present: 1 } : undefined;
        },
        all() {
          if (sql.includes('FROM series')) {
            return seriesVaults.map(vault_path => ({ vault_path }));
          }
          return novelVaults;
        },
      };
    },
  };
}

function intentFiles(): string[] {
  return readdirSync(dataDir).filter(name => name.startsWith('.vault-cleanup-intent-'));
}

describe('durable app-owned Vault cleanup intents', () => {
  it('restores a quarantined novel Vault after a crash before database deletion', () => {
    const vaultPath = path.join(dataDir, 'vaults', 'custom-vault-folder');
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(path.join(vaultPath, 'keep.md'), 'restore me');
    const quarantine = quarantineAppOwnedNovelVault(vaultPath, 'novel-restore');
    expect(quarantine).not.toBeNull();
    expect(existsSync(vaultPath)).toBe(false);
    __appOwnedCleanupTest.forgetActiveIntent(quarantine!.intentPath);

    reconcileAppOwnedVaultCleanupIntents(fakeDb(['novel-restore']));

    expect(readFileSync(path.join(vaultPath, 'keep.md'), 'utf8')).toBe('restore me');
    expect(intentFiles()).toEqual([]);
  });

  it('purges a quarantined novel Vault after a crash following database deletion', () => {
    const vaultPath = path.join(dataDir, 'vaults', 'novel-purge');
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(path.join(vaultPath, 'remove.md'), 'remove me');
    const quarantine = quarantineAppOwnedNovelVault(vaultPath, 'novel-purge');
    expect(quarantine).not.toBeNull();
    __appOwnedCleanupTest.forgetActiveIntent(quarantine!.intentPath);

    reconcileAppOwnedVaultCleanupIntents(fakeDb([]));

    expect(existsSync(vaultPath)).toBe(false);
    expect(existsSync(quarantine!.quarantine)).toBe(false);
    expect(intentFiles()).toEqual([]);
  });

  it('restores instead of purging when a series still references the same Vault path', () => {
    const vaultPath = path.join(dataDir, 'vaults', 'shared-after-crash');
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(path.join(vaultPath, 'shared.md'), 'keep for series');
    const quarantine = quarantineAppOwnedNovelVault(vaultPath, 'deleted-novel');
    expect(quarantine).not.toBeNull();
    __appOwnedCleanupTest.forgetActiveIntent(quarantine!.intentPath);

    reconcileAppOwnedVaultCleanupIntents(fakeDb([], [], [vaultPath]));

    expect(readFileSync(path.join(vaultPath, 'shared.md'), 'utf8')).toBe('keep for series');
    expect(intentFiles()).toEqual([]);
  });

  it('finishes an interrupted whole-library Vault clear when the library is empty', () => {
    const vaultPath = path.join(dataDir, 'vaults', 'orphan', 'notes.md');
    mkdirSync(path.dirname(vaultPath), { recursive: true });
    writeFileSync(vaultPath, 'remove all');
    const quarantine = quarantineAppOwnedVaultRoot();
    expect(quarantine).not.toBeNull();
    __appOwnedCleanupTest.forgetActiveIntent(quarantine!.intentPath);

    reconcileAppOwnedVaultCleanupIntents(fakeDb([]));

    expect(existsSync(path.join(dataDir, 'vaults'))).toBe(false);
    expect(existsSync(quarantine!.quarantine)).toBe(false);
    expect(intentFiles()).toEqual([]);
  });
});
