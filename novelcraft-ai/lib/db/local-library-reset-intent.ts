import 'server-only';

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { LOCAL_DB_FILE } from '@/lib/db-local-path';

const INTENT_PREFIX = '.library-reset-intent-';
const INTENT_VERSION = 1;
const MAX_INTENT_BYTES = 64 * 1024;
const activeResetIntents = new Set<string>();

/** @internal Simulates a process restart for crash-cut tests. */
export const __libraryResetIntentTest = {
  forgetActiveIntent(intentPath: string): void {
    activeResetIntents.delete(intentPath);
  },
};

export interface LibraryArtifactQuarantine {
  source: string;
  quarantine: string;
  sourceName: string;
  quarantineName: string;
}

interface LibraryResetIntent {
  version: 1;
  phase: 'prepared' | 'committed';
  artifacts: Array<{ sourceName: string; quarantineName: string }>;
}

export function isLocalLibraryArtifact(fileName: string): boolean {
  if (
    fileName === LOCAL_DB_FILE
    || fileName === `${LOCAL_DB_FILE}-wal`
    || fileName === `${LOCAL_DB_FILE}-shm`
    || fileName === `${LOCAL_DB_FILE}-journal`
  ) return true;

  return fileName.startsWith(`${LOCAL_DB_FILE}.pre-migration-v`)
    && (fileName.endsWith('.bak') || fileName.endsWith('.bak.tmp'));
}

function isSingleName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function writeDurableFile(filePath: string, contents: string, exclusive: boolean): void {
  const fd = openSync(filePath, exclusive ? 'wx' : 'w', 0o600);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeIntent(filePath: string, intent: LibraryResetIntent, exclusive: boolean): void {
  const contents = `${JSON.stringify(intent)}\n`;
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  try {
    writeDurableFile(tempPath, contents, true);
    if (exclusive && existsSync(filePath)) {
      throw new Error('Local library reset intent already exists.');
    }
    renameSync(tempPath, filePath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function createLibraryResetIntent(
  dbDir: string,
  artifacts: readonly LibraryArtifactQuarantine[],
): string {
  const intentPath = path.join(dbDir, `${INTENT_PREFIX}${crypto.randomUUID()}.json`);
  writeIntent(intentPath, {
    version: INTENT_VERSION,
    phase: 'prepared',
    artifacts: artifacts.map(({ sourceName, quarantineName }) => ({
      sourceName,
      quarantineName,
    })),
  }, true);
  activeResetIntents.add(intentPath);
  return intentPath;
}

export function markLibraryResetIntentCommitted(intentPath: string): void {
  const intent = readIntent(intentPath);
  if (!intent) throw new Error('Could not read the local library reset intent.');
  writeIntent(intentPath, { ...intent, phase: 'committed' }, false);
}

export function removeLibraryResetIntent(intentPath: string | null): void {
  if (!intentPath) return;
  activeResetIntents.delete(intentPath);
  rmSync(intentPath, { force: true });
}

function readIntent(intentPath: string): LibraryResetIntent | null {
  try {
    const stat = lstatSync(intentPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INTENT_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(intentPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<LibraryResetIntent>;
    if (
      value.version !== INTENT_VERSION
      || (value.phase !== 'prepared' && value.phase !== 'committed')
      || !Array.isArray(value.artifacts)
    ) return null;
    const artifacts = value.artifacts.filter((item): item is {
      sourceName: string;
      quarantineName: string;
    } => Boolean(
      item
      && isSingleName(item.sourceName)
      && isLocalLibraryArtifact(item.sourceName)
      && isSingleName(item.quarantineName)
      && item.quarantineName.startsWith('.library-reset-'),
    ));
    if (artifacts.length !== value.artifacts.length) return null;
    return { version: 1, phase: value.phase, artifacts };
  } catch {
    return null;
  }
}

/**
 * Completes or rolls back a reset that was interrupted between atomic renames.
 * Prepared resets preserve the old library; committed resets preserve the new one.
 */
export function reconcileInterruptedLocalLibraryResets(dbDir: string): void {
  if (!existsSync(dbDir)) return;
  for (const entry of readdirSync(dbDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(INTENT_PREFIX) || !entry.name.endsWith('.json')) {
      continue;
    }
    const intentPath = path.join(dbDir, entry.name);
    if (activeResetIntents.has(intentPath)) continue;
    const intent = readIntent(intentPath);
    if (!intent) {
      throw new Error('InkMarshal found an invalid interrupted library reset intent.');
    }
    if (intent.phase === 'prepared') {
      try {
        for (const artifact of intent.artifacts) {
          const source = path.join(dbDir, artifact.sourceName);
          const quarantine = path.join(dbDir, artifact.quarantineName);
          if (!existsSync(source) && !existsSync(quarantine)) {
            throw new Error(`Missing both live and quarantined ${artifact.sourceName}.`);
          }
        }
        const unmovedOriginals = new Set(
          intent.artifacts
            .filter(artifact => !existsSync(path.join(dbDir, artifact.quarantineName)))
            .map(artifact => artifact.sourceName),
        );
        for (const live of readdirSync(dbDir, { withFileTypes: true })) {
          if (
            (live.isFile() || live.isSymbolicLink())
            && isLocalLibraryArtifact(live.name)
            && !unmovedOriginals.has(live.name)
          ) {
            rmSync(path.join(dbDir, live.name), { recursive: true, force: true });
          }
        }
        for (const artifact of intent.artifacts) {
          const source = path.join(dbDir, artifact.sourceName);
          const quarantine = path.join(dbDir, artifact.quarantineName);
          // No quarantine means this artifact was never moved before the crash;
          // the live source is therefore still the original and must be kept.
          if (!existsSync(quarantine)) continue;
          renameSync(quarantine, source);
        }
        removeLibraryResetIntent(intentPath);
      } catch (error) {
        throw new Error('InkMarshal could not restore an interrupted local library reset.', {
          cause: error,
        });
      }
      continue;
    }
    try {
      for (const artifact of intent.artifacts) {
        rmSync(path.join(dbDir, artifact.quarantineName), { recursive: true, force: true });
      }
      removeLibraryResetIntent(intentPath);
    } catch (error) {
      console.warn('[library-reset] interrupted reset reconciliation will retry', error);
    }
  }
}
