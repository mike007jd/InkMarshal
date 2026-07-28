import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeRuntimeCacheDir } from './build-tauri-web.mjs';

const fixtures: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'inkmarshal-tauri-node-cache-'));
  fixtures.push(root);
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bundled Node runtime cache lifecycle', () => {
  it('places the cache outside the volatile .next tree', () => {
    const projectRoot = fixtureRoot();
    const cacheDir = nodeRuntimeCacheDir(projectRoot);
    const nextRoot = path.join(projectRoot, '.next');

    expect(cacheDir.startsWith(`${nextRoot}${path.sep}`)).toBe(false);
    expect(path.relative(projectRoot, cacheDir).split(path.sep)).toEqual([
      'node_modules',
      '.cache',
      'inkmarshal-tauri-node',
    ]);
  });

  it('keeps a verified archive writable after .next is wiped (clean/Next volatile tree)', () => {
    const projectRoot = fixtureRoot();
    const nextRoot = path.join(projectRoot, '.next');
    const volatileCache = path.join(nextRoot, 'tauri-node');
    const durableCache = nodeRuntimeCacheDir(projectRoot);
    const archiveName = 'node-v24.18.0-darwin-arm64.tar.xz';

    mkdirSync(volatileCache, { recursive: true });
    mkdirSync(durableCache, { recursive: true });
    writeFileSync(path.join(volatileCache, archiveName), 'volatile-seed');
    writeFileSync(path.join(durableCache, archiveName), 'durable-seed');

    // clean:desktop-build / Next may dispose `.next` after the cache dir exists.
    rmSync(nextRoot, { recursive: true, force: true });

    expect(existsSync(path.join(volatileCache, archiveName))).toBe(false);

    const durableArchive = path.join(durableCache, archiveName);
    expect(existsSync(durableArchive)).toBe(true);
    // Durable cache writes must succeed without recreating `.next`.
    writeFileSync(durableArchive, 'post-clean-write');
    expect(readFileSync(durableArchive, 'utf8')).toBe('post-clean-write');
    expect(existsSync(nextRoot)).toBe(false);
  });
});
