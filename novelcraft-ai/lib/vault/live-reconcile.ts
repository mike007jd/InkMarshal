import { isVaultEntryPath, VAULT_RECONCILE_BATCH } from '@/lib/vault/entry';
import type { VaultChangedEvent } from '@/lib/vault/types';

export interface LiveVaultChangedFile {
  path: string;
  content: string | null;
}

export function chunkLiveVaultMarkdownPaths(paths: string[]): string[][] {
  const markdownPaths = paths.filter(isVaultEntryPath);
  const chunks: string[][] = [];
  for (let i = 0; i < markdownPaths.length; i += VAULT_RECONCILE_BATCH) {
    chunks.push(markdownPaths.slice(i, i + VAULT_RECONCILE_BATCH));
  }
  return chunks;
}

export async function collectLiveVaultChangedFiles(
  kind: VaultChangedEvent['kind'],
  paths: string[],
  readContent: (relPath: string) => Promise<string>,
): Promise<LiveVaultChangedFile[]> {
  const files = await Promise.all(paths.map(async relPath => {
    if (kind === 'remove') return { path: relPath, content: null };
    try {
      return { path: relPath, content: await readContent(relPath) };
    } catch (err) {
      return kind === 'rename' && isMissingVaultReadError(err)
        ? { path: relPath, content: null }
        : null;
    }
  }));
  return files.filter((file): file is LiveVaultChangedFile => Boolean(file));
}

function isMissingVaultReadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cannot stat|no such file|not found|missing/i.test(message);
}
