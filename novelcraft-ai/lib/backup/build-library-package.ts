import { strToU8, zipSync } from 'fflate';

import { exportFilenameBase } from '@/lib/exporters/filename';

export const LIBRARY_BACKUP_FORMAT_VERSION = '1.0.0';
export const LIBRARY_MANIFEST_PATH = 'library.json';

export interface LibraryBackupNovel {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface LibraryBackupItem {
  novel: LibraryBackupNovel;
  backupBytes: Uint8Array;
}

export interface LibraryBackupManifestNovel extends LibraryBackupNovel {
  path: string;
  sizeBytes: number;
}

export interface LibraryBackupManifest {
  formatVersion: string;
  exportedAt: string;
  novelCount: number;
  novels: LibraryBackupManifestNovel[];
}

export interface BuiltLibraryBackupPackage {
  bytes: Uint8Array;
  manifest: LibraryBackupManifest;
}

function libraryEntryPath(index: number, title: string): string {
  const sequence = String(index + 1).padStart(4, '0');
  return `novels/${sequence}-${exportFilenameBase(title)}.inkmarshal`;
}

/**
 * Wrap verified per-novel `.inkmarshal` packages in one portable library ZIP.
 * The numbered path prefix makes duplicate titles unambiguous, while
 * `library.json` preserves original ids/timestamps for inventory and audits.
 */
export function buildLibraryBackupPackage(
  items: readonly LibraryBackupItem[],
  exportedAt = new Date().toISOString(),
): BuiltLibraryBackupPackage {
  if (items.length === 0) throw new Error('Cannot export an empty novel library');
  const ids = new Set<string>();
  const zipInput: Record<string, Uint8Array> = {};
  const novels = items.map<LibraryBackupManifestNovel>((item, index) => {
    if (!item.novel.id || ids.has(item.novel.id)) {
      throw new Error('Library backup contains a missing or duplicate novel id');
    }
    if (item.backupBytes.byteLength === 0) {
      throw new Error(`Library backup for ${item.novel.id} is empty`);
    }
    ids.add(item.novel.id);
    const path = libraryEntryPath(index, item.novel.title);
    zipInput[path] = item.backupBytes;
    return {
      ...item.novel,
      path,
      sizeBytes: item.backupBytes.byteLength,
    };
  });
  const manifest: LibraryBackupManifest = {
    formatVersion: LIBRARY_BACKUP_FORMAT_VERSION,
    exportedAt,
    novelCount: novels.length,
    novels,
  };
  zipInput[LIBRARY_MANIFEST_PATH] = strToU8(JSON.stringify(manifest, null, 2));
  return {
    bytes: zipSync(zipInput, { level: 6 }),
    manifest,
  };
}
