import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyDereferenced,
  readPackageIdentity,
  rehydrateDependencyClosure,
  rehydratePackage,
} from './desktop-package-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DESKTOP_BUILD_ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'PROGRAMFILES',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'PNPM_HOME',
  'COREPACK_HOME',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_userconfig',
  'CI',
  'INKMARSHAL_SKIP_NODE_BUNDLE',
];

export function desktopBuildEnv(source = process.env) {
  const env = {};
  for (const key of DESKTOP_BUILD_ENV_PASSTHROUGH) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    NEXT_TELEMETRY_DISABLED: '1',
    TAURI_DESKTOP_BUILD: '1',
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: desktopBuildEnv(),
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Like run(), but throws on failure instead of process.exit-ing, so callers
// can attach contextual error messages (e.g. "Node runtime extraction failed").
function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: desktopBuildEnv(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`\`${command}\` exited with status ${result.status ?? 'unknown'}`);
  }
}

/** Sha256 of a file on disk → lowercase hex. */
function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * Download nodejs.org SHASUMS256.txt and return the expected sha256 for the
 * exact archive filename. Lines are `<sha256>  <filename>` (two spaces), and
 * some mirrors prefix a `*` on the binary-mode filename — both are handled.
 */
async function fetchNodeShasum(shasumsUrl, archiveFile) {
  const response = await fetch(shasumsUrl);
  if (!response.ok) {
    throw new Error(`Cannot download Node SHASUMS256 ${shasumsUrl}: ${response.status}`);
  }
  const text = await response.text();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match && match[2] === archiveFile) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(
    `No sha256 entry for ${archiveFile} in ${shasumsUrl}; cannot verify the Node runtime download.`,
  );
}

function nodeRuntimeTarget() {
  const archByPlatform = {
    'darwin:arm64': 'darwin-arm64',
    'darwin:x64': 'darwin-x64',
    'linux:x64': 'linux-x64',
    'win32:x64': 'win-x64',
    'win32:arm64': 'win-arm64',
  };
  return archByPlatform[`${process.platform}:${process.arch}`] ?? null;
}

async function bundleNodeRuntime() {
  if (process.env.INKMARSHAL_SKIP_NODE_BUNDLE === '1') {
    return;
  }

  const target = nodeRuntimeTarget();
  if (!target) {
    throw new Error(`No bundled Node target for ${process.platform}/${process.arch}.`);
  }

  const version = process.versions.node;
  const distName = `node-v${version}-${target}`;
  const archiveExt = process.platform === 'win32' ? 'zip' : 'tar.xz';
  const archiveFile = `${distName}.${archiveExt}`;
  const distBaseUrl = `https://nodejs.org/dist/v${version}`;
  const archiveUrl = `${distBaseUrl}/${archiveFile}`;
  const shasumsUrl = `${distBaseUrl}/SHASUMS256.txt`;
  const cacheDir = path.join(root, '.next', 'tauri-node');
  const archivePath = path.join(cacheDir, archiveFile);
  const extractDir = path.join(cacheDir, distName);
  const nodeResourceDir = path.join(root, 'src-tauri', 'resources', 'node');
  const nodeFileName = process.platform === 'win32' ? 'node.exe' : 'node';
  const resourceBinary = path.join(nodeResourceDir, nodeFileName);

  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(nodeResourceDir, { recursive: true });

  // Fetch the official SHASUMS256.txt alongside the tarball and parse out the
  // expected sha256 for our exact archive filename. This is the publisher's
  // integrity manifest — we never extract an archive whose digest we have not
  // verified against it. (No GPG signature check yet; this is integrity-in-
  // transit, not full provenance.)
  const expectedSha256 = await fetchNodeShasum(shasumsUrl, archiveFile);

  // Validate any cached archive's digest before trusting it — never reuse on
  // mere existence (a corrupted / partial / tampered cache must be rejected).
  if (existsSync(archivePath)) {
    const cachedSha = sha256File(archivePath);
    if (cachedSha !== expectedSha256) {
      console.warn(
        `Cached Node runtime ${archiveFile} sha256 mismatch (expected ${expectedSha256}, got ${cachedSha}); re-downloading.`,
      );
      rmSync(archivePath, { force: true });
    }
  }

  if (!existsSync(archivePath)) {
    const response = await fetch(archiveUrl);
    if (!response.ok) {
      throw new Error(`Cannot download Node runtime ${archiveUrl}: ${response.status}`);
    }
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    const downloadedSha = sha256File(archivePath);
    if (downloadedSha !== expectedSha256) {
      rmSync(archivePath, { force: true });
      throw new Error(
        `Node runtime ${archiveFile} sha256 verification FAILED:\n  expected: ${expectedSha256}\n  got:      ${downloadedSha}\nRefusing to extract a runtime that does not match nodejs.org SHASUMS256.txt.`,
      );
    }
  }

  rmSync(extractDir, { recursive: true, force: true });
  try {
    if (process.platform === 'win32') {
      runOrThrow(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${cacheDir.replaceAll("'", "''")}' -Force`,
        ],
        { cwd: root },
      );
    } else {
      runOrThrow('tar', ['-xJf', archivePath, '-C', cacheDir], { cwd: root });
    }
  } catch (err) {
    throw new Error(
      `Node runtime extraction failed for ${archiveFile}: ${err instanceof Error ? err.message : err}`,
    );
  }

  const sourceBinary =
    process.platform === 'win32'
      ? path.join(extractDir, 'node.exe')
      : path.join(extractDir, 'bin', 'node');

  for (const entry of readdirSync(nodeResourceDir)) {
    if (entry === '.gitignore' || entry === '.gitkeep') continue;
    rmSync(path.join(nodeResourceDir, entry), { recursive: true, force: true });
  }
  copyFileSync(sourceBinary, resourceBinary);
  if (process.platform !== 'win32') {
    chmodSync(resourceBinary, 0o755);
  }
}

function topLevelPackageTargets(nodeModulesDir) {
  if (!existsSync(nodeModulesDir)) {
    throw new Error(`Traced desktop node_modules directory is missing: ${nodeModulesDir}`);
  }
  const targets = [];
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.pnpm') continue;
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
        if (!scopedEntry.isDirectory()) continue;
        const target = path.join(entryPath, scopedEntry.name);
        if (existsSync(path.join(target, 'package.json'))) targets.push(target);
      }
      continue;
    }
    if (existsSync(path.join(entryPath, 'package.json'))) targets.push(entryPath);
  }
  return targets;
}

await bundleNodeRuntime();
run('pnpm', ['build']);

const standaloneDir = path.join(root, '.next', 'standalone');
if (!existsSync(standaloneDir)) {
  throw new Error('Next standalone output was not generated.');
}

const standaloneServerDir = path.join(standaloneDir, path.basename(root));

const staticSource = path.join(root, '.next', 'static');
const staticTarget = path.join(standaloneDir, '.next', 'static');
rmSync(staticTarget, { recursive: true, force: true });
cpSync(staticSource, staticTarget, { recursive: true });
const serverStaticTarget = path.join(standaloneServerDir, '.next', 'static');
rmSync(serverStaticTarget, { recursive: true, force: true });
cpSync(staticSource, serverStaticTarget, { recursive: true });

const publicSource = path.join(root, 'public');
const publicTarget = path.join(standaloneDir, 'public');
if (existsSync(publicSource)) {
  rmSync(publicTarget, { recursive: true, force: true });
  cpSync(publicSource, publicTarget, { recursive: true });
  const serverPublicTarget = path.join(standaloneServerDir, 'public');
  rmSync(serverPublicTarget, { recursive: true, force: true });
  cpSync(publicSource, serverPublicTarget, { recursive: true });
}

const tauriServerDir = path.join(root, 'src-tauri', 'resources', 'next-server');
mkdirSync(tauriServerDir, { recursive: true });
for (const entry of readdirSync(tauriServerDir)) {
  if (entry === '.gitignore' || entry === '.gitkeep') continue;
  rmSync(path.join(tauriServerDir, entry), { recursive: true, force: true });
}
copyDereferenced(standaloneDir, tauriServerDir, { projectRoot: root });

const serverNodeModules = path.join(tauriServerDir, 'novelcraft-ai', 'node_modules');
const hydratedServerPackages = new Set();
for (const target of topLevelPackageTargets(serverNodeModules)) {
  const identity = readPackageIdentity(target);
  const key = `${identity.name}@${identity.version}`;
  if (hydratedServerPackages.has(key)) continue;
  const source = rehydratePackage({
    projectRoot: root,
    packageName: identity.name,
    targetPath: target,
  });
  hydratedServerPackages.add(key);
  rehydrateDependencyClosure({
    projectRoot: root,
    parentSource: source,
    dependencyNames: Object.keys(identity.manifest.dependencies ?? {}),
    targetNodeModules: serverNodeModules,
    seen: hydratedServerPackages,
  });
}

const nextNodeModules = path.join(tauriServerDir, 'novelcraft-ai', '.next', 'node_modules');
// Turbopack relocates serverExternal packages to hashed shadow directories.
// Rehydrate each shadow from its exact traced version, then co-locate the native
// runtime dependency closure that Node resolves beside the shadow package.
for (const target of topLevelPackageTargets(nextNodeModules)) {
  const identity = readPackageIdentity(target);
  const source = rehydratePackage({
    projectRoot: root,
    packageName: identity.name,
    targetPath: target,
  });
  if (identity.name === 'better-sqlite3') {
    rehydrateDependencyClosure({
      projectRoot: root,
      parentSource: source,
      dependencyNames: ['bindings'],
      targetNodeModules: nextNodeModules,
    });
  }
}
