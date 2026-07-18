// Project-backup (W1-3) — serialize a BackupBundle into a `.inkmarshal` zip.
//
// Fixed layout (see PACKAGE_PATHS):
//   manifest.json                (top level — integrity + provenance)
//   novel.json                   (secret-stripped)
//   chapters/NNNN.json           (one file per chapter, zero-padded)
//   knowledge/entries.json
//   knowledge/relations.json
//   outline.json
//   unification.json
//   prompt-templates.json
//   attachments/<original name>  (binary, optional)
//
// Every file except the manifest is hashed (SHA-256, Web Crypto subtle.digest)
// and recorded in `manifest.sha256[path]`, so verify can detect a single-byte
// tamper. fflate's `zipSync` matches the existing submission-bundle exporter.

import { strToU8, zipSync } from 'fflate';
import {
  PACKAGE_PATHS,
  FORMAT_VERSION,
  chapterEntryPath,
  type BackupBundle,
  type BackupCounts,
  type InkmarshalManifest,
} from '@/lib/backup/types';

const HEX = '0123456789abcdef';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return out;
}

/** SHA-256 of raw bytes as lowercase hex. Matches Node + webview crypto.subtle. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle wants an ArrayBuffer-backed view; slice into a fresh buffer so
  // a subarray view (offset != 0) never hashes the wrong window.
  const buf = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return bytesToHex(new Uint8Array(buf));
}

/** Stable pretty-printed JSON → UTF-8 bytes (human-auditable inside the zip). */
function jsonBytes(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value, null, 2));
}

function countsOf(bundle: BackupBundle): BackupCounts {
  return {
    chapters: bundle.chapters.length,
    knowledgeEntries: bundle.knowledgeEntries.length,
    knowledgeRelations: bundle.knowledgeRelations.length,
    outline: bundle.outline.length,
    promptTemplates: bundle.promptTemplates.length,
    attachments: bundle.attachments.length,
  };
}

/**
 * Build the flat `path -> bytes` map for every non-manifest file. Returns the
 * map in a deterministic order so the resulting zip is reproducible for a given
 * bundle (helpful for diffing two backups).
 */
function buildFileBytes(bundle: BackupBundle): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();

  files.set(PACKAGE_PATHS.novel, jsonBytes(bundle.novel));

  for (const chapter of bundle.chapters) {
    files.set(chapterEntryPath(chapter.chapterNumber), jsonBytes(chapter));
  }

  files.set(PACKAGE_PATHS.knowledgeEntries, jsonBytes(bundle.knowledgeEntries));
  files.set(PACKAGE_PATHS.knowledgeRelations, jsonBytes(bundle.knowledgeRelations));
  files.set(PACKAGE_PATHS.outline, jsonBytes(bundle.outline));
  files.set(PACKAGE_PATHS.unification, jsonBytes(bundle.unificationReport));
  files.set(PACKAGE_PATHS.promptTemplates, jsonBytes(bundle.promptTemplates));

  for (const attachment of bundle.attachments) {
    // Decode base64 → bytes. The attachment name is the leaf; it is placed under
    // attachments/. Names are author-provided leaves, never traversal segments.
    const raw = Uint8Array.from(Buffer.from(attachment.contentsBase64, 'base64'));
    files.set(`${PACKAGE_PATHS.attachmentsDir}${attachment.name}`, raw);
  }

  return files;
}

/** Convert fflate's nested zip input into a flat record for zipSync. */
function toZipInput(
  fileBytes: Map<string, Uint8Array>,
  manifestBytes: Uint8Array,
): Record<string, Uint8Array> {
  const input: Record<string, Uint8Array> = {
    [PACKAGE_PATHS.manifest]: manifestBytes,
  };
  for (const [path, bytes] of fileBytes) input[path] = bytes;
  return input;
}

export interface BuiltPackage {
  bytes: Uint8Array;
  manifest: InkmarshalManifest;
}

/**
 * Serialize a bundle to the final `.inkmarshal` bytes + the manifest object.
 * Hashes every file before building the manifest, then writes the manifest +
 * all files into a single deflate-level-6 zip.
 */
export async function buildBackupPackage(bundle: BackupBundle): Promise<BuiltPackage> {
  const fileBytes = buildFileBytes(bundle);

  const sha256: Record<string, string> = {};
  for (const [path, bytes] of fileBytes) {
    sha256[path] = await sha256Hex(bytes);
  }

  const manifest: InkmarshalManifest = {
    formatVersion: FORMAT_VERSION,
    appVersion: bundle.meta.appVersion,
    dbSchemaVersion: bundle.meta.dbSchemaVersion,
    exportedAt: bundle.meta.exportedAt,
    novelTitle: bundle.novel.title,
    counts: countsOf(bundle),
    sha256,
    secretsStripped: true,
  };

  const zipped = zipSync(toZipInput(fileBytes, jsonBytes(manifest)), { level: 6 });
  return { bytes: zipped, manifest };
}
