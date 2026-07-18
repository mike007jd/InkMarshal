import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const capabilityPaths = [
  'src-tauri/capabilities/default.json',
  'src-tauri/dev-remote-capability.json',
];

describe('desktop window capabilities', () => {
  it.each(capabilityPaths)('%s can reveal the locale-hydrated main window', (path) => {
    const capability = JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as {
      permissions?: string[];
    };

    expect(capability.permissions).toContain('core:window:allow-show');
  });
});
