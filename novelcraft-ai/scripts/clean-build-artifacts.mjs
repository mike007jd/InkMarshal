import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assertInsideRoot(targetPath) {
  const resolved = path.resolve(targetPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to remove path outside project root: ${resolved}`);
  }
  return resolved;
}

function removePath(targetPath) {
  const resolved = assertInsideRoot(targetPath);
  if (!existsSync(resolved)) return;
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`[clean] removed ${path.relative(root, resolved)}`);
}

function emptyGeneratedResourceDir(targetPath) {
  const resolved = assertInsideRoot(targetPath);
  if (!existsSync(resolved)) return;
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    if (entry.name === '.gitignore' || entry.name === '.gitkeep') continue;
    removePath(path.join(resolved, entry.name));
  }
}

for (const relativePath of [
  '.next',
  '.turbo',
  'out',
  'dist',
  'build',
  'coverage',
  '.playwright-cli',
  'output/playwright',
  'playwright-report',
  'test-results',
  'desktop-server',
  'desktop-dist',
  'tsconfig.tsbuildinfo',
  'src-tauri/target',
  'src-tauri/engines/mlx-server/.build',
  'src-tauri/engines/mlx-server/.swiftpm',
]) {
  removePath(path.join(root, relativePath));
}

emptyGeneratedResourceDir(path.join(root, 'src-tauri', 'resources', 'next-server'));
emptyGeneratedResourceDir(path.join(root, 'src-tauri', 'resources', 'node'));
