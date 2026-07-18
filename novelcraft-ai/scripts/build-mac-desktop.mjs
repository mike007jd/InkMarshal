#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createMacDmg } from './mac-dmg.mjs';

const MAC_TARGET = 'aarch64-apple-darwin';
const root = process.cwd();

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, shell: false, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error(`desktop:build currently requires macOS arm64; found ${process.platform}/${process.arch}.`);
}

const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const tauriConfig = JSON.parse(readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
if (!packageJson.version || packageJson.version !== tauriConfig.version) {
  throw new Error(
    `package.json and tauri.conf.json versions must match (${packageJson.version} vs ${tauriConfig.version}).`,
  );
}

console.log('[desktop:build] building clean unsigned InkMarshal.app...');
run('pnpm', ['exec', 'tauri', 'build', '--no-sign', '--target', MAC_TARGET, '--bundles', 'app']);

const bundleRoot = path.join(root, 'src-tauri', 'target', MAC_TARGET, 'release', 'bundle');
const appPath = path.join(bundleRoot, 'macos', 'InkMarshal.app');
if (!existsSync(appPath)) throw new Error(`InkMarshal.app was not produced: ${appPath}`);
const dmgPath = path.join(
  bundleRoot,
  'dmg',
  `${tauriConfig.productName}_${tauriConfig.version}_aarch64.dmg`,
);
createMacDmg({
  appPath,
  outputPath: dmgPath,
  volumeIconPath: path.join(root, 'src-tauri', 'icons', 'icon.icns'),
});

console.log('[desktop:build] Local desktop artifacts ready:');
console.log(`  ${appPath}`);
console.log(`  ${dmgPath}`);
