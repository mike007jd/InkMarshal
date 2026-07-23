import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = process.cwd();
const repoRoot = join(appRoot, '..');

describe('third-party notices distribution contract', () => {
  it('tracks the generated notices and bundles both root compliance files', () => {
    const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
    const tauri = JSON.parse(
      readFileSync(join(appRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    );

    expect(existsSync(join(repoRoot, 'NOTICE'))).toBe(true);
    expect(existsSync(join(repoRoot, 'THIRD_PARTY_NOTICES.md'))).toBe(true);
    expect(packageJson.scripts['verify:third-party-notices']).toBe(
      'node scripts/generate-third-party-notices.mjs --check',
    );
    expect(packageJson.scripts['verify:release-desktop']).toContain(
      'pnpm verify:third-party-notices',
    );
    expect(tauri.bundle.resources['../../NOTICE']).toBe('NOTICE');
    expect(tauri.bundle.resources['../../THIRD_PARTY_NOTICES.md']).toBe(
      'THIRD_PARTY_NOTICES.md',
    );
  });

  it('collects production npm and target-filtered normal Cargo dependencies', () => {
    const generator = readFileSync(
      join(appRoot, 'scripts', 'generate-third-party-notices.mjs'),
      'utf8',
    );

    expect(generator).toContain("['licenses', 'list', '--prod', '--json']");
    expect(generator).toContain("'--filter-platform', 'aarch64-apple-darwin'");
    expect(generator).toContain('kind.kind === null');
  });
});
