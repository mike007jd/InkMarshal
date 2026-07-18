import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';

export function readPackageIdentity(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Traced runtime package is missing package.json: ${packageDir}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read runtime package manifest ${manifestPath}: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`Runtime package manifest must contain name and version: ${manifestPath}`);
  }
  return { name: manifest.name, version: manifest.version, manifest };
}

export function copyDereferenced(source, target, options = {}) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    let resolved;
    try {
      resolved = realpathSync(source);
    } catch (error) {
      const linkedPath = path.resolve(path.dirname(source), readlinkSync(source));
      const marker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
      const markerIndex = linkedPath.indexOf(marker);
      if (!options.projectRoot || markerIndex === -1) {
        throw new Error(
          `Broken traced runtime symlink ${source} -> ${linkedPath}: ${error instanceof Error ? error.message : error}`,
        );
      }
      const pnpmRelativePath = linkedPath.slice(markerIndex + marker.length);
      const storeFallback = path.join(
        options.projectRoot,
        'node_modules',
        '.pnpm',
        pnpmRelativePath,
      );
      if (!existsSync(storeFallback)) {
        throw new Error(
          `Broken traced runtime symlink ${source}; pnpm store fallback is missing: ${storeFallback}`,
        );
      }
      resolved = storeFallback;
    }
    copyDereferenced(resolved, target, options);
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyDereferenced(path.join(source, entry), path.join(target, entry), options);
    }
    return;
  }
  if (stat.isFile()) {
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

export function findExactPackageSource({ projectRoot, packageName, version }) {
  if (!packageName || !version) {
    throw new Error('An exact package name and version are required for desktop runtime hydration.');
  }

  const segments = packageName.split('/');
  const direct = path.join(projectRoot, 'node_modules', ...segments);
  if (existsSync(direct)) {
    const identity = readPackageIdentity(direct);
    if (identity.name === packageName && identity.version === version) return direct;
  }

  const pnpmDir = path.join(projectRoot, 'node_modules', '.pnpm');
  const encoded = packageName.replaceAll('/', '+');
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${encoded}@`)) continue;
      const candidate = path.join(pnpmDir, entry.name, 'node_modules', ...segments);
      if (!existsSync(candidate)) continue;
      const identity = readPackageIdentity(candidate);
      if (identity.name === packageName && identity.version === version) return candidate;
    }
  }

  throw new Error(
    `Cannot hydrate desktop runtime package ${packageName}@${version}: exact package is absent from node_modules/.pnpm.`,
  );
}

export function rehydratePackage({ projectRoot, packageName, targetPath, expectedVersion }) {
  const traced = expectedVersion
    ? { name: packageName, version: expectedVersion }
    : readPackageIdentity(targetPath);
  if (traced.name !== packageName) {
    throw new Error(
      `Traced runtime package mismatch at ${targetPath}: expected ${packageName}, found ${traced.name}.`,
    );
  }

  const source = findExactPackageSource({ projectRoot, packageName, version: traced.version });
  const canonicalSource = realpathSync(source);
  rmSync(targetPath, { recursive: true, force: true });
  copyDereferenced(canonicalSource, targetPath, { projectRoot });

  const copied = readPackageIdentity(targetPath);
  if (copied.name !== packageName || copied.version !== traced.version) {
    throw new Error(
      `Hydrated runtime package mismatch: expected ${packageName}@${traced.version}, found ${copied.name}@${copied.version}.`,
    );
  }
  return canonicalSource;
}

export function rehydrateDependencyClosure({
  projectRoot,
  parentSource,
  dependencyNames,
  targetNodeModules,
  seen = new Set(),
}) {
  const parentIdentity = readPackageIdentity(parentSource);
  const dependencyRoot = parentIdentity.name.startsWith('@')
    ? path.dirname(path.dirname(parentSource))
    : path.dirname(parentSource);
  for (const packageName of dependencyNames) {
    const linkedSource = path.join(dependencyRoot, ...packageName.split('/'));
    const identity = readPackageIdentity(linkedSource);
    const key = `${identity.name}@${identity.version}`;
    if (seen.has(key)) continue;

    const targetPath = path.join(targetNodeModules, ...packageName.split('/'));
    const source = rehydratePackage({
      projectRoot,
      packageName,
      targetPath,
      expectedVersion: identity.version,
    });
    seen.add(key);
    rehydrateDependencyClosure({
      projectRoot,
      parentSource: source,
      dependencyNames: Object.keys(identity.manifest.dependencies ?? {}),
      targetNodeModules,
      seen,
    });
  }
  return seen;
}
