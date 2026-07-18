import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findExactPackageSource,
  copyDereferenced,
  rehydrateDependencyClosure,
  rehydratePackage,
} from './desktop-package-utils.mjs';

const fixtures = [];

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'inkmarshal-package-store-'));
  fixtures.push(root);
  return root;
}

function packageDir(
  root,
  packageName,
  version,
  { hoisted = false, suffix = '', dependencies = {} } = {},
) {
  const segments = packageName.split('/');
  const dir = hoisted
    ? path.join(root, 'node_modules', ...segments)
    : path.join(
        root,
        'node_modules',
        '.pnpm',
        `${packageName.replaceAll('/', '+')}@${version}${suffix}`,
        'node_modules',
        ...segments,
      );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: packageName, version, dependencies })}\n`,
  );
  writeFileSync(path.join(dir, 'marker.txt'), `${packageName}@${version}${suffix}\n`);
  return dir;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('desktop pnpm package hydration', () => {
  it('uses an exact-version hoisted package when it matches', () => {
    const root = fixtureRoot();
    const expected = packageDir(root, '@swc/helpers', '0.5.15', { hoisted: true });

    expect(findExactPackageSource({ projectRoot: root, packageName: '@swc/helpers', version: '0.5.15' }))
      .toBe(expected);
  });

  it('finds the exact package in a no-hoist pnpm store', () => {
    const root = fixtureRoot();
    const expected = packageDir(root, '@swc/helpers', '0.5.15');

    expect(findExactPackageSource({ projectRoot: root, packageName: '@swc/helpers', version: '0.5.15' }))
      .toBe(expected);
  });

  it('selects the recorded version when the pnpm store contains multiple versions', () => {
    const root = fixtureRoot();
    packageDir(root, 'debug', '3.2.7');
    const expected = packageDir(root, 'debug', '4.4.3', { suffix: '_supports-color@9.4.0' });

    expect(findExactPackageSource({ projectRoot: root, packageName: 'debug', version: '4.4.3' }))
      .toBe(expected);
  });

  it('replaces a sparse traced package with the complete exact package', () => {
    const root = fixtureRoot();
    const source = packageDir(root, '@swc/helpers', '0.5.15');
    writeFileSync(path.join(source, 'full-runtime.js'), 'export const complete = true;\n');
    const target = path.join(root, 'copied-runtime', 'node_modules', '@swc', 'helpers');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: '@swc/helpers', version: '0.5.15' }));

    rehydratePackage({ projectRoot: root, packageName: '@swc/helpers', targetPath: target });

    expect(existsSync(path.join(target, 'full-runtime.js'))).toBe(true);
    expect(readFileSync(path.join(target, 'marker.txt'), 'utf8')).toContain('@swc/helpers@0.5.15');
  });

  it('fails the build when the recorded package version is unavailable', () => {
    const root = fixtureRoot();
    packageDir(root, 'debug', '3.2.7');

    expect(() => findExactPackageSource({ projectRoot: root, packageName: 'debug', version: '4.4.3' }))
      .toThrow('debug@4.4.3');
  });

  it('resolves a broken standalone pnpm link through the real project store', () => {
    const root = fixtureRoot();
    const sourceDir = path.join(root, '.next', 'standalone', 'node_modules');
    const source = path.join(sourceDir, 'semver');
    const storeFallback = path.join(root, 'node_modules', '.pnpm', 'node_modules', 'semver');
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(storeFallback, { recursive: true });
    writeFileSync(path.join(storeFallback, 'index.js'), 'module.exports = true;\n');
    symlinkSync(path.join(sourceDir, '.pnpm', 'node_modules', 'semver'), source);
    const target = path.join(root, 'copied-runtime', 'node_modules', 'semver');

    copyDereferenced(source, target, { projectRoot: root });

    expect(existsSync(path.join(target, 'index.js'))).toBe(true);
  });

  it('synthesizes an absent top-level runtime dependency from the exact parent graph', () => {
    const root = fixtureRoot();
    const nextSource = packageDir(root, 'next', '16.2.6', {
      dependencies: { '@swc/helpers': '0.5.15' },
    });
    const helperSource = packageDir(root, '@swc/helpers', '0.5.15', {
      dependencies: { tslib: '2.8.1' },
    });
    const tslibSource = packageDir(root, 'tslib', '2.8.1');
    const dependencyLink = path.join(path.dirname(nextSource), '@swc', 'helpers');
    mkdirSync(path.dirname(dependencyLink), { recursive: true });
    symlinkSync(helperSource, dependencyLink);
    const scopedDependencyLink = path.join(path.dirname(path.dirname(helperSource)), 'tslib');
    symlinkSync(tslibSource, scopedDependencyLink);
    const targetNodeModules = path.join(root, 'copied-runtime', 'node_modules');

    rehydrateDependencyClosure({
      projectRoot: root,
      parentSource: nextSource,
      dependencyNames: ['@swc/helpers'],
      targetNodeModules,
    });

    expect(
      readFileSync(path.join(targetNodeModules, '@swc', 'helpers', 'marker.txt'), 'utf8'),
    ).toContain('@swc/helpers@0.5.15');
    expect(readFileSync(path.join(targetNodeModules, 'tslib', 'marker.txt'), 'utf8'))
      .toContain('tslib@2.8.1');
  });
});
