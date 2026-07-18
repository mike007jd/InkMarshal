import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source() {
  return readFileSync(join(process.cwd(), 'scripts/fetch-engines.mjs'), 'utf8');
}

describe('fetch-engines MLX cache key', () => {
  it('includes Package.resolved so dependency pin changes rebuild mlx-server', () => {
    const script = source();

    expect(script).toContain("join(MLX_PKG_DIR, 'Package.swift')");
    expect(script).toContain("join(MLX_PKG_DIR, 'Package.resolved')");
    expect(script).toContain("join(MLX_PKG_DIR, 'Sources')");
  });

  it('deletes a stale MLX engine before a replacement build can fail', () => {
    const script = source();
    const staleRemoval = script.indexOf("await rm(destBin, { force: true });");
    const buildStart = script.indexOf("console.log('[mlx-server] building via xcodebuild");

    expect(staleRemoval).toBeGreaterThan(0);
    expect(staleRemoval).toBeLessThan(buildStart);
    expect(script.slice(staleRemoval, buildStart)).toContain(
      "await rm(destBundle, { recursive: true, force: true });",
    );
    expect(script.slice(staleRemoval, buildStart)).toContain("await rm(marker, { force: true });");
  });
});
