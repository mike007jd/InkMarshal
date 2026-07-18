#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertInsideOrEqual,
  resolveInkmarshalAppDir,
  resolveInkmarshalHome,
} from './inkmarshal-local-paths.mjs';

export const RESET_CONFIRM_FLAG = '--confirm-delete-inkmarshal-local-state';
export const INCLUDE_WORKSPACE_FLAG = '--include-workspace-dot-state';

function defaultWorkspaceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function resetTargets({
  env = process.env,
  homeDir = homedir(),
  workspaceRoot = defaultWorkspaceRoot(),
  includeWorkspaceState = false,
} = {}) {
  const targets = [
    {
      label: 'canonical app data',
      path: resolveInkmarshalAppDir({ env, homeDir }),
    },
  ];

  if (includeWorkspaceState) {
    targets.push({
      label: 'relocated workspace dot-state',
      path: path.join(resolveInkmarshalHome({ env, homeDir }), 'workspaces', path.basename(workspaceRoot)),
    });
  }

  for (const target of targets) {
    assertInsideOrEqual(homeDir, target.path, target.label);
  }
  return targets;
}

export function runReset({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = homedir(),
  workspaceRoot = defaultWorkspaceRoot(),
  log = console.log,
  error = console.error,
  remove = rmSync,
} = {}) {
  if (!argv.includes(RESET_CONFIRM_FLAG)) {
    error(`Refusing to delete InkMarshal local state without ${RESET_CONFIRM_FLAG}.`);
    return 2;
  }

  const includeWorkspaceState = argv.includes(INCLUDE_WORKSPACE_FLAG);
  const targets = resetTargets({ env, homeDir, workspaceRoot, includeWorkspaceState });
  for (const target of targets) {
    if (!existsSync(target.path)) {
      log(`skip: ${target.label}: ${target.path}`);
      continue;
    }
    remove(target.path, { recursive: true, force: true });
    log(`removed: ${target.label}: ${target.path}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = runReset();
}
