#!/usr/bin/env node
// E2E-01 — automated-ci-boot desktop smoke.
//
// Boots the copied Tauri Next resource with the bundled Node executable exactly
// as the packaged runtime does, against a throwaway INKMARSHAL_HOME, then probes
// /api/health and asserts the readiness identity proof.
//
// Run AFTER `pnpm build:desktop-web`. Missing copied resources are always a hard
// failure so a broken runtime cannot enter a packaged app.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const HOST = '127.0.0.1';
const RUNTIME_ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'XDG_DATA_HOME',
];

function log(msg) {
  process.stdout.write(`[desktop-smoke] ${msg}\n`);
}

function resolveServerJs() {
  const base = path.join(root, 'src-tauri', 'resources', 'next-server');
  const nodeBinary = path.join(
    root,
    'src-tauri',
    'resources',
    'node',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  if (!existsSync(nodeBinary)) {
    throw new Error(`bundled Node runtime is missing: ${nodeBinary}`);
  }
  const flat = path.join(base, 'server.js');
  if (existsSync(flat)) return { serverJs: flat, cwd: base, nodeBinary };
  const nested = path.join(base, path.basename(root), 'server.js');
  if (existsSync(nested)) return { serverJs: nested, cwd: path.dirname(nested), nodeBinary };
  throw new Error(`copied desktop server is missing under ${base}`);
}

function desktopRuntimeEnv(homeDir, port, token) {
  const env = {};
  for (const key of RUNTIME_ENV_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOSTNAME: HOST,
    PORT: String(port),
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    INKMARSHAL_HOME: homeDir,
    INKMARSHAL_RUNTIME: 'desktop',
    INKMARSHAL_DESKTOP_SESSION: token,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function fetchHealth(port, attempts = 60) {
  const url = `http://${HOST}:${port}/api/health`;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // server not up yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`/api/health did not become ready after ${attempts} attempts`);
}

function failIfChildExits(child) {
  return new Promise((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`copied desktop runtime exited before readiness (code ${code}, signal ${signal})`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  const resolved = resolveServerJs();
  const token = randomBytes(16).toString('hex');
  const expectedProof = createHash('sha256').update(token).digest('hex');
  const homeDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-packaged-smoke-'));
  const port = await freePort();

  log(`booting copied runtime on ${HOST}:${port} (home ${homeDir})`);
  const child = spawn(resolved.nodeBinary, [resolved.serverJs], {
    cwd: resolved.cwd,
    env: desktopRuntimeEnv(homeDir, port, token),
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let failed = null;
  try {
    const body = await Promise.race([fetchHealth(port), failIfChildExits(child)]);
    if (body?.ok !== true) throw new Error(`health payload not ok: ${JSON.stringify(body)}`);
    if (body.runtime !== 'desktop') throw new Error(`expected runtime "desktop", got "${body.runtime}"`);
    if (body.session !== expectedProof) throw new Error('health session proof did not match sha256(token)');
    log('PASS: copied resource + bundled Node + desktop readiness identity proof');
  } catch (err) {
    failed = err;
    log(`FAIL: ${err.message}`);
  } finally {
    await stopChild(child);
    rmSync(homeDir, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  log(`FAIL: ${err.stack || err.message}`);
  process.exit(1);
});
