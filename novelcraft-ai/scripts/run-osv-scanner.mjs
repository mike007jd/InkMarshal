#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL_VERSION = '2.3.8';
const RELEASE_BASE = `https://github.com/google/osv-scanner/releases/download/v${TOOL_VERSION}`;
const TARGETS = {
  'darwin:arm64': 'osv-scanner_darwin_arm64',
  'darwin:x64': 'osv-scanner_darwin_amd64',
  'linux:arm64': 'osv-scanner_linux_arm64',
  'linux:x64': 'osv-scanner_linux_amd64',
  'win32:arm64': 'osv-scanner_windows_arm64.exe',
  'win32:x64': 'osv-scanner_windows_amd64.exe',
};

const asset = TARGETS[`${process.platform}:${process.arch}`];
if (!asset) {
  throw new Error(`OSV-Scanner ${TOOL_VERSION} has no pinned binary for ${process.platform}/${process.arch}`);
}

const toolDir = join(process.cwd(), '.security-tools', 'osv-scanner', `v${TOOL_VERSION}`);
const binary = join(toolDir, asset);

if (!existsSync(binary)) {
  mkdirSync(toolDir, { recursive: true });
  const [checksumResponse, binaryResponse] = await Promise.all([
    fetch(`${RELEASE_BASE}/osv-scanner_SHA256SUMS`),
    fetch(`${RELEASE_BASE}/${asset}`),
  ]);
  if (!checksumResponse.ok || !binaryResponse.ok) {
    throw new Error(
      `Unable to download OSV-Scanner ${TOOL_VERSION}: checksums=${checksumResponse.status}, binary=${binaryResponse.status}`,
    );
  }
  const checksumText = await checksumResponse.text();
  const expected = checksumText
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0]?.toLowerCase();
  if (!expected) throw new Error(`No SHA-256 entry for ${asset} in osv-scanner_SHA256SUMS`);

  const bytes = Buffer.from(await binaryResponse.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`OSV-Scanner ${asset} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }

  const temporary = `${binary}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o755 });
    renameSync(temporary, binary);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (process.platform !== 'win32') chmodSync(binary, 0o755);
}

const result = spawnSync(binary, ['scan', 'source', '--lockfile=pnpm-lock.yaml'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
