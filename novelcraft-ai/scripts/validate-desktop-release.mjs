#!/usr/bin/env node
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAC_RELEASE_ASSET_NAME = 'InkMarshal-mac-aarch64.dmg';
const MAC_RELEASE_TARGET = 'aarch64-apple-darwin';
const UPDATER_ASSET_NAME = 'InkMarshal-mac-aarch64.app.tar.gz';
const UPDATER_SIGNATURE_NAME = `${UPDATER_ASSET_NAME}.sig`;
const UPDATE_MANIFEST_NAME = 'latest.json';
const CANONICAL_MAC_DOWNLOAD_URL =
  `https://github.com/mike007jd/InkMarshal/releases/latest/download/${MAC_RELEASE_ASSET_NAME}`;
const CANONICAL_UPDATER_URL =
  `https://github.com/mike007jd/InkMarshal/releases/latest/download/${UPDATER_ASSET_NAME}`;
const CANONICAL_UPDATER_SIGNATURE_URL = `${CANONICAL_UPDATER_URL}.sig`;
const CANONICAL_UPDATE_MANIFEST_URL =
  `https://github.com/mike007jd/InkMarshal/releases/latest/download/${UPDATE_MANIFEST_NAME}`;
const failures = [];
const FORBIDDEN_RUNTIME_ENTITLEMENTS = [
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.get-task-allow',
];

function fail(message) {
  failures.push(message);
}

function readEnv(name) {
  return (process.env[name] ?? '').trim();
}

async function validateRemoteAsset(value, label) {
  if (!value || failures.length > 0) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    let response = await fetch(value, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (response.status === 405) {
      response = await fetch(value, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        redirect: 'follow',
        signal: controller.signal,
      });
    }
    if (!response.ok && response.status !== 206) {
      fail(`${label} is not reachable as a published release asset (HTTP ${response.status}).`);
    }
  } catch (error) {
    fail(`${label} release asset check failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function commandOutput(result) {
  return `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`.trim();
}

function runRequired(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = commandOutput(result);
  if (result.status !== 0) {
    fail(`${label} failed${output ? `: ${output}` : '.'}`);
    return output;
  }
  return output;
}

function targetBundleRoot() {
  return join(process.cwd(), 'src-tauri/target', MAC_RELEASE_TARGET, 'release/bundle');
}

function updaterConfiguration() {
  return JSON.parse(readFileSync(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')).plugins?.updater;
}

function verifyUpdaterSignature(archivePath, signaturePath) {
  const publicKey = updaterConfiguration()?.pubkey;
  if (!publicKey || typeof publicKey !== 'string') {
    fail('Tauri updater public key is missing.');
    return;
  }
  runRequired('cargo', [
    'run', '--quiet', '--manifest-path', 'src-tauri/Cargo.toml',
    '--example', 'verify-updater-signature', '--', archivePath, signaturePath, publicKey,
  ], 'updater Minisign verification');
}

function validateUpdaterManifest(manifest, signature) {
  const platform = manifest?.platforms?.['darwin-aarch64'];
  if (manifest?.version !== JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version) {
    fail('latest.json version must match package.json.');
  }
  if (platform?.url !== CANONICAL_UPDATER_URL) fail(`latest.json updater URL must be ${CANONICAL_UPDATER_URL}`);
  if (!signature || platform?.signature !== signature) {
    fail('latest.json signature must exactly match the final updater .sig asset.');
  }
  if (typeof manifest?.critical !== 'boolean') fail('latest.json critical must be an explicit boolean.');
}

function validateMacBundleSignature() {
  if (process.platform !== 'darwin') {
    fail('CHECK_LOCAL_MAC_BUNDLE=1 requires macOS signing tools.');
    return;
  }

  const appPath = join(targetBundleRoot(), 'macos/InkMarshal.app');
  const stableDmgPath = join(process.cwd(), 'dist/release', MAC_RELEASE_ASSET_NAME);

  if (!existsSync(appPath)) fail('macOS .app bundle is missing. Run pnpm desktop:build first.');
  if (!existsSync(stableDmgPath)) fail(`Exact final DMG is missing: dist/release/${MAC_RELEASE_ASSET_NAME}`);
  if (failures.length > 0) return;

  runRequired('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], 'codesign verification');
  runRequired('codesign', ['--verify', '--strict', '--verbose=2', stableDmgPath], 'DMG codesign verification');
  const codesignDetails = runRequired('codesign', ['-dv', '--verbose=4', appPath], 'codesign identity inspection');
  if (/Signature=adhoc|TeamIdentifier=not set/i.test(codesignDetails)) {
    fail('macOS app is not signed with a Developer ID identity.');
  }
  const appEntitlements = runRequired(
    'codesign', ['-d', '--entitlements', ':-', appPath], 'app entitlement inspection'
  );
  for (const entitlement of FORBIDDEN_RUNTIME_ENTITLEMENTS) {
    if (appEntitlements.includes(`<key>${entitlement}</key>`)) {
      fail(`macOS app retains forbidden entitlement: ${entitlement}`);
    }
  }
  if (appEntitlements.includes('<key>com.apple.security.cs.allow-jit</key>')) {
    fail('allow-jit must be limited to the bundled Node runtime, not the app process.');
  }
  const spctlOutput = runRequired('spctl', ['-a', '-vv', '-t', 'install', stableDmgPath], 'Gatekeeper assessment');
  if (/no usable signature|source=Unnotarized Developer ID|rejected/i.test(spctlOutput)) {
    fail(`Gatekeeper assessment is not release-grade: ${spctlOutput}`);
  }
  if (/override=security disabled/i.test(spctlOutput) && !/accepted/i.test(spctlOutput)) {
    fail(`Gatekeeper assessment is inconclusive on this host: ${spctlOutput}`);
  }
  runRequired('xcrun', ['stapler', 'validate', stableDmgPath], 'notarization ticket validation');
  validateLocalUpdaterAssets();
}

function validateLocalUpdaterAssets() {
  const releaseDir = join(process.cwd(), 'dist/release');
  const archivePath = join(releaseDir, UPDATER_ASSET_NAME);
  const signaturePath = join(releaseDir, UPDATER_SIGNATURE_NAME);
  const manifestPath = join(releaseDir, UPDATE_MANIFEST_NAME);
  for (const [label, path] of [
    ['updater archive', archivePath],
    ['updater signature', signaturePath],
    ['update manifest', manifestPath],
  ]) {
    if (!existsSync(path)) fail(`Exact final ${label} is missing: ${relative(process.cwd(), path)}`);
  }
  if (failures.length > 0) return;

  const signature = readFileSync(signaturePath, 'utf8').trim();
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`latest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  validateUpdaterManifest(manifest, signature);
  verifyUpdaterSignature(archivePath, signaturePath);
}

function validateUpdaterConfiguration() {
  const updater = updaterConfiguration();
  if (!updater?.pubkey || typeof updater.pubkey !== 'string') fail('Tauri updater public key is missing.');
  if (!Array.isArray(updater?.endpoints) || updater.endpoints.length !== 1 || updater.endpoints[0] !== CANONICAL_UPDATE_MANIFEST_URL) {
    fail(`Tauri updater endpoint must be exactly ${CANONICAL_UPDATE_MANIFEST_URL}`);
  }
}

async function validatePublishedUpdater() {
  if (failures.length > 0) return;
  const tempDir = mkdtempSync(join(tmpdir(), 'inkmarshal-published-updater-'));
  const archivePath = join(tempDir, UPDATER_ASSET_NAME);
  const signaturePath = join(tempDir, UPDATER_SIGNATURE_NAME);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const [manifestResponse, signatureResponse] = await Promise.all([
      fetch(CANONICAL_UPDATE_MANIFEST_URL, { redirect: 'follow', signal: controller.signal }),
      fetch(CANONICAL_UPDATER_SIGNATURE_URL, { redirect: 'follow', signal: controller.signal }),
    ]);
    if (!manifestResponse.ok) throw new Error(`latest.json returned HTTP ${manifestResponse.status}`);
    if (!signatureResponse.ok) throw new Error(`updater signature returned HTTP ${signatureResponse.status}`);

    const manifest = await manifestResponse.json();
    const signature = (await signatureResponse.text()).trim();
    validateUpdaterManifest(manifest, signature);
    if (failures.length > 0) return;

    const archiveResponse = await fetch(CANONICAL_UPDATER_URL, { redirect: 'follow', signal: controller.signal });
    if (!archiveResponse.ok || !archiveResponse.body) {
      throw new Error(`updater archive returned HTTP ${archiveResponse.status}`);
    }
    await pipeline(Readable.fromWeb(archiveResponse.body), createWriteStream(archivePath));
    writeFileSync(signaturePath, `${signature}\n`, { mode: 0o600 });
    verifyUpdaterSignature(archivePath, signaturePath);
  } catch (error) {
    fail(`published updater verification failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

validateUpdaterConfiguration();
if (readEnv('CHECK_LOCAL_MAC_BUNDLE') === '1') validateMacBundleSignature();
await validateRemoteAsset(CANONICAL_MAC_DOWNLOAD_URL, 'canonical macOS release asset');
if (readEnv('CHECK_PUBLISHED_UPDATER') === '1') {
  await validatePublishedUpdater();
}

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL: ${message}`);
  process.exit(1);
}

console.log('Desktop release gate passed.');
