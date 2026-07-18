import { homedir } from 'node:os';
import path from 'node:path';

export const LOCAL_DB_FILE = 'inkmarshal.db';
export const INKMARSHAL_HOME_DIR = '.inkmarshal';
export const INKMARSHAL_APP_DIR = 'app';

export interface LocalDbPathInput {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

function expandHomePath(raw: string, homeDir = homedir()): string {
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/')) return homeDir + raw.slice(1);
  return raw;
}

export function resolveInkmarshalHome(input: LocalDbPathInput = {}): string {
  const env = input.env ?? process.env;
  const home = input.homeDir ?? homedir();
  const override = env.INKMARSHAL_HOME?.trim();
  if (override) return path.resolve(expandHomePath(override, home));
  return path.join(home, INKMARSHAL_HOME_DIR);
}

export function resolveInkmarshalAppDir(input: LocalDbPathInput = {}): string {
  return path.join(resolveInkmarshalHome(input), INKMARSHAL_APP_DIR);
}

export function resolveLocalDbDir(input: LocalDbPathInput = {}): string {
  const env = input.env ?? process.env;
  const home = input.homeDir ?? homedir();
  const override = env.INKMARSHAL_DATA_DIR?.trim();
  if (override) {
    return path.resolve(expandHomePath(override, home));
  }

  return resolveInkmarshalAppDir(input);
}

export function resolveLocalDbPath(input: LocalDbPathInput = {}): string {
  return path.join(resolveLocalDbDir(input), LOCAL_DB_FILE);
}
