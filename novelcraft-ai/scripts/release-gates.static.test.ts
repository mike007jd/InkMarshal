import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function scriptSource(name: string): string {
  return readFileSync(join(process.cwd(), 'scripts', name), 'utf8');
}

describe('desktop release gate', () => {
  it('uses the same notarized-DMG Gatekeeper handling as release:mac', () => {
    const source = scriptSource('validate-desktop-release.mjs');

    expect(source).toContain('!\/accepted\/i.test(spctlOutput)');
    expect(source).toContain('Gatekeeper assessment is inconclusive on this host');
    expect(source).toContain("['--verify', '--strict', '--verbose=2', stableDmgPath]");
    expect(source).not.toContain('source=Unnotarized Developer ID|override=security disabled');
  });

  it('uses the canonical InkMarshal repository for macOS downloads', () => {
    const validator = scriptSource('validate-desktop-release.mjs');
    const builder = scriptSource('build-mac-release.mjs');

    expect(validator).toContain('mike007jd/InkMarshal/releases/latest/download');
    expect(builder).toContain('mike007jd/InkMarshal/releases/latest/download');
  });
});

describe('mac release target gate', () => {
  it('keeps runtime exceptions process-scoped and rejects mixed signing teams', () => {
    const source = scriptSource('build-mac-release.mjs');
    const appEntitlements = scriptSource('../src-tauri/entitlements.plist');
    const nodeEntitlements = scriptSource('../src-tauri/node-entitlements.plist');
    const forbidden = [
      'com.apple.security.cs.allow-dyld-environment-variables',
      'com.apple.security.cs.allow-unsigned-executable-memory',
      'com.apple.security.cs.disable-library-validation',
      'com.apple.security.get-task-allow',
    ];

    expect(appEntitlements).not.toContain('<true/>');
    expect(nodeEntitlements).toContain('<key>com.apple.security.cs.allow-jit</key>');
    for (const entitlement of forbidden) {
      expect(appEntitlements).not.toContain(`<key>${entitlement}</key>`);
      expect(nodeEntitlements).not.toContain(`<key>${entitlement}</key>`);
    }
    expect(source).toContain('target === nodeRuntimePath ? NODE_ENTITLEMENTS_PATH : null');
    expect(source).toContain('teamId !== expectedTeamId');
    expect(source).toContain('assertMinimalCodeSigning');
    expect(source).toContain("sensitiveValueFlags = new Set(['--apple-id', '--password'])");
  });

  it('requires darwin/arm64 and builds the fixed aarch64 target', () => {
    const source = scriptSource('build-mac-release.mjs');

    expect(source).toContain("MAC_RELEASE_TARGET = 'aarch64-apple-darwin'");
    expect(source).toContain("process.arch !== 'arm64'");
    expect(source).toContain("'--target', MAC_RELEASE_TARGET");
    expect(source).toContain("runCapture('lipo', ['-archs', executablePath])");
  });

  it('limits deep signing scans to native binary candidates', () => {
    const source = scriptSource('build-mac-release.mjs');

    expect(source).toContain('NATIVE_BINARY_EXTENSIONS');
    expect(source).toContain('looksLikeSignableBinaryCandidate');
    expect(source).toContain("if (!looksLikeSignableBinaryCandidate(full, entry)) continue;");
  });

  it('keeps temporary DMG artifacts on a .dmg suffix for stapler', () => {
    const source = scriptSource('build-mac-release.mjs');

    expect(source).toContain('`${stableDmgPath}.tmp.dmg`');
    expect(source).toContain('`${STABLE_DMG_NAME}.tmp.dmg`');
  });

  it('does not reject a notarized DMG only because host Gatekeeper is disabled', () => {
    const source = scriptSource('build-mac-release.mjs');

    expect(source).toContain('!\/accepted\/i.test(spctlOutput)');
    expect(source).toContain('Gatekeeper assessment is inconclusive on this host');
    expect(source).toContain("['--verify', '--strict', '--verbose=4', dmgPath]");
    expect(source).not.toContain('source=Unnotarized Developer ID|override=security disabled|rejected');
  });

  it('shares a pinned headless dmgbuild path with local desktop packaging', () => {
    const release = scriptSource('build-mac-release.mjs');
    const local = scriptSource('build-mac-desktop.mjs');
    const dmg = scriptSource('mac-dmg.mjs');
    const settings = scriptSource('dmgbuild-settings.py');
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const tauri = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'));

    expect(packageJson.scripts['desktop:build']).toBe('node scripts/build-mac-desktop.mjs');
    expect(tauri.bundle.targets).toEqual(['app']);
    expect(tauri.build.beforeBuildCommand).toContain('pnpm smoke:desktop');
    expect(release).toContain("from './mac-dmg.mjs'");
    expect(local).toContain('createMacDmg');
    expect(dmg).toContain("DMGBUILD_VERSION = '1.6.7'");
    expect(`${release}\n${local}\n${dmg}`).not.toMatch(/osascript|tell application \"Finder\"/i);
    expect(settings).toContain('window_rect = ((200, 120), (660, 400))');
    expect(settings).toContain("'InkMarshal.app': (180, 170)");
    expect(settings).toContain("'Applications': (480, 170)");
    expect(settings).not.toContain('hide_extensions');
    expect(release).toContain('assertMountedDmgAppSignature');
  });
});
