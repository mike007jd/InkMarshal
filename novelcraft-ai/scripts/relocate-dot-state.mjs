#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveInkmarshalHome } from './inkmarshal-local-paths.mjs';

export const APPLY_FLAG = '--apply';

export const DOT_STATE_MANIFEST = [
  '.mcp.json',
  '.vercel',
  '.gitnexus',
  '.serena',
  '.playwright-mcp',
  '.claude',
  'novelcraft-ai/.env.local',
  'novelcraft-ai/.mcp.json',
  'novelcraft-ai/.vercel',
  'novelcraft-ai/.next',
  'novelcraft-ai/.cargo-tools',
  'novelcraft-ai/.agents',
  'novelcraft-ai/.claude',
  'novelcraft-ai/.worktrees',
  'novelcraft-ai/.trash',
];

function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function normalizeRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('Dot-state path must be a non-empty relative path');
  }
  const normalized = relPath.replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe dot-state path: ${relPath}`);
  }
  const forbidden = new Set(['.git', '.github', '.gitignore', '.env.example', '.node-version']);
  if (forbidden.has(normalized) || normalized.startsWith('.git/') || normalized.startsWith('.github/')) {
    throw new Error(`Refusing to relocate repository contract path: ${relPath}`);
  }
  return normalized;
}

function trackedFiles(repoRoot) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split('\0').filter(Boolean));
}

function pathTouchesTracked(relPath, tracked) {
  return tracked.has(relPath) || [...tracked].some(file => file.startsWith(`${relPath}/`));
}

function symlinkKind(targetPath) {
  try {
    return lstatSync(targetPath).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'file';
  }
}

function isExpectedSymlink(sourcePath, targetPath) {
  try {
    const stat = lstatSync(sourcePath);
    if (!stat.isSymbolicLink()) return false;
    const raw = readlinkSync(sourcePath);
    const resolved = path.resolve(path.dirname(sourcePath), raw);
    return resolved === path.resolve(targetPath);
  } catch {
    return false;
  }
}

function lstatExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function relocationPlan({
  repoRoot = defaultRepoRoot(),
  env = process.env,
  homeDir,
  manifest = DOT_STATE_MANIFEST,
  tracked = trackedFiles(repoRoot),
} = {}) {
  const workspaceStateRoot = path.join(
    resolveInkmarshalHome({ env, homeDir }),
    'workspaces',
    path.basename(repoRoot),
  );

  return manifest.map(rawRelPath => {
    const relPath = normalizeRelPath(rawRelPath);
    const sourcePath = path.join(repoRoot, relPath);
    const targetPath = path.join(workspaceStateRoot, relPath);
    if (pathTouchesTracked(relPath, tracked)) {
      return { relPath, sourcePath, targetPath, action: 'skip-tracked' };
    }
    if (isExpectedSymlink(sourcePath, targetPath)) {
      return { relPath, sourcePath, targetPath, action: 'already-linked' };
    }
    const sourceExists = lstatExists(sourcePath);
    const targetExists = existsSync(targetPath);
    if (sourceExists && targetExists) {
      return { relPath, sourcePath, targetPath, action: 'conflict' };
    }
    if (sourceExists) {
      return { relPath, sourcePath, targetPath, action: 'move-and-link' };
    }
    if (targetExists) {
      return { relPath, sourcePath, targetPath, action: 'link-existing-target' };
    }
    return { relPath, sourcePath, targetPath, action: 'missing' };
  });
}

export function applyRelocation(plan, { log = console.log } = {}) {
  let conflicts = 0;
  for (const item of plan) {
    if (item.action === 'conflict') {
      conflicts += 1;
      log(`conflict: ${item.relPath}: source and target both exist`);
      continue;
    }
    if (item.action === 'move-and-link') {
      mkdirSync(path.dirname(item.targetPath), { recursive: true });
      renameSync(item.sourcePath, item.targetPath);
      symlinkSync(item.targetPath, item.sourcePath, symlinkKind(item.targetPath));
      log(`moved: ${item.relPath} -> ${item.targetPath}`);
      continue;
    }
    if (item.action === 'link-existing-target') {
      mkdirSync(path.dirname(item.sourcePath), { recursive: true });
      symlinkSync(item.targetPath, item.sourcePath, symlinkKind(item.targetPath));
      log(`linked: ${item.relPath} -> ${item.targetPath}`);
      continue;
    }
    log(`${item.action}: ${item.relPath}`);
  }
  return conflicts === 0 ? 0 : 1;
}

export function runRelocate({
  argv = process.argv.slice(2),
  repoRoot = defaultRepoRoot(),
  env = process.env,
  homeDir,
  log = console.log,
} = {}) {
  const plan = relocationPlan({ repoRoot, env, homeDir });
  if (!argv.includes(APPLY_FLAG)) {
    for (const item of plan) log(`${item.action}: ${item.relPath} -> ${item.targetPath}`);
    log(`dry-run only; pass ${APPLY_FLAG} to move and link local dot-state.`);
    return plan.some(item => item.action === 'conflict') ? 1 : 0;
  }
  return applyRelocation(plan, { log });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = runRelocate();
}
