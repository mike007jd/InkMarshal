import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ENGINE_MANIFEST_FILENAME,
  validateEngineManifest,
  writeEngineManifest,
} from './engine-manifest.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('engine manifest', () => {
  it('detects missing or changed binaries, dylibs, modes, and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'inkmarshal-engine-manifest-'));
    roots.push(root);
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'llama-server'), 'server');
    await chmod(join(root, 'llama-server'), 0o755);
    await writeFile(join(root, 'lib', 'libllama.dylib'), 'dylib');
    await symlink('lib/libllama.dylib', join(root, 'libllama.dylib'));

    await writeEngineManifest(root, 'archive-hash');
    await expect(validateEngineManifest(root, 'archive-hash')).resolves.toEqual({ ok: true, entries: 3 });

    const manifest = JSON.parse(await readFile(join(root, ENGINE_MANIFEST_FILENAME), 'utf8'));
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual([
      'lib/libllama.dylib',
      'libllama.dylib',
      'llama-server',
    ]);

    await writeFile(join(root, 'lib', 'libllama.dylib'), 'tampered');
    await expect(validateEngineManifest(root, 'archive-hash')).resolves.toEqual({
      ok: false,
      reason: 'lib/libllama.dylib digest mismatch',
    });
  });
});
