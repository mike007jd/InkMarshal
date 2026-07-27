import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

interface MinimatchThree {
  (path: string, pattern: string): boolean;
  braceExpand(pattern: string): string[];
}

const projectRequire = createRequire(import.meta.url);
const eslintRequire = createRequire(projectRequire.resolve('eslint/package.json'));
const minimatch = eslintRequire('minimatch') as MinimatchThree;
const minimatchRequire = createRequire(eslintRequire.resolve('minimatch/package.json'));

describe('ESLint minimatch security bridge', () => {
  it('resolves the patched brace-expansion release from ESLint minimatch', () => {
    const manifest = minimatchRequire('brace-expansion/package.json') as { version: string };

    expect(manifest.version).toBe('5.0.8');
  });

  it.each([
    ['a{b,c{d,e},{f,g}h}x{y,z}', [
      'abxy',
      'abxz',
      'acdxy',
      'acdxz',
      'acexy',
      'acexz',
      'afhxy',
      'afhxz',
      'aghxy',
      'aghxz',
    ]],
    ['a{1..5}b', ['a1b', 'a2b', 'a3b', 'a4b', 'a5b']],
    ['a{b}c', ['a{b}c']],
    ['a{00..05}b', ['a00b', 'a01b', 'a02b', 'a03b', 'a04b', 'a05b']],
    ['z{a,b},c}d', ['za,c}d', 'zb,c}d']],
    ['z{a,b{,c}d', ['z{a,bd', 'z{a,bcd']],
    ['a{b{c{d,e}f}g}h', ['a{b{cdf}g}h', 'a{b{cef}g}h']],
    ['a{b{c{d,e}f{x,y}}g}h', [
      'a{b{cdfx}g}h',
      'a{b{cdfy}g}h',
      'a{b{cefx}g}h',
      'a{b{cefy}g}h',
    ]],
  ])('preserves minimatch 3 brace expansion for %s', (pattern, expected) => {
    expect(minimatch.braceExpand(pattern as string)).toEqual(expected);
  });

  it('keeps ESLint-style TypeScript globs functional', () => {
    expect(minimatch('lib/writing/run.ts', '**/*.{ts,tsx}')).toBe(true);
    expect(minimatch('lib/writing/run.js', '**/*.{ts,tsx}')).toBe(false);
  });
});
