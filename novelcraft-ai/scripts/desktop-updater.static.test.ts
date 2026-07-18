import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('signed desktop updater contract', () => {
  it('pins current updater/process leaves and registers only required permissions', () => {
    const pkg = JSON.parse(source('package.json'));
    const cargo = source('src-tauri/Cargo.toml');
    const rust = source('src-tauri/src/lib.rs');
    const capability = JSON.parse(source('src-tauri/capabilities/default.json'));
    expect(pkg.dependencies['@tauri-apps/plugin-updater']).toBe('2.10.1');
    expect(pkg.dependencies['@tauri-apps/plugin-process']).toBe('2.3.1');
    expect(cargo).toContain('tauri-plugin-updater = "2.10.1"');
    expect(cargo).toContain('tauri-plugin-process = "2.3.1"');
    expect(cargo).toContain('minisign-verify = "0.2.5"');
    expect(cargo).toContain('default-run = "inkmarshal-desktop"');
    expect(rust).toContain('tauri_plugin_updater::Builder::new().build()');
    expect(rust).toContain('tauri_plugin_process::init()');
    expect(capability.permissions).toContain('updater:default');
    expect(capability.permissions).toContain('process:allow-restart');
    expect(capability.permissions).not.toContain('process:default');
  });

  it('uses one signed static manifest endpoint and null-based update checks', () => {
    const config = JSON.parse(source('src-tauri/tauri.conf.json'));
    const coordinator = source('components/DesktopUpdateCoordinator.tsx');
    expect(config.plugins.updater.pubkey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(config.plugins.updater.endpoints).toEqual([
      'https://github.com/mike007jd/InkMarshal/releases/latest/download/latest.json',
    ]);
    expect(coordinator).toContain('result === null');
    expect(coordinator).not.toContain('.available');
    expect(coordinator).toContain('requestSaveNow({ createRecoveryPoint: true })');
    expect(coordinator).toContain('await relaunch()');
  });

  it('gates only the startup check behind a default-on durable setting and keeps manual checks', () => {
    const coordinator = source('components/DesktopUpdateCoordinator.tsx');
    const settings = source('components/SettingsPanel.tsx');
    const keys = source('lib/app-settings-keys.ts');
    const preferences = source('lib/desktop-update-preferences.ts');

    expect(keys).toContain('inkmarshal_auto_update_check_v1');
    expect(preferences).toContain("!== '0'");
    expect(coordinator).toContain('isAutomaticUpdateCheckEnabled()');
    expect(coordinator).toContain('DESKTOP_UPDATE_MANUAL_CHECK_EVENT');
    expect(settings).toContain('automaticUpdateCheckTitle');
    expect(settings).toContain('requestManualDesktopUpdateCheck()');
  });

  it('archives only the final signed/stapled app and publishes a matching manifest', () => {
    const build = source('scripts/build-mac-release.mjs');
    const validator = source('scripts/validate-desktop-release.mjs');
    const cargo = source('src-tauri/Cargo.toml');
    const stapleIndex = build.indexOf('stapleArtifact(appPath);');
    const archiveIndex = build.lastIndexOf('createSignedUpdaterAssets(appPath');
    expect(stapleIndex).toBeGreaterThan(-1);
    expect(archiveIndex).toBeGreaterThan(stapleIndex);
    expect(build).toContain("'darwin-aarch64'");
    expect(build).toContain('mkdirSync(dirname(archivePath), { recursive: true })');
    expect(build).toContain("signerArgs.push('--password', updaterPassword)");
    expect(build).toContain("executableName !== 'inkmarshal-desktop'");
    expect(build).toContain('bundledExecutables.length !== 1');
    expect(build).toContain("critical: readEnv('INKMARSHAL_UPDATE_CRITICAL') === '1'");
    expect(validator).toContain('platform?.signature !== signature');
    expect(validator).toContain("--example', 'verify-updater-signature'");
    expect(source('src-tauri/examples/verify-updater-signature.rs')).toContain('minisign_verify');
    expect(cargo).not.toContain('[[bin]]');
    expect(validator).toContain('validatePublishedUpdater()');
    expect(validator).toContain('Exact final DMG is missing');
    expect(validator).not.toContain("find((name) => name.endsWith('.dmg'))");
  });
});
