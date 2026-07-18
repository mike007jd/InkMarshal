import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveInkmarshalHome } from './inkmarshal-local-paths.mjs';

export const APPLE_RELEASE_ENV_KEYS = new Set([
  'APPLE_SIGNING_IDENTITY',
  'APPLE_TEAM_ID',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_PASSWORD',
]);

export function defaultAppleReleaseEnvPath({ env = process.env, homeDir = homedir() } = {}) {
  return path.join(resolveInkmarshalHome({ env, homeDir }), 'release', 'apple.env');
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    out[key] = unquote(normalized.slice(eq + 1));
  }
  return out;
}

function assertStrictPermissions(filePath) {
  if (process.platform === 'win32') return;
  const mode = statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${filePath} must not be readable, writable, or executable by group/other; run chmod 600.`);
  }
}

export function loadAppleReleaseEnv({
  env = process.env,
  homeDir = homedir(),
  filePath = defaultAppleReleaseEnvPath({ env, homeDir }),
} = {}) {
  if (!existsSync(filePath)) return { filePath, loaded: [], skipped: [] };
  assertStrictPermissions(filePath);
  const parsed = parseEnvFile(readFileSync(filePath, 'utf8'));
  const loaded = [];
  const skipped = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!APPLE_RELEASE_ENV_KEYS.has(key)) continue;
    if (env[key]?.trim()) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    loaded.push(key);
  }
  return { filePath, loaded, skipped };
}
