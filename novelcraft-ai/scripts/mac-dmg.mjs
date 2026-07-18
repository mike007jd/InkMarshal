import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DMGBUILD_VERSION = '1.6.7';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(scriptDir, 'dmgbuild-settings.py');
const toolRoot = path.join(
  homedir(),
  'Library',
  'Caches',
  'InkMarshal',
  'build-tools',
  `dmgbuild-${DMGBUILD_VERSION}`,
);
const toolPython = path.join(toolRoot, 'bin', 'python');
const toolExecutable = path.join(toolRoot, 'bin', 'dmgbuild');

function commandOutput(result) {
  return `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    shell: false,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
  });
  const output = commandOutput(result);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed${output ? `: ${output}` : ''}`);
  }
  return output;
}

function installedDmgbuildVersion() {
  if (!existsSync(toolPython)) return null;
  const result = spawnSync(
    toolPython,
    ['-c', 'from importlib.metadata import version; print(version("dmgbuild"))'],
    { encoding: 'utf8', shell: false },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function ensureDmgbuild() {
  if (process.platform !== 'darwin') {
    throw new Error('InkMarshal DMG packaging requires macOS.');
  }
  if (installedDmgbuildVersion() === DMGBUILD_VERSION && existsSync(toolExecutable)) {
    return toolExecutable;
  }

  const pythonVersion = run(
    'python3',
    ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'],
    { capture: true },
  );
  const [major, minor] = pythonVersion.split('.').map(Number);
  if (major < 3 || (major === 3 && minor < 10)) {
    throw new Error(`dmgbuild ${DMGBUILD_VERSION} requires Python >=3.10; found ${pythonVersion}.`);
  }

  rmSync(toolRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(toolRoot), { recursive: true });
  console.log(`[dmg] installing pinned dmgbuild ${DMGBUILD_VERSION} with Python ${pythonVersion}...`);
  run('python3', ['-m', 'venv', toolRoot]);
  run(toolPython, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--only-binary=:all:',
    `dmgbuild==${DMGBUILD_VERSION}`,
  ]);
  if (installedDmgbuildVersion() !== DMGBUILD_VERSION || !existsSync(toolExecutable)) {
    throw new Error(`Pinned dmgbuild ${DMGBUILD_VERSION} installation is incomplete: ${toolRoot}`);
  }
  return toolExecutable;
}

export function createMacDmg({ appPath, outputPath, volumeIconPath }) {
  if (!existsSync(appPath)) throw new Error(`DMG source app is missing: ${appPath}`);
  if (path.basename(appPath) !== 'InkMarshal.app') {
    throw new Error(`DMG source must be InkMarshal.app, found ${path.basename(appPath)}.`);
  }
  if (!existsSync(volumeIconPath)) throw new Error(`DMG volume icon is missing: ${volumeIconPath}`);
  if (!existsSync(settingsPath)) throw new Error(`DMG settings are missing: ${settingsPath}`);

  const dmgbuild = ensureDmgbuild();
  mkdirSync(path.dirname(outputPath), { recursive: true });
  rmSync(outputPath, { force: true });
  const temporaryPath = `${outputPath}.tmp.dmg`;
  rmSync(temporaryPath, { force: true });

  console.log('[dmg] creating headless Finder layout with dmgbuild...');
  run(dmgbuild, [
    '-s', settingsPath,
    '-D', `app_path=${appPath}`,
    '-D', `volume_icon=${volumeIconPath}`,
    'InkMarshal',
    temporaryPath,
  ]);
  if (!existsSync(temporaryPath)) {
    throw new Error(`dmgbuild did not produce ${temporaryPath}`);
  }
  renameSync(temporaryPath, outputPath);
  run('hdiutil', ['verify', outputPath]);
  console.log(`[dmg] wrote ${outputPath}`);
}
