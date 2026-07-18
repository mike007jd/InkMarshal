import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INKMARSHAL_APP_DIR,
  INKMARSHAL_HOME_DIR,
  resolveInkmarshalAppDir,
  resolveInkmarshalHome,
} from './inkmarshal-local-paths.mjs';
import {
  RESET_CONFIRM_FLAG,
  resetTargets,
  runReset,
} from './reset-inkmarshal-local-state.mjs';
import {
  applyRelocation,
  relocationPlan,
} from './relocate-dot-state.mjs';
import {
  loadAppleReleaseEnv,
  parseEnvFile,
} from './release-env.mjs';

const cleanup = [];

function tempRoot(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `inkmarshal-${label}-`));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

describe('InkMarshal local path policy', () => {
  it('resolves the canonical home and app directories', () => {
    expect(resolveInkmarshalHome({ env: {}, homeDir: '/Users/tester' }))
      .toBe(path.join('/Users/tester', INKMARSHAL_HOME_DIR));
    expect(resolveInkmarshalAppDir({ env: {}, homeDir: '/Users/tester' }))
      .toBe(path.join('/Users/tester', INKMARSHAL_HOME_DIR, INKMARSHAL_APP_DIR));
    expect(resolveInkmarshalHome({ env: { INKMARSHAL_HOME: '~/InkHome' }, homeDir: '/Users/tester' }))
      .toBe(path.resolve('/Users/tester/InkHome'));
  });

});

describe('reset-inkmarshal-local-state', () => {
  it('refuses to delete without the explicit confirmation flag', () => {
    const homeDir = tempRoot('reset-home');
    const appDir = resolveInkmarshalAppDir({ env: {}, homeDir });
    mkdirSync(appDir, { recursive: true });
    const logs = [];
    const code = runReset({
      argv: [],
      homeDir,
      log: message => logs.push(message),
      error: message => logs.push(message),
    });
    expect(code).toBe(2);
    expect(statSync(appDir).isDirectory()).toBe(true);
    expect(logs.join('\n')).toContain(RESET_CONFIRM_FLAG);
  });

  it('removes only known local-state targets when confirmed', () => {
    const homeDir = tempRoot('reset-home');
    const appDir = resolveInkmarshalAppDir({ env: {}, homeDir });
    mkdirSync(appDir, { recursive: true });

    expect(resetTargets({ env: {}, homeDir }).map(t => t.path)).toEqual([appDir]);
    const code = runReset({
      argv: [RESET_CONFIRM_FLAG],
      homeDir,
      log: () => {},
      error: () => {},
    });
    expect(code).toBe(0);
    expect(() => statSync(appDir)).toThrow();
  });
});

describe('relocate-dot-state', () => {
  it('moves untracked dot-state into ~/.inkmarshal/workspaces and links it back', () => {
    const root = tempRoot('repo');
    const homeDir = tempRoot('home');
    const source = path.join(root, '.mcp.json');
    writeFileSync(source, '{"mcpServers":{}}\n');

    const plan = relocationPlan({
      repoRoot: root,
      env: {},
      homeDir,
      manifest: ['.mcp.json'],
      tracked: new Set(),
    });
    expect(plan[0].action).toBe('move-and-link');
    expect(applyRelocation(plan, { log: () => {} })).toBe(0);
    expect(readFileSync(plan[0].targetPath, 'utf8')).toContain('mcpServers');
    expect(lstatSync(source).isSymbolicLink()).toBe(true);

    const again = relocationPlan({
      repoRoot: root,
      env: {},
      homeDir,
      manifest: ['.mcp.json'],
      tracked: new Set(),
    });
    expect(again[0].action).toBe('already-linked');
  });

  it('does not relocate tracked repository contract files', () => {
    const root = tempRoot('repo');
    const homeDir = tempRoot('home');
    const plan = relocationPlan({
      repoRoot: root,
      env: {},
      homeDir,
      manifest: ['novelcraft-ai/.env.example'],
      tracked: new Set(['novelcraft-ai/.env.example']),
    });
    expect(plan[0].action).toBe('skip-tracked');
  });
});

describe('release-env', () => {
  it('parses export-style Apple release env files', () => {
    expect(parseEnvFile('export APPLE_ID="me@example.com"\nAPPLE_TEAM_ID=TEAM\n')).toEqual({
      APPLE_ID: 'me@example.com',
      APPLE_TEAM_ID: 'TEAM',
    });
  });

  it('loads only missing allowlisted Apple release variables', () => {
    const homeDir = tempRoot('release-home');
    const filePath = path.join(homeDir, '.inkmarshal', 'release', 'apple.env');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'APPLE_ID=from-file@example.com\nOPENAI_API_KEY=ignored\nAPPLE_TEAM_ID=TEAM\n');
    if (process.platform !== 'win32') {
      rmSync(filePath, { force: true });
      writeFileSync(filePath, 'APPLE_ID=from-file@example.com\nOPENAI_API_KEY=ignored\nAPPLE_TEAM_ID=TEAM\n', {
        mode: 0o600,
      });
    }
    const env = { APPLE_ID: 'existing@example.com' };
    const result = loadAppleReleaseEnv({ env, homeDir });
    expect(result.loaded).toEqual(['APPLE_TEAM_ID']);
    expect(result.skipped).toEqual(['APPLE_ID']);
    expect(env).toMatchObject({
      APPLE_ID: 'existing@example.com',
      APPLE_TEAM_ID: 'TEAM',
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
