#!/usr/bin/env node
// E2E-01 — automated-ci-boot desktop smoke.
//
// Boots the copied Tauri Next resource with the bundled Node executable exactly
// as the packaged runtime does, against a throwaway INKMARSHAL_HOME, then probes
// readiness and executes an authenticated create → backup → restore HTTP flow.
//
// Run AFTER `pnpm build:desktop-web`. Missing copied resources are always a hard
// failure so a broken runtime cannot enter a packaged app.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function resolveServerActionId(runtime, exportedName) {
  const manifestPath = path.join(runtime.cwd, '.next', 'server', 'server-reference-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`copied server action manifest is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const match = Object.entries(manifest.node ?? {})
    .find(([, value]) => value?.exportedName === exportedName);
  if (!match) throw new Error(`copied runtime has no ${exportedName} Server Action`);
  return match[0];
}

function baseRuntimeEnv(homeDir, port) {
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
  };
}

function desktopRuntimeEnv(homeDir, port, token) {
  return {
    ...baseRuntimeEnv(homeDir, port),
    INKMARSHAL_RUNTIME: 'desktop',
    INKMARSHAL_DESKTOP_SESSION: token,
  };
}

function productionWebRuntimeEnv(homeDir, port) {
  // Intentionally omit INKMARSHAL_RUNTIME / DESKTOP_SESSION so the process is
  // a production non-desktop (web) runtime.
  return baseRuntimeEnv(homeDir, port);
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

async function expectStatus(response, expected, label) {
  if (response.status === expected) return response;
  const detail = await response.text().catch(() => '');
  throw new Error(`${label}: expected HTTP ${expected}, got ${response.status}: ${detail.slice(0, 500)}`);
}

function decodeServerActionResult(payload, label) {
  const records = new Map();
  for (const line of payload.split(/\r?\n/)) {
    const match = /^(\d+):(.*)$/s.exec(line);
    if (!match) continue;
    try {
      records.set(match[1], JSON.parse(match[2]));
    } catch {
      // Other RSC records are irrelevant to the action return value.
    }
  }
  const rootRecord = records.get('0');
  const resultRef = typeof rootRecord?.a === 'string'
    ? /^\$@(\d+)$/.exec(rootRecord.a)?.[1]
    : null;
  if (!resultRef || !records.has(resultRef)) {
    throw new Error(`${label}: copied runtime returned an unreadable Server Action payload`);
  }
  return records.get(resultRef);
}

async function callServerAction(base, token, actionId, args, label) {
  const response = await expectStatus(
    await fetch(`${base}/desktop-studio`, {
      method: 'POST',
      headers: {
        accept: 'text/x-component',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': actionId,
        'x-inkmarshal-desktop-session': token,
      },
      body: JSON.stringify(args),
    }),
    200,
    label,
  );
  return decodeServerActionResult(await response.text(), label);
}

function stageCopiedRuntimeFixture(homeDir, fixtureDir, basename) {
  const sessionToken = createHash('sha256')
    .update(`copied-runtime-import:${basename}`)
    .digest('hex');
  const extension = path.extname(basename).slice(1);
  const sessionDir = path.join(homeDir, 'app', 'import-sessions', sessionToken);
  mkdirSync(sessionDir, { recursive: true });
  const stagedName = `source.${extension}`;
  copyFileSync(path.join(fixtureDir, basename), path.join(sessionDir, stagedName));
  writeFileSync(
    path.join(sessionDir, 'staged.json'),
    JSON.stringify({
      basename,
      stagedName,
      createdAtUnix: Math.floor(Date.now() / 1_000),
    }),
    'utf8',
  );
  return sessionToken;
}

async function runCopiedRuntimeImportMatrix(
  port,
  token,
  homeDir,
  nodeBinary,
  openImportSessionActionId,
  confirmImportSessionActionId,
) {
  const base = `http://${HOST}:${port}`;
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-packaged-import-fixtures-'));
  try {
    execFileSync(
      nodeBinary,
      ['e2e/desktop-smoke/generate-import-size-fixtures.mjs', fixtureDir],
      { cwd: root, stdio: 'ignore' },
    );
    for (const sizeMiB of [2, 10, 25]) {
      for (const extension of ['txt', 'md', 'docx']) {
        const basename = `${sizeMiB}MiB.${extension}`;
        const sessionToken = stageCopiedRuntimeFixture(homeDir, fixtureDir, basename);
        const opened = await callServerAction(
          base,
          token,
          openImportSessionActionId,
          [{ token: sessionToken, basename }],
          `open ${basename} through copied Server Action runtime`,
        );
        if (
          opened?.sessionToken !== sessionToken
          || !Array.isArray(opened?.chapters)
          || opened.chapters.length !== 1
          || opened.chapters[0]?.content !== undefined
          || JSON.stringify(opened).length >= 500_000
        ) {
          throw new Error(`open ${basename} returned an invalid bounded preview`);
        }
        const confirmed = await callServerAction(
          base,
          token,
          confirmImportSessionActionId,
          [{
            sessionToken,
            mode: 'new',
            novelTitle: `Packaged Import ${basename}`,
            chapters: opened.chapters.map(chapter => ({
              title: chapter.title,
              parts: chapter.parts,
            })),
          }],
          `confirm ${basename} through copied Server Action runtime`,
        );
        if (
          typeof confirmed?.novelId !== 'string'
          || confirmed.importedChapters !== 1
          || confirmed.skippedChapters !== 0
        ) {
          throw new Error(`confirm ${basename} returned an invalid result`);
        }
        const chapters = await expectStatus(
          await fetch(
            `${base}/api/novels/${encodeURIComponent(confirmed.novelId)}/chapters?lite=1`,
            { headers: { 'x-inkmarshal-desktop-session': token } },
          ),
          200,
          `read back ${basename} imported chapter`,
        ).then(response => response.json());
        if (
          !Array.isArray(chapters)
          || chapters.length !== 1
          || chapters[0]?.processingStatus !== 'complete'
        ) {
          throw new Error(`read back ${basename} did not prove one complete chapter`);
        }
      }
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

async function runAuthenticatedUserFlow(port, token, createConversationActionId) {
  const base = `http://${HOST}:${port}`;
  const authHeaders = {
    'x-inkmarshal-desktop-session': token,
  };

  await expectStatus(
    await fetch(`${base}/api/novels`),
    404,
    'unauthenticated local-data request',
  );

  const studioResponse = await expectStatus(
    await fetch(`${base}/desktop-studio`, { headers: authHeaders }),
    200,
    'render desktop studio through copied Server Action runtime',
  );
  const studioHtml = await studioResponse.text();
  if (!studioHtml.includes('InkMarshal')) {
    throw new Error('desktop studio response did not contain the application shell');
  }

  const createdResponse = await expectStatus(
    await fetch(`${base}/api/novels`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Packaged Smoke Novel',
        genre: 'smoke',
        targetWords: 1_000,
        creationMode: 'blank',
        firstChapterTitle: 'Opening',
      }),
    }),
    201,
    'create blank novel',
  );
  const created = await createdResponse.json();
  if (typeof created?.id !== 'string' || !created.id) {
    throw new Error('create blank novel returned no id');
  }

  const actionUrl = `${base}/novel/${encodeURIComponent(created.id)}`;
  const actionBody = JSON.stringify([
    created.id,
    {
      topic: 'plot',
      title: 'Server Action Smoke',
      parentMessageId: null,
    },
  ]);
  const actionHeaders = {
    accept: 'text/x-component',
    'content-type': 'text/plain;charset=UTF-8',
    'next-action': createConversationActionId,
  };

  for (const [label, extraHeaders] of [
    ['missing credential', {}],
    ['wrong credential', { 'x-inkmarshal-desktop-session': 'wrong-desktop-session-token-000000' }],
  ]) {
    await expectStatus(
      await fetch(actionUrl, {
        method: 'POST',
        headers: { ...actionHeaders, ...extraHeaders },
        body: actionBody,
      }),
      404,
      `direct Server Action with ${label}`,
    );
  }

  const beforeAction = await expectStatus(
    await fetch(`${base}/api/novels/${encodeURIComponent(created.id)}/conversations`, {
      headers: authHeaders,
    }),
    200,
    'list conversations before authorized action',
  );
  if ((await beforeAction.json()).length !== 0) {
    throw new Error('unauthorized direct Server Action mutated SQLite');
  }

  await expectStatus(
    await fetch(actionUrl, {
      method: 'POST',
      headers: { ...actionHeaders, ...authHeaders },
      body: actionBody,
    }),
    200,
    'authorized direct Server Action',
  );
  const afterAction = await expectStatus(
    await fetch(`${base}/api/novels/${encodeURIComponent(created.id)}/conversations`, {
      headers: authHeaders,
    }),
    200,
    'list conversations after authorized action',
  );
  const conversations = await afterAction.json();
  if (
    !Array.isArray(conversations)
    || conversations.length !== 1
    || conversations[0]?.title !== 'Server Action Smoke'
  ) {
    throw new Error(`authorized direct Server Action did not create exactly one conversation: ${JSON.stringify(conversations)}`);
  }

  const backupResponse = await expectStatus(
    await fetch(`${base}/api/novels/${encodeURIComponent(created.id)}/backup`, {
      method: 'POST',
      headers: authHeaders,
    }),
    200,
    'backup novel',
  );
  const backupBytes = new Uint8Array(await backupResponse.arrayBuffer());
  if (backupBytes.byteLength < 100) {
    throw new Error(`backup novel returned an implausibly small package (${backupBytes.byteLength} bytes)`);
  }

  const restoredResponse = await expectStatus(
    await fetch(`${base}/api/backups/restore`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/vnd.inkmarshal.backup+zip',
      },
      body: backupBytes,
    }),
    200,
    'restore backup as copy',
  );
  const restored = await restoredResponse.json();
  if (restored?.verified !== true || typeof restored?.novelId !== 'string') {
    throw new Error('restore response did not prove verification and a new novel id');
  }
  if (restored.novelId === created.id) {
    throw new Error('restore reused the source novel id instead of creating a copy');
  }

  const novelsResponse = await expectStatus(
    await fetch(`${base}/api/novels`, { headers: authHeaders }),
    200,
    'list novels after restore',
  );
  const novels = await novelsResponse.json();
  if (!Array.isArray(novels) || novels.length !== 2) {
    throw new Error(`expected source + restored copy, got ${JSON.stringify(novels)}`);
  }
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

/**
 * Production non-desktop regression: a real action id POSTed to `/` without
 * desktop credentials must 404 and must not create/mutate SQLite.
 */
async function runProductionWebServerActionFailClosed(resolved, createConversationActionId) {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-web-action-smoke-'));
  const port = await freePort();
  const dbPath = path.join(homeDir, 'app', 'inkmarshal.db');
  const base = `http://${HOST}:${port}`;

  log(`booting production web runtime on ${HOST}:${port} (home ${homeDir})`);
  const child = spawn(resolved.nodeBinary, [resolved.serverJs], {
    cwd: resolved.cwd,
    env: productionWebRuntimeEnv(homeDir, port),
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  try {
    const body = await Promise.race([fetchHealth(port), failIfChildExits(child)]);
    if (body?.ok !== true) throw new Error(`web health payload not ok: ${JSON.stringify(body)}`);
    if (body.runtime !== 'web') throw new Error(`expected runtime "web", got "${body.runtime}"`);

    const rootResponse = await fetch(`${base}/`, { redirect: 'manual' });
    if (rootResponse.status < 300 || rootResponse.status >= 400) {
      throw new Error(`ordinary public root: expected redirect, got HTTP ${rootResponse.status}`);
    }

    if (existsSync(dbPath)) {
      throw new Error('production web runtime created SQLite before the Action probe');
    }

    await expectStatus(
      await fetch(`${base}/`, {
        method: 'POST',
        headers: {
          accept: 'text/x-component',
          'content-type': 'text/plain;charset=UTF-8',
          'next-action': createConversationActionId,
        },
        body: JSON.stringify([
          'smoke-novel-id',
          {
            topic: 'plot',
            title: 'Must Not Persist',
            parentMessageId: null,
          },
        ]),
      }),
      404,
      'production web root-path Next-Action',
    );

    if (existsSync(dbPath)) {
      throw new Error('production web root-path Next-Action mutated SQLite');
    }
  } finally {
    await stopChild(child);
    rmSync(homeDir, { recursive: true, force: true });
  }
}

async function main() {
  const resolved = resolveServerJs();
  const createConversationActionId = resolveServerActionId(resolved, 'createConversation');
  const openImportSessionActionId = resolveServerActionId(resolved, 'openImportSessionAction');
  const confirmImportSessionActionId = resolveServerActionId(resolved, 'confirmImportSessionAction');
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
    await runAuthenticatedUserFlow(port, token, createConversationActionId);
    await runCopiedRuntimeImportMatrix(
      port,
      token,
      homeDir,
      resolved.nodeBinary,
      openImportSessionActionId,
      confirmImportSessionActionId,
    );
    await stopChild(child);
    await runProductionWebServerActionFailClosed(resolved, createConversationActionId);
    log('PASS: copied runtime readiness + API/Action auth + create → backup → restore + 2/10/25 MiB TXT/MD/DOCX import + production web Next-Action fail-closed');
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
