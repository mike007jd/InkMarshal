import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readJson(path: string) {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
}

describe('fresh-clone desktop development', () => {
  it('tracks the bundled-engine resource directory required by Tauri', () => {
    expect(existsSync(join(root, 'src-tauri/resources/engines/.gitkeep'))).toBe(true);
  });

  it('prepares cached bundled engines before Tauri starts its dev-server timeout', () => {
    const packageJson = readJson('package.json') as { scripts: Record<string, string> };
    const tauriConfig = readJson('src-tauri/tauri.conf.json') as {
      build: { beforeDevCommand: string };
    };

    expect(packageJson.scripts['prepare:desktop-dev']).toBe('pnpm fetch-engines');
    expect(packageJson.scripts['desktop:dev']).toBe('pnpm prepare:desktop-dev && tauri dev');
    expect(tauriConfig.build.beforeDevCommand).toBe('pnpm dev:desktop-web');
  });
});
