import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(): string {
  return readFileSync(join(process.cwd(), 'scripts/build-tauri-web.mjs'), 'utf8');
}

describe('desktop web build environment', () => {
  it('uses an allowlisted environment instead of inheriting provider secrets', () => {
    const script = source();

    expect(script).toContain('DESKTOP_BUILD_ENV_PASSTHROUGH');
    expect(script).toContain('env: desktopBuildEnv()');
    expect(script).not.toContain('...process.env');
    expect(script).not.toContain('OPENAI_API_KEY');
    expect(script).not.toContain('ANTHROPIC_API_KEY');
    expect(script).not.toContain('INKMARSHAL_DATA_DIR');
  });

  it('rehydrates traced packages by their recorded exact version and never skips a missing package', () => {
    const script = source();

    expect(script).toContain('rehydratePackage');
    expect(script).not.toContain('if (!source) continue');
  });

  it('bundles the official Linux x64 Node runtime on the Deck runner', () => {
    const script = source();

    expect(script).toContain("'linux:x64': 'linux-x64'");
  });
});
