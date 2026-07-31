import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertUpdaterArchiveClean,
  inspectUpdaterArchiveMembers,
  listUpdaterArchiveMembers,
} from './verify-updater-archive.mjs';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

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
    expect(coordinator).toContain('installDesktopUpdate({');
    expect(coordinator).toContain('session: installSessionRef.current');
    expect(coordinator).toContain('previous.close()');
    expect(coordinator).toContain('error ? t.updateRetry : t.updateInstall');
    expect(coordinator).toContain('categorizeDesktopUpdateFailure');
    expect(coordinator).toContain('VERIFIED_MAC_DMG_DOWNLOAD_URL');
    expect(coordinator).toContain('openExternal(VERIFIED_MAC_DMG_DOWNLOAD_URL)');
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
    expect(build).toContain("COPYFILE_DISABLE: '1'");
    expect(build).toContain('assertUpdaterArchiveClean(archivePath)');
    expect(validator).toContain('platform?.signature !== signature');
    expect(validator).toContain("--example', 'verify-updater-signature'");
    expect(validator).toContain('assertUpdaterArchiveClean(archivePath)');
    expect(source('src-tauri/examples/verify-updater-signature.rs')).toContain('minisign_verify');
    expect(cargo).not.toContain('[[bin]]');
    expect(validator).toContain('validatePublishedUpdater()');
    expect(validator).toContain('Exact final DMG is missing');
    expect(validator).not.toContain("find((name) => name.endsWith('.dmg'))");
  });
});

describe('streaming updater archive gate', () => {
  it('accepts a clean InkMarshal.app shape and rejects AppleDouble roots', async () => {
    const cleanMembers = [
      'InkMarshal.app',
      'InkMarshal.app/Contents/Info.plist',
      'InkMarshal.app/Contents/MacOS/inkmarshal-desktop',
      'InkMarshal.app/Contents/_CodeSignature/CodeResources',
    ];
    expect(inspectUpdaterArchiveMembers(cleanMembers)).toEqual([]);

    // Root AppleDouble used by the production v0.1.1→v0.1.2 unpack failure.
    expect(
      inspectUpdaterArchiveMembers(['._InkMarshal.app', ...cleanMembers]).some((failure) =>
        failure.includes('AppleDouble'),
      ),
    ).toBe(true);
    expect(
      inspectUpdaterArchiveMembers([...cleanMembers, 'InkMarshal.app/._Contents']).some((failure) =>
        failure.includes('AppleDouble'),
      ),
    ).toBe(true);
    expect(
      inspectUpdaterArchiveMembers([...cleanMembers, 'InkMarshal.app/Contents/.DS_Store']).some(
        (failure) => failure.includes('.DS_Store'),
      ),
    ).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'inkmarshal-updater-archive-'));
    tempRoots.push(root);
    const cleanArchive = join(root, 'clean.app.tar.gz');
    const badArchive = join(root, 'bad.app.tar.gz');
    const paxBadArchive = join(root, 'pax-bad.app.tar.gz');
    const paxSizeOverrideArchive = join(root, 'pax-size-override.app.tar.gz');
    const mixedPathArchive = join(root, 'mixed-path.app.tar.gz');
    writeFileSync(cleanArchive, buildFixtureArchive(cleanMembers));
    writeFileSync(badArchive, buildFixtureArchive(['._InkMarshal.app', ...cleanMembers]));
    writeFileSync(paxBadArchive, buildPaxPathArchive('._InkMarshal.app', cleanMembers));
    writeFileSync(paxSizeOverrideArchive, buildPaxSizeOverrideArchive(cleanMembers));
    writeFileSync(mixedPathArchive, buildMixedPathOverrideArchive(cleanMembers));

    await expect(assertUpdaterArchiveClean(cleanArchive)).resolves.toBeUndefined();
    const listed = await listUpdaterArchiveMembers(cleanArchive);
    expect(listed.members).toEqual(expect.arrayContaining(cleanMembers));

    await expect(assertUpdaterArchiveClean(badArchive)).rejects.toThrow(/AppleDouble|\._InkMarshal\.app/);
    const badListed = await listUpdaterArchiveMembers(badArchive);
    expect(badListed.members).toContain('._InkMarshal.app');

    await expect(assertUpdaterArchiveClean(paxBadArchive)).rejects.toThrow(/AppleDouble/);
    const paxBadListed = await listUpdaterArchiveMembers(paxBadArchive);
    expect(paxBadListed.members).toContain('._InkMarshal.app');
    await expect(assertUpdaterArchiveClean(paxSizeOverrideArchive)).rejects.toThrow(
      /forbidden PAX size override/,
    );
    await expect(assertUpdaterArchiveClean(mixedPathArchive)).rejects.toThrow(
      /mixes GNU and PAX path overrides/,
    );
  });
});

function isFileMember(name: string): boolean {
  return (
    name.endsWith('Info.plist')
    || name.endsWith('inkmarshal-desktop')
    || name.endsWith('CodeResources')
    || name === '._InkMarshal.app'
    || /(^|\/)\._/.test(name)
    || name.endsWith('.DS_Store')
  );
}

function buildFixtureArchive(memberNames: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const name of memberNames) {
    appendFixtureMember(chunks, name);
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function buildPaxPathArchive(path: string, remainingMembers: string[]): Buffer {
  const chunks: Buffer[] = [];
  const paxPayload = Buffer.from(paxRecord('path', path));
  appendRawFixtureMember(chunks, 'PaxHeader/path', paxPayload, 'x');
  appendRawFixtureMember(chunks, 'pax-placeholder', Buffer.from('appledouble'), '0');
  for (const name of remainingMembers) appendFixtureMember(chunks, name);
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function buildPaxSizeOverrideArchive(remainingMembers: string[]): Buffer {
  const chunks: Buffer[] = [];
  const paxPayload = Buffer.from(
    `${paxRecord('path', 'InkMarshal.app/Contents/safe')}${paxRecord('size', '0')}`,
  );
  appendRawFixtureMember(chunks, 'PaxHeader/size', paxPayload, 'x');
  chunks.push(ustarHeader('pax-placeholder', 512, '0'));
  chunks.push(ustarHeader('._InkMarshal.app', 0, '0'));
  for (const name of remainingMembers) appendFixtureMember(chunks, name);
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function buildMixedPathOverrideArchive(remainingMembers: string[]): Buffer {
  const chunks: Buffer[] = [];
  appendRawFixtureMember(chunks, '././@LongLink', Buffer.from('._InkMarshal.app\0'), 'L');
  appendRawFixtureMember(
    chunks,
    'PaxHeader/path',
    Buffer.from(paxRecord('path', 'InkMarshal.app/Contents/safe')),
    'x',
  );
  appendRawFixtureMember(chunks, 'placeholder', Buffer.alloc(0), '0');
  for (const name of remainingMembers) appendFixtureMember(chunks, name);
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function paxRecord(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = body.length + 2;
  for (;;) {
    const record = `${length} ${body}`;
    if (record.length === length) return record;
    length = record.length;
  }
}

function appendFixtureMember(chunks: Buffer[], name: string): void {
  const file = isFileMember(name);
  const payload = file
    ? Buffer.from(name === '._InkMarshal.app' ? 'appledouble' : `${name}-bytes`)
    : Buffer.alloc(0);
  appendRawFixtureMember(chunks, name, payload, file ? '0' : '5');
}

function appendRawFixtureMember(
  chunks: Buffer[],
  name: string,
  payload: Buffer,
  typeflag: string,
): void {
  chunks.push(ustarHeader(name, payload.length, typeflag));
  if (payload.length === 0) return;
  chunks.push(payload);
  const pad = (512 - (payload.length % 512)) % 512;
  if (pad) chunks.push(Buffer.alloc(pad));
}

function ustarHeader(name: string, size: number, typeflag: string): Buffer {
  const header = Buffer.alloc(512);
  const nameBuf = Buffer.from(name, 'utf8');
  if (nameBuf.length > 100) throw new Error(`fixture name too long: ${name}`);
  nameBuf.copy(header, 0);
  header.write('0000775\0', 100, 8, 'ascii'); // mode
  header.write('0000000\0', 108, 8, 'ascii'); // uid
  header.write('0000000\0', 116, 8, 'ascii'); // gid
  const sizeOctal = `${size.toString(8).padStart(11, '0')}\0`;
  header.write(sizeOctal, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii'); // mtime
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  const checksum = `${sum.toString(8).padStart(6, '0')}\0 `;
  header.write(checksum, 148, 8, 'ascii');
  return header;
}
