import { isVaultEntryPath, VAULT_RECONCILE_BATCH } from '@/lib/vault/entry';
import type { VaultChangedKind } from '@/lib/vault/types';

interface LiveVaultChangedFile {
  path: string;
  content: string | null;
}

export interface LiveVaultCollectOptions {
  /**
   * When false, missing remove/rename/other paths are deferred (not emitted as
   * `content: null`) so a pending root cannot delete canonical SQLite rows.
   */
  allowMissingFileDeletes?: boolean;
}

export interface LiveVaultCollectResult {
  files: LiveVaultChangedFile[];
  /** Missing delete-kind paths retained for replay after the root is established. */
  deferredDeletePaths: string[];
}

export function chunkLiveVaultMarkdownPaths(paths: string[]): string[][] {
  const markdownPaths = paths.filter(isVaultEntryPath);
  const chunks: string[][] = [];
  for (let i = 0; i < markdownPaths.length; i += VAULT_RECONCILE_BATCH) {
    chunks.push(markdownPaths.slice(i, i + VAULT_RECONCILE_BATCH));
  }
  return chunks;
}

/**
 * Build reconcile payloads from watcher paths. Deletion is determined only from
 * an explicit missing-file read result for rename/remove/other — a still-readable
 * path never becomes `content: null` merely because a sibling event was remove.
 */
export async function collectLiveVaultChangedFiles(
  kind: VaultChangedKind,
  paths: string[],
  readContent: (relPath: string) => Promise<string>,
  options: LiveVaultCollectOptions = {},
): Promise<LiveVaultCollectResult> {
  const allowMissingFileDeletes = options.allowMissingFileDeletes !== false;
  const deferredDeletePaths: string[] = [];
  const files = await Promise.all(paths.map(async relPath => {
    try {
      return { path: relPath, content: await readContent(relPath) };
    } catch (err) {
      if (!isMissingVaultReadError(err)) {
        // Permission/transient I/O is neither content nor proof of deletion.
        // Fail the batch so the runtime can retain and retry it.
        throw err;
      }
      if (kind === 'remove' || kind === 'rename' || kind === 'other') {
        if (!allowMissingFileDeletes) {
          deferredDeletePaths.push(relPath);
          return null;
        }
        return { path: relPath, content: null };
      }
      return null;
    }
  }));
  return {
    files: files.filter((file): file is LiveVaultChangedFile => Boolean(file)),
    deferredDeletePaths,
  };
}

function isMissingVaultReadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // Only the Rust command's authenticated entry-level absence code authorizes
  // a destructive DB delete. Root/mount loss and generic I/O remain retryable.
  return message.startsWith('VAULT_ENTRY_NOT_FOUND:');
}
