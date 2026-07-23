#!/usr/bin/env node
/*
 * build-mac-release.mjs — produces a signed + notarized macOS release DMG.
 *
 * Tauri 2's built-in codesign step only signs the top-level .app and the main
 * binary; it does NOT deep-walk `Contents/Resources/`. InkMarshal bundles many
 * third-party Mach-O binaries (llama.cpp dylibs, sharp .dylib/.node,
 * better-sqlite3 .node, the Node runtime) inside Resources, so Tauri's own
 * signing leaves them unsigned and Apple notarization rejects the bundle.
 *
 * This script therefore TAKES OVER signing + notarization + stapling + DMG
 * creation entirely:
 *   1. Build a bare (unsigned) .app via `tauri build --no-sign`
 *   2. Deep-sign every Mach-O binary under the .app, then the .app itself
 *   3. Notarize via `notarytool submit --wait`
 *   4. Staple the notarization ticket
 *   5. Build the polished DMG via the shared headless dmgbuild path
 *   6. Verify codesign / spctl / stapler (release-grade gate)
 *   7. Publish to dist/release with a .sha256
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAppleReleaseEnv } from './release-env.mjs';
import { createMacDmg } from './mac-dmg.mjs';

const STABLE_DMG_NAME = 'InkMarshal-mac-aarch64.dmg';
const STABLE_SHA_NAME = `${STABLE_DMG_NAME}.sha256`;
const UPDATER_ARCHIVE_NAME = 'InkMarshal-mac-aarch64.app.tar.gz';
const UPDATER_SIGNATURE_NAME = `${UPDATER_ARCHIVE_NAME}.sig`;
const UPDATE_MANIFEST_NAME = 'latest.json';
const MAC_RELEASE_TARGET = 'aarch64-apple-darwin';
const RELEASE_URL = `https://github.com/mike007jd/InkMarshal/releases/latest/download/${STABLE_DMG_NAME}`;
const UPDATER_URL = `https://github.com/mike007jd/InkMarshal/releases/latest/download/${UPDATER_ARCHIVE_NAME}`;
const SIGNING_IDENTITY_REQUIRED_PREFIX = 'Developer ID Application: ';
const APP_ENTITLEMENTS_PATH = join(process.cwd(), 'src-tauri', 'entitlements.plist');
const NODE_ENTITLEMENTS_PATH = join(process.cwd(), 'src-tauri', 'node-entitlements.plist');
const NATIVE_BINARY_EXTENSIONS = new Set(['.dylib', '.node', '.so']);
const FORBIDDEN_RUNTIME_ENTITLEMENTS = [
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-executable-page-protection',
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.get-task-allow',
];
const JIT_ENTITLEMENT = 'com.apple.security.cs.allow-jit';

const failures = [];

function fail(message) {
  failures.push(message);
}

function readEnv(name) {
  return (process.env[name] ?? '').trim();
}

function commandOutput(result) {
  return `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`.trim();
}

function redactedCommandArgs(args) {
  const sensitiveValueFlags = new Set(['--apple-id', '--password']);
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return '[REDACTED]';
    }
    if (sensitiveValueFlags.has(arg)) redactNext = true;
    return arg;
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, ...options });
  const output = commandOutput(result);
  if (result.status !== 0) {
    throw new Error(`${command} ${redactedCommandArgs(args).join(' ')} failed${output ? `: ${output}` : ''}`);
  }
  return output;
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function inkMarshalProcessIds() {
  const result = spawnSync('pgrep', ['-f', '/InkMarshal\\.app/Contents/MacOS/inkmarshal-desktop'], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`Unable to inspect running InkMarshal processes: ${commandOutput(result)}`);
  }
  return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
}

function stopRunningInkMarshal() {
  let pids = inkMarshalProcessIds();
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  for (let attempt = 0; attempt < 20 && pids.length > 0; attempt += 1) {
    sleepMs(250);
    pids = inkMarshalProcessIds();
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  if (inkMarshalProcessIds().length > 0) {
    throw new Error('InkMarshal processes are still running after termination');
  }
}

function detachOldInkMarshalDmgMounts() {
  if (!existsSync('/Volumes')) return;
  for (const volume of readdirSync('/Volumes')) {
    if (!/^InkMarshal(?:$|\s)/.test(volume)) continue;
    const mountPoint = join('/Volumes', volume);
    console.log(`[release:mac] detaching stale InkMarshal mount ${mountPoint}`);
    runCapture('hdiutil', ['detach', mountPoint]);
  }
}

function prepareDesktopPackagingEnvironment() {
  stopRunningInkMarshal();
  detachOldInkMarshalDmgMounts();
  run(process.execPath, [join(process.cwd(), 'scripts', 'clean-build-artifacts.mjs')]);
}

function requireReleaseEnv() {
  if (process.platform !== 'darwin') {
    fail('release:mac requires macOS signing and notarization tools.');
  }
  if (process.arch !== 'arm64') {
    fail(`release:mac requires darwin/arm64 for ${MAC_RELEASE_TARGET}; current arch is ${process.arch}.`);
  }

  const signingIdentity = readEnv('APPLE_SIGNING_IDENTITY');
  const appleId = readEnv('APPLE_ID');
  const appleTeamId = readEnv('APPLE_TEAM_ID');
  // Accept the Apple-standard var name first, fall back to the legacy name.
  const applePassword = readEnv('APPLE_APP_SPECIFIC_PASSWORD') || readEnv('APPLE_PASSWORD');
  const updaterKeyPath = readEnv('TAURI_SIGNING_PRIVATE_KEY_PATH')
    || join(homedir(), '.inkmarshal', 'release', 'updater.key');

  if (!signingIdentity) fail('APPLE_SIGNING_IDENTITY is required.');
  if (signingIdentity && !signingIdentity.startsWith(SIGNING_IDENTITY_REQUIRED_PREFIX)) {
    fail('APPLE_SIGNING_IDENTITY must be a Developer ID Application identity, not Apple Development or ad-hoc.');
  }
  if (!appleId || !appleId.includes('@')) {
    fail('APPLE_ID is required and must be the Apple Account email used for notarization.');
  }
  if (!appleTeamId) fail('APPLE_TEAM_ID is required.');
  if (signingIdentity && appleTeamId && !signingIdentity.endsWith(`(${appleTeamId})`)) {
    fail('APPLE_SIGNING_IDENTITY Team ID must match APPLE_TEAM_ID.');
  }
  if (!applePassword) fail('APPLE_APP_SPECIFIC_PASSWORD (or APPLE_PASSWORD) must be an app-specific password.');
  if (!existsSync(updaterKeyPath)) fail(`Tauri updater signing key is missing: ${updaterKeyPath}`);
  if (existsSync(updaterKeyPath) && process.platform !== 'win32' && (statSync(updaterKeyPath).mode & 0o077) !== 0) {
    fail(`Tauri updater signing key must not be readable by group/others: ${updaterKeyPath}`);
  }

  if (process.platform === 'darwin' && signingIdentity) {
    const identities = runCapture('security', ['find-identity', '-v', '-p', 'codesigning']);
    if (!identities.includes(signingIdentity)) {
      fail(`Developer ID signing identity is not installed in the current keychain: ${signingIdentity}`);
    }
  }

  if (failures.length > 0) {
    for (const message of failures) console.error(`FAIL: ${message}`);
    process.exit(1);
  }

  return { signingIdentity, appleId, appleTeamId, applePassword, updaterKeyPath };
}

function appBundlePath() {
  return join(process.cwd(), 'src-tauri/target', MAC_RELEASE_TARGET, 'release/bundle/macos/InkMarshal.app');
}

/**
 * Resolve the main executable name from Info.plist (CFBundleExecutable) rather
 * than hard-coding it: the binary is `inkmarshal-desktop`, not `InkMarshal`.
 */
function mainExecutableName(appPath) {
  const plist = join(appPath, 'Contents/Info.plist');
  if (!existsSync(plist)) throw new Error(`Info.plist not found in bundle: ${plist}`);
  const name = runCapture('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]).trim();
  if (!name) throw new Error('CFBundleExecutable is empty in Info.plist.');
  return name;
}

function assertBundleArchitecture(appPath) {
  const executableName = mainExecutableName(appPath);
  if (executableName !== 'inkmarshal-desktop') {
    throw new Error(`InkMarshal.app entry point must be inkmarshal-desktop, found ${executableName}.`);
  }
  const macosDir = join(appPath, 'Contents/MacOS');
  const bundledExecutables = readdirSync(macosDir).filter((name) => name !== '.DS_Store');
  if (bundledExecutables.length !== 1 || bundledExecutables[0] !== executableName) {
    throw new Error(`InkMarshal.app must bundle only its main executable; found ${bundledExecutables.join(', ') || 'none'}.`);
  }
  const executablePath = join(macosDir, executableName);
  if (!existsSync(executablePath)) throw new Error(`App executable was not produced: ${executablePath}`);
  const archs = runCapture('lipo', ['-archs', executablePath]).trim().split(/\s+/).filter(Boolean);
  if (archs.length !== 1 || archs[0] !== 'arm64') {
    throw new Error(`macOS release must be arm64-only for ${MAC_RELEASE_TARGET}; found ${archs.join(' ') || 'unknown'}.`);
  }
}

/**
 * Determine whether a file is a Mach-O binary that codesign can sign.
 * We trust the `file` magic output rather than the extension alone, because
 * llama.cpp ships executables with no extension and sharp ships `.node` files.
 */
function isMachOBinary(filePath) {
  let output;
  try {
    output = runCapture('file', ['-b', filePath]);
  } catch {
    return false;
  }
  return /^Mach-O\b/.test(output);
}

function looksLikeSignableBinaryCandidate(filePath, entry) {
  const lowerName = entry.name.toLowerCase();
  if (NATIVE_BINARY_EXTENSIONS.has(lowerName.slice(lowerName.lastIndexOf('.')))) return true;

  try {
    const mode = statSync(filePath).mode;
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function collectMachOBinaries(appPath) {
  const appContents = join(appPath, 'Contents');
  const collected = [];
  const stack = [appContents];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.name.startsWith('._')) continue;
      if (!looksLikeSignableBinaryCandidate(full, entry)) continue;
      if (isMachOBinary(full)) collected.push(full);
    }
  }
  return collected;
}

function entitlementIsEnabled(output, entitlement) {
  const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`, 'i').test(output);
}

function assertMinimalCodeSigning(appPath, machOBinaries, expectedTeamId) {
  const appContents = join(appPath, 'Contents');
  const nodeRuntimePath = join(appContents, 'Resources', 'node', 'node');
  const targets = [...new Set([...machOBinaries, appPath])];

  if (!machOBinaries.includes(nodeRuntimePath)) {
    throw new Error(`Bundled Node runtime was not found among signed Mach-O files: ${nodeRuntimePath}`);
  }

  for (const target of targets) {
    const details = runCapture('codesign', ['-dvvv', target]);
    const teamId = details.match(/TeamIdentifier=([^\s]+)/)?.[1];
    if (teamId !== expectedTeamId) {
      throw new Error(`Unexpected Team ID for ${relative(appContents, target)}: ${teamId || 'missing'}`);
    }

    const entitlements = runCapture('codesign', ['-d', '--entitlements', ':-', target]);
    for (const forbidden of FORBIDDEN_RUNTIME_ENTITLEMENTS) {
      if (entitlementIsEnabled(entitlements, forbidden)) {
        throw new Error(`Forbidden entitlement ${forbidden} on ${relative(appContents, target)}`);
      }
    }

    const hasJit = entitlementIsEnabled(entitlements, JIT_ENTITLEMENT);
    if (target === nodeRuntimePath && !hasJit) {
      throw new Error('Bundled Node runtime must retain only the allow-jit exception.');
    }
    if (target !== nodeRuntimePath && hasJit) {
      throw new Error(`allow-jit is limited to the bundled Node runtime, found on ${relative(appContents, target)}`);
    }
  }

  console.log(`[verify] ${machOBinaries.length} bundled Mach-O files share Team ID ${expectedTeamId}; only Node has allow-jit.`);
}

/**
 * Walk the .app and deep-sign every Mach-O binary (leaf-first), then sign the
 * .app bundle itself last. Every signature carries hardened runtime and a
 * secure timestamp. Only the separately spawned Node/V8 runtime receives
 * allow-jit; the app, engines, dylibs and native modules receive no exceptions.
 *
 * `--force` is used everywhere so re-runs are idempotent and so already-signed
 * third-party binaries (e.g. the Node runtime, signed by Node's team) are
 * re-signed under our Developer ID for a consistent signature chain.
 */
function signBundleDeep(appPath, signingIdentity, expectedTeamId) {
  for (const entitlementsPath of [APP_ENTITLEMENTS_PATH, NODE_ENTITLEMENTS_PATH]) {
    if (!existsSync(entitlementsPath)) {
      throw new Error(`entitlements file not found: ${entitlementsPath}`);
    }
  }

  const appContents = join(appPath, 'Contents');
  const nodeRuntimePath = join(appContents, 'Resources', 'node', 'node');
  const collected = collectMachOBinaries(appPath);

  if (collected.length === 0) {
    throw new Error('No Mach-O binaries found to sign inside the .app bundle.');
  }

  const signArgs = (target, entitlementsPath = null) => [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    ...(entitlementsPath ? ['--entitlements', entitlementsPath] : []),
    '-s', signingIdentity,
    target,
  ];

  // Leaf binaries first (innermost dylibs/nodes/executables).
  collected.sort((a, b) => b.length - a.length);
  console.log(`[sign] deep-signing ${collected.length} Mach-O binaries...`);
  let index = 0;
  for (const target of collected) {
    index += 1;
    process.stdout.write(`[sign] (${index}/${collected.length}) ${target.replace(appContents, '.../Contents')} ... `);
    const entitlementsPath = target === nodeRuntimePath ? NODE_ENTITLEMENTS_PATH : null;
    runCapture('codesign', signArgs(target, entitlementsPath));
    console.log('ok');
  }

  // Finally sign the .app bundle itself.
  console.log('[sign] signing InkMarshal.app bundle...');
  runCapture('codesign', signArgs(appPath, APP_ENTITLEMENTS_PATH));
  assertMinimalCodeSigning(appPath, collected, expectedTeamId);
  console.log('[sign] deep signing complete.');
  return collected;
}

/**
 * Submit an artifact for notarization and block until Apple finishes.
 * `artifact` is either an `.app` bundle (zipped with ditto first, as required
 * by the notary service) or a `.dmg` (submitted directly). On failure, fetch
 * and print the full notarytool log so the cause (e.g. an unsigned binary) is
 * visible without a separate manual step.
 */
function notarizeArtifact(artifact, { appleId, applePassword, appleTeamId }) {
  const isDmg = artifact.toLowerCase().endsWith('.dmg');
  const submitTarget = isDmg ? artifact : (() => {
    const tmpZip = `${artifact}.notarize.zip`;
    if (existsSync(tmpZip)) rmSync(tmpZip, { force: true });
    console.log('[notarize] creating zip for submission...');
    // ditto preserves the bundle structure and is the recommended zipper for
    // notarization submissions (preserves symlinks and extended attributes).
    runCapture('ditto', ['-c', '-k', '--keepParent', artifact, tmpZip]);
    return tmpZip;
  })();
  const cleanupZip = isDmg ? null : submitTarget;

  console.log(`[notarize] submitting ${isDmg ? 'DMG' : 'app'} to Apple (this can take several minutes)...`);
  // NOTE: `notarytool submit --wait` exits non-zero if notarization fails, in
  // which case runCapture already throws. So reaching the line after this call
  // means success. We do NOT parse the "Current status: In Progress..." progress
  // spam from --wait (an earlier naive `/status:\s*(\w+)/` regex matched the
  // "In" of "In Progress" and falsely reported failure on a real Accepted run).
  const submitOutput = runCapture('xcrun', [
    'notarytool', 'submit', submitTarget,
    '--apple-id', appleId,
    '--password', applePassword,
    '--team-id', appleTeamId,
    '--wait',
  ]);
  console.log(submitOutput);

  // Capture the submission id for the success report / log retrieval.
  const idMatch = submitOutput.match(/id:\s*([0-9a-f-]+)/i);
  const submissionId = idMatch?.[1];

  // The final status line is the standalone "  status: Accepted" printed at the
  // end (two-space indent). Match it explicitly to confirm, ignoring the
  // "Current status: In Progress..." poll line during --wait.
  const finalStatusMatch = submitOutput.match(/^[\t ]*status:\s*([A-Za-z]+)/m);
  const finalStatus = finalStatusMatch?.[1];

  if (cleanupZip) rmSync(cleanupZip, { force: true });

  if (finalStatus && finalStatus.toLowerCase() !== 'accepted') {
    if (submissionId) {
      console.error(`[notarize] status was '${finalStatus}'; fetching log for ${submissionId}...`);
      try {
        const log = runCapture('xcrun', [
          'notarytool', 'log', submissionId,
          '--apple-id', appleId,
          '--password', applePassword,
          '--team-id', appleTeamId,
        ]);
        console.error(log);
      } catch (logError) {
        console.error(`[notarize] could not fetch log: ${logError.message}`);
      }
    }
    throw new Error(`notarization did not succeed (status: ${finalStatus || 'unknown'}).`);
  }

  console.log(`[notarize] ${isDmg ? 'DMG' : 'app'} accepted${submissionId ? ` (id ${submissionId})` : ''}.`);
}

function stapleArtifact(artifact) {
  console.log(`[staple] stapling notarization ticket to ${artifact}...`);
  runCapture('xcrun', ['stapler', 'staple', artifact]);
  console.log('[staple] validating staple...');
  runCapture('xcrun', ['stapler', 'validate', artifact]);
  console.log('[staple] ok.');
}

/**
 * Sign the DMG container with Developer ID + hardened runtime + secure timestamp.
 * The DMG is the file users actually download, so it must be signed (and then
 * notarized + stapled) in its own right, not just the app inside it.
 */
function signDmg(dmgPath, signingIdentity) {
  console.log('[sign] signing DMG container...');
  runCapture('codesign', [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '-s', signingIdentity,
    dmgPath,
  ]);
  console.log('[sign] DMG signed.');
}

function assertMountedDmgAppSignature(dmgPath) {
  console.log('[verify] mounting DMG to verify the exact packaged app...');
  const attachOutput = runCapture('hdiutil', ['attach', '-nobrowse', '-readonly', dmgPath]);
  const mountPoint = attachOutput
    .split(/\r?\n/)
    .map((line) => line.split('\t').at(-1)?.trim())
    .find((value) => value?.startsWith('/Volumes/'));
  if (!mountPoint) {
    throw new Error(`Could not determine DMG mount point from hdiutil output: ${attachOutput}`);
  }

  try {
    const mountedApp = join(mountPoint, 'InkMarshal.app');
    if (!existsSync(mountedApp)) throw new Error(`Mounted DMG app is missing: ${mountedApp}`);
    runCapture('codesign', ['--verify', '--deep', '--strict', '--verbose=4', mountedApp]);
    console.log('[verify] exact mounted DMG app signature OK.');
  } finally {
    runCapture('hdiutil', ['detach', mountPoint]);
  }
}

function exactDmgLaunchSmoke(dmgPath) {
  stopRunningInkMarshal();
  detachOldInkMarshalDmgMounts();
  console.log('[smoke] mounting and launching the exact final DMG...');
  const attachOutput = runCapture('hdiutil', ['attach', '-nobrowse', '-readonly', dmgPath]);
  const mountPoint = attachOutput
    .split(/\r?\n/)
    .map((line) => line.split('\t').at(-1)?.trim())
    .find((value) => value?.startsWith('/Volumes/'));
  if (!mountPoint) throw new Error(`Could not determine final DMG mount point: ${attachOutput}`);

  const smokeHome = mkdtempSync(join(tmpdir(), 'inkmarshal-exact-dmg-smoke-'));
  try {
    const mountedApp = join(mountPoint, 'InkMarshal.app');
    const mountedExecutable = join(mountedApp, 'Contents', 'MacOS', 'inkmarshal-desktop');
    if (!existsSync(mountedExecutable)) throw new Error(`Mounted executable is missing: ${mountedExecutable}`);
    runCapture('open', ['-n', '--env', `INKMARSHAL_HOME=${smokeHome}`, mountedApp]);

    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const pids = inkMarshalProcessIds();
      if (pids.length > 1) {
        throw new Error(`Expected one InkMarshal app process, found ${pids.join(', ')}`);
      }
      if (pids.length === 1) {
        const command = runCapture('ps', ['-p', String(pids[0]), '-o', 'command=']).trim();
        if (!command.startsWith(mountedExecutable)) {
          throw new Error(`InkMarshal executable is not from the current DMG mount: ${command}`);
        }
        for (const port of [1421, 1422]) {
          const health = spawnSync('curl', [
            '--fail', '--silent', '--show-error', '--max-time', '1',
            `http://127.0.0.1:${port}/api/health`,
          ], { encoding: 'utf8', shell: false });
          if (health.status !== 0) continue;
          try {
            const body = JSON.parse(health.stdout);
            if (body?.ok === true && body.runtime === 'desktop') ready = true;
          } catch {
            // Keep polling until a complete JSON response is available.
          }
        }
      }
      if (ready) break;
      sleepMs(500);
    }
    if (!ready) throw new Error('Exact final DMG app did not become healthy on port 1421 or 1422');
    const finalPids = inkMarshalProcessIds();
    if (finalPids.length !== 1) {
      throw new Error(`Expected exactly one healthy InkMarshal process, found ${finalPids.length}`);
    }
    console.log(`[smoke] PASS: exact final DMG launched from ${mountedExecutable}`);
  } finally {
    stopRunningInkMarshal();
    rmSync(smokeHome, { recursive: true, force: true });
    runCapture('hdiutil', ['detach', mountPoint]);
  }
}

function writeSha256(filePath, outputPath) {
  const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  writeFileSync(outputPath, `${digest}  ${STABLE_DMG_NAME}\n`);
}

function resetStableReleaseAssets(...paths) {
  for (const path of paths) {
    rmSync(path, { force: true });
  }
}

function publishStableReleaseAssets({
  producedDmgPath,
  producedUpdaterPath,
  producedUpdaterSignaturePath,
  producedManifestPath,
  stableDmgPath,
  stableShaPath,
  stableUpdaterPath,
  stableUpdaterSignaturePath,
  stableManifestPath,
  tempDmgPath,
  tempShaPath,
  tempUpdaterPath,
  tempUpdaterSignaturePath,
  tempManifestPath,
}) {
  try {
    copyFileSync(producedDmgPath, tempDmgPath);
    writeSha256(tempDmgPath, tempShaPath);
    copyFileSync(producedUpdaterPath, tempUpdaterPath);
    copyFileSync(producedUpdaterSignaturePath, tempUpdaterSignaturePath);
    copyFileSync(producedManifestPath, tempManifestPath);
    renameSync(tempDmgPath, stableDmgPath);
    renameSync(tempShaPath, stableShaPath);
    renameSync(tempUpdaterPath, stableUpdaterPath);
    renameSync(tempUpdaterSignaturePath, stableUpdaterSignaturePath);
    renameSync(tempManifestPath, stableManifestPath);
  } catch (error) {
    resetStableReleaseAssets(
      stableDmgPath,
      stableShaPath,
      stableUpdaterPath,
      stableUpdaterSignaturePath,
      stableManifestPath,
      tempDmgPath,
      tempShaPath,
      tempUpdaterPath,
      tempUpdaterSignaturePath,
      tempManifestPath,
    );
    throw error;
  }
}

function createSignedUpdaterAssets(appPath, archivePath, updaterKeyPath) {
  mkdirSync(dirname(archivePath), { recursive: true });
  rmSync(archivePath, { force: true });
  rmSync(`${archivePath}.sig`, { force: true });
  // Tauri's macOS updater consumes a gzip-compressed tar containing the final
  // signed .app. Create it only after deep-signing, notarizing and stapling.
  runCapture('/usr/bin/tar', ['-czf', archivePath, '-C', dirname(appPath), basename(appPath)]);
  const signerArgs = ['tauri', 'signer', 'sign', '--private-key-path', updaterKeyPath];
  const updaterPassword = readEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  // Always pass the password argument, including an empty password. Otherwise
  // the signer tries to prompt in a non-interactive release process and fails.
  signerArgs.push('--password', updaterPassword);
  signerArgs.push(archivePath);
  runCapture('npx', signerArgs);
  const signaturePath = `${archivePath}.sig`;
  if (!existsSync(signaturePath)) throw new Error(`Updater signature was not produced: ${signaturePath}`);
  return signaturePath;
}

function writeUpdateManifest(outputPath, signaturePath) {
  const packageVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
  const tauriVersion = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  if (!packageVersion || packageVersion !== tauriVersion) {
    throw new Error(`package.json and tauri.conf.json versions must match (${packageVersion} vs ${tauriVersion}).`);
  }
  const manifest = {
    version: packageVersion,
    notes: readEnv('INKMARSHAL_UPDATE_NOTES') || `InkMarshal ${packageVersion}`,
    pub_date: new Date().toISOString(),
    critical: readEnv('INKMARSHAL_UPDATE_CRITICAL') === '1',
    platforms: {
      'darwin-aarch64': {
        url: UPDATER_URL,
        signature: readFileSync(signaturePath, 'utf8').trim(),
      },
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertReleaseGrade(appPath, dmgPath, expectedTeamId, signedMachOBinaries) {
  console.log('[verify] running release-grade checks...');
  runCapture('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);
  runCapture('codesign', ['--verify', '--strict', '--verbose=4', dmgPath]);
  assertMinimalCodeSigning(appPath, signedMachOBinaries, expectedTeamId);

  const codeSignDetails = runCapture('codesign', ['-dv', '--verbose=4', appPath]);
  if (/Signature=adhoc|TeamIdentifier=not set/i.test(codeSignDetails)) {
    throw new Error('The app is not signed with a Developer ID identity.');
  }

  const spctlOutput = runCapture('spctl', ['-a', '-vv', '-t', 'install', dmgPath]);
  if (/no usable signature|source=Unnotarized Developer ID|rejected/i.test(spctlOutput)) {
    throw new Error(`Gatekeeper assessment is not release-grade: ${spctlOutput}`);
  }
  if (/override=security disabled/i.test(spctlOutput) && !/accepted/i.test(spctlOutput)) {
    throw new Error(`Gatekeeper assessment is inconclusive on this host: ${spctlOutput}`);
  }

  runCapture('xcrun', ['stapler', 'validate', dmgPath]);
  console.log(`[verify] ${spctlOutput.split('\n').find((l) => /source=|accepted/i.test(l)) || 'ok'}`);
  console.log('[verify] release-grade OK.');
}

// ── main ──────────────────────────────────────────────────────────────────
try {
  const releaseEnv = loadAppleReleaseEnv();
  if (releaseEnv.loaded.length > 0) {
    console.log(`[release:mac] loaded Apple release env from ${releaseEnv.filePath}`);
  }
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const { signingIdentity, appleId, appleTeamId, applePassword, updaterKeyPath } = requireReleaseEnv();

prepareDesktopPackagingEnvironment();

const releaseDir = join(process.cwd(), 'dist/release');
mkdirSync(releaseDir, { recursive: true });
const stableDmgPath = join(releaseDir, STABLE_DMG_NAME);
const stableShaPath = join(releaseDir, STABLE_SHA_NAME);
const stableUpdaterPath = join(releaseDir, UPDATER_ARCHIVE_NAME);
const stableUpdaterSignaturePath = join(releaseDir, UPDATER_SIGNATURE_NAME);
const stableManifestPath = join(releaseDir, UPDATE_MANIFEST_NAME);
const tempDmgPath = `${stableDmgPath}.tmp.dmg`;
const tempShaPath = `${stableShaPath}.tmp`;
const tempUpdaterPath = `${stableUpdaterPath}.tmp`;
const tempUpdaterSignaturePath = `${stableUpdaterSignaturePath}.tmp`;
const tempManifestPath = `${stableManifestPath}.tmp`;
resetStableReleaseAssets(
  stableDmgPath,
  stableShaPath,
  stableUpdaterPath,
  stableUpdaterSignaturePath,
  stableManifestPath,
  tempDmgPath,
  tempShaPath,
  tempUpdaterPath,
  tempUpdaterSignaturePath,
  tempManifestPath,
);

// NOTE: we invoke the Tauri CLI directly via `npx tauri build` instead of
// `pnpm desktop:build -- --no-sign ...`. pnpm's `--` forwarding inserts a
// literal `--` before the flags, and Tauri then rejects them as unexpected
// positional args ("unexpected argument '--no-sign'"). `--no-sign` skips
// Tauri's shallow codesign (which does not deep-walk Resources and would leave
// the bundled engines/node_modules binaries unsigned); we deep-sign ourselves.
console.log('[release:mac] Building bare (unsigned) macOS bundle, then signing + notarizing...');
run('npx', ['tauri', 'build', '--no-sign', '--target', MAC_RELEASE_TARGET, '--bundles', 'app']);

const appPath = appBundlePath();
if (!existsSync(appPath)) throw new Error('InkMarshal.app was not produced.');
assertBundleArchitecture(appPath);

// 1) Deep-sign the app (all nested Mach-O binaries + the bundle), then notarize
//    + staple the app itself.
const signedMachOBinaries = signBundleDeep(appPath, signingIdentity, appleTeamId);
notarizeArtifact(appPath, { appleId, applePassword, appleTeamId });
stapleArtifact(appPath);

// The updater archive must capture the final signed/stapled app. Signing an
// earlier archive would make the published update differ from the verified app.
const producedUpdaterPath = join(releaseDir, `${UPDATER_ARCHIVE_NAME}.produced`);
const producedUpdaterSignaturePath = createSignedUpdaterAssets(appPath, producedUpdaterPath, updaterKeyPath);
const producedManifestPath = join(releaseDir, `${UPDATE_MANIFEST_NAME}.produced`);
writeUpdateManifest(producedManifestPath, producedUpdaterSignaturePath);

// 2) Build the DMG from the signed+notarized+stapled app. The DMG is the file
//    users download, so it must ALSO be signed + notarized + stapled in its own
//    right (a signed-only DMG shows as "Unnotarized Developer ID" in spctl).
const producedDmgPath = join(releaseDir, `${STABLE_DMG_NAME}.tmp.dmg`);
createMacDmg({
  appPath,
  outputPath: producedDmgPath,
  volumeIconPath: join(process.cwd(), 'src-tauri', 'icons', 'icon.icns'),
});
assertMountedDmgAppSignature(producedDmgPath);
signDmg(producedDmgPath, signingIdentity);
notarizeArtifact(producedDmgPath, { appleId, applePassword, appleTeamId });
stapleArtifact(producedDmgPath);

// 3) Release-grade gate, then publish the final DMG + sha256.
assertReleaseGrade(appPath, producedDmgPath, appleTeamId, signedMachOBinaries);
publishStableReleaseAssets({
  producedDmgPath,
  producedUpdaterPath,
  producedUpdaterSignaturePath,
  producedManifestPath,
  stableDmgPath,
  stableShaPath,
  stableUpdaterPath,
  stableUpdaterSignaturePath,
  stableManifestPath,
  tempDmgPath,
  tempShaPath,
  tempUpdaterPath,
  tempUpdaterSignaturePath,
  tempManifestPath,
});
resetStableReleaseAssets(producedDmgPath, producedUpdaterPath, producedUpdaterSignaturePath, producedManifestPath);

try {
  exactDmgLaunchSmoke(stableDmgPath);
} catch (error) {
  resetStableReleaseAssets(
    stableDmgPath,
    stableShaPath,
    stableUpdaterPath,
    stableUpdaterSignaturePath,
    stableManifestPath,
  );
  throw error;
}

console.log('[release:mac] Release assets ready:');
console.log(`  ${stableDmgPath}`);
console.log(`  ${stableShaPath}`);
console.log(`  ${stableUpdaterPath}`);
console.log(`  ${stableUpdaterSignaturePath}`);
console.log(`  ${stableManifestPath}`);
console.log(`[release:mac] Upload all five assets to GitHub Release. Public download: ${RELEASE_URL}`);
