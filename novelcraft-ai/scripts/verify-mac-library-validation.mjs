#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadAppleReleaseEnv } from './release-env.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed${output ? `: ${output}` : ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function mainExecutable(appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const name = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]).trim();
  return join(appPath, 'Contents', 'MacOS', name);
}

async function launchWithInjection(executable, dylibPath, markerPath, testHome) {
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      DYLD_INSERT_LIBRARIES: dylibPath,
      INKMARSHAL_DYLD_PROBE_MARKER: markerPath,
      INKMARSHAL_HOME: testHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const result = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
  ]);
  if (result === null) {
    child.kill('SIGTERM');
    await exit;
  }
  return { result, output };
}

const args = process.argv.slice(2);
const expectInjected = args.includes('--expect-injected');
const appPath = args.find((arg) => !arg.startsWith('--'));
if (process.platform !== 'darwin' || !appPath || !existsSync(appPath)) {
  console.error('Usage: node scripts/verify-mac-library-validation.mjs <InkMarshal.app> [--expect-injected]');
  process.exit(2);
}

const tempDir = mkdtempSync(join(tmpdir(), 'inkmarshal-library-validation-'));
try {
  const dylibSource = join(tempDir, 'probe.c');
  const dylibPath = join(tempDir, 'libInkMarshalInjectionProbe.dylib');
  const markerPath = join(tempDir, 'injected.marker');
  const hostSource = join(tempDir, 'dlopen-host.c');
  const hostPath = join(tempDir, 'dlopen-host');
  const testHome = join(tempDir, 'home');

  writeFileSync(dylibSource, `
#include <stdio.h>
#include <stdlib.h>
__attribute__((constructor)) static void inkmarshal_probe(void) {
  const char *marker = getenv("INKMARSHAL_DYLD_PROBE_MARKER");
  if (marker) { FILE *file = fopen(marker, "w"); if (file) { fputs("INJECTED\\n", file); fclose(file); } }
  fputs("INKMARSHAL_DYLD_PROBE_LOADED\\n", stderr);
}
`);
  writeFileSync(hostSource, `
#include <dlfcn.h>
#include <stdio.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  void *handle = dlopen(argv[1], RTLD_NOW);
  if (!handle) { fprintf(stderr, "LIBRARY_VALIDATION_REJECTED: %s\\n", dlerror()); return 42; }
  dlclose(handle); return 0;
}
`);

  run('clang', ['-dynamiclib', '-o', dylibPath, dylibSource]);
  const launch = await launchWithInjection(mainExecutable(appPath), dylibPath, markerPath, testHome);
  const injected = existsSync(markerPath);

  if (expectInjected) {
    if (!injected) throw new Error(`Expected baseline injection to load, but the marker was absent. ${launch.output.trim()}`);
    console.log('DYLD baseline: INKMARSHAL_DYLD_PROBE_LOADED (injection succeeded).');
  } else {
    if (injected) {
      throw new Error('DYLD_INSERT_LIBRARIES injection succeeded; the probe constructor ran.');
    }

    loadAppleReleaseEnv();
    const signingIdentity = (process.env.APPLE_SIGNING_IDENTITY ?? '').trim();
    if (!signingIdentity) throw new Error('APPLE_SIGNING_IDENTITY is required for the library-validation probe host.');
    run('clang', ['-o', hostPath, hostSource]);
    run('codesign', ['--force', '--options', 'runtime', '--timestamp', '-s', signingIdentity, hostPath]);
    const dlopen = spawnSync(hostPath, [dylibPath], { encoding: 'utf8' });
    const rejection = `${dlopen.stdout ?? ''}${dlopen.stderr ?? ''}`.trim();
    if (dlopen.status !== 42 || !/LIBRARY_VALIDATION_REJECTED:.*(different Team IDs|code signature|not valid for use in process)/is.test(rejection)) {
      throw new Error(`Library validation did not produce the expected rejection: ${rejection || `exit ${dlopen.status}`}`);
    }

    const dyldLine = launch.output.split(/\r?\n/).find((line) => /dyld|library validation|code signature/i.test(line));
    console.log(`DYLD injection blocked for ${basename(appPath)}: probe constructor did not run${dyldLine ? ` (${dyldLine.trim()})` : '.'}`);
    console.log(rejection.split(/\r?\n/).find((line) => line.startsWith('LIBRARY_VALIDATION_REJECTED:')));
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
