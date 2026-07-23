import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export const ENGINE_MANIFEST_FILENAME = '.llama-manifest.json';

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function safeManifestPath(root, manifestPath) {
  if (!manifestPath || manifestPath.startsWith('/') || manifestPath.split('/').includes('..')) {
    throw new Error(`Unsafe engine manifest path: ${manifestPath}`);
  }
  const absolute = resolve(root, manifestPath);
  const resolvedRoot = resolve(root);
  if (!absolute.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Engine manifest path escapes root: ${manifestPath}`);
  }
  return absolute;
}

async function collectEntries(root) {
  const entries = [];
  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === ENGINE_MANIFEST_FILENAME || child.name === '.archive-sha256') continue;
      const absolute = join(directory, child.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (child.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (child.isSymbolicLink()) {
        entries.push({ path, type: 'symlink', target: await readlink(absolute) });
        continue;
      }
      if (!child.isFile()) throw new Error(`Unsupported engine archive entry: ${path}`);
      const metadata = await lstat(absolute);
      entries.push({
        path,
        type: 'file',
        sha256: await sha256File(absolute),
        executable: (metadata.mode & 0o111) !== 0,
      });
    }
  }
  await walk(root);
  return entries;
}

export async function writeEngineManifest(root, archiveSha256) {
  const manifest = {
    version: 1,
    archiveSha256,
    entries: await collectEntries(root),
  };
  if (manifest.entries.length === 0) throw new Error('Engine archive extracted no files');
  await writeFile(join(root, ENGINE_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export async function validateEngineManifest(root, expectedArchiveSha256) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(root, ENGINE_MANIFEST_FILENAME), 'utf8'));
  } catch {
    return { ok: false, reason: 'manifest missing or malformed' };
  }
  if (manifest?.version !== 1 || manifest.archiveSha256 !== expectedArchiveSha256 || !Array.isArray(manifest.entries)) {
    return { ok: false, reason: 'manifest metadata mismatch' };
  }
  for (const entry of manifest.entries) {
    let absolute;
    try {
      absolute = safeManifestPath(root, entry.path);
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    try {
      const metadata = await lstat(absolute);
      if (entry.type === 'symlink') {
        if (!metadata.isSymbolicLink() || await readlink(absolute) !== entry.target) {
          return { ok: false, reason: `${entry.path} symlink mismatch` };
        }
        continue;
      }
      if (entry.type !== 'file' || !metadata.isFile()) {
        return { ok: false, reason: `${entry.path} type mismatch` };
      }
      if (await sha256File(absolute) !== entry.sha256) {
        return { ok: false, reason: `${entry.path} digest mismatch` };
      }
      if (((metadata.mode & 0o111) !== 0) !== Boolean(entry.executable)) {
        return { ok: false, reason: `${entry.path} executable mode mismatch` };
      }
    } catch {
      return { ok: false, reason: `${entry.path} missing` };
    }
  }
  return { ok: true, entries: manifest.entries.length };
}
