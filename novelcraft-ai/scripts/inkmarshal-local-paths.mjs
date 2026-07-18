import { homedir } from 'node:os';
import path from 'node:path';

export const INKMARSHAL_HOME_DIR = '.inkmarshal';
export const INKMARSHAL_APP_DIR = 'app';

export function expandHomePath(raw, homeDir = homedir()) {
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/')) return homeDir + raw.slice(1);
  return raw;
}

export function resolveInkmarshalHome({ env = process.env, homeDir = homedir() } = {}) {
  const override = env.INKMARSHAL_HOME?.trim();
  if (override) return path.resolve(expandHomePath(override, homeDir));
  return path.join(homeDir, INKMARSHAL_HOME_DIR);
}

export function resolveInkmarshalAppDir(options = {}) {
  return path.join(resolveInkmarshalHome(options), INKMARSHAL_APP_DIR);
}

export function isInsideOrEqual(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  const rel = path.relative(parentResolved, childResolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertInsideOrEqual(parent, child, label = 'path') {
  if (!isInsideOrEqual(parent, child)) {
    throw new Error(`${label} must stay inside ${parent}: ${child}`);
  }
}
