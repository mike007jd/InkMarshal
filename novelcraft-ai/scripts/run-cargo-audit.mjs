#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL_VERSION = '0.22.2';
const TOOL_ROOT = join(process.cwd(), '.cargo-tools');
const LOCAL_BIN = join(TOOL_ROOT, 'bin', process.platform === 'win32' ? 'cargo-audit.exe' : 'cargo-audit');
const AUDIT_ARGS = ['-f', 'src-tauri/Cargo.lock'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function canUseGlobalCargoAudit() {
  const result = spawnSync('cargo', ['audit', '--version'], {
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

if (canUseGlobalCargoAudit()) {
  run('cargo', ['audit', ...AUDIT_ARGS]);
  process.exit(0);
}

if (!existsSync(LOCAL_BIN)) {
  console.log(`[audit:rust] cargo-audit not found; installing cargo-audit ${TOOL_VERSION} into ${TOOL_ROOT}`);
  run('cargo', ['install', 'cargo-audit', '--version', TOOL_VERSION, '--locked', '--root', TOOL_ROOT]);
}

run(LOCAL_BIN, ['audit', ...AUDIT_ARGS]);
