// E2E-01 — coverage drift guard for the desktop smoke matrix.
//
// Ensures automation coverage is explicit and can only grow: every high-risk
// manual-checklist section maps to at least one matrix path, the manual
// checklist still lists the gated paths, and the runnable pieces stay wired.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_SMOKE_MATRIX,
  REQUIRED_CHECKLIST_SECTIONS,
  smokeCountsByStatus,
} from '@/e2e/desktop-smoke/smoke-matrix';

const root = process.cwd();

describe('desktop smoke matrix', () => {
  it('covers every required high-risk checklist section', () => {
    const covered = new Set(DESKTOP_SMOKE_MATRIX.map(p => p.checklist));
    for (const section of REQUIRED_CHECKLIST_SECTIONS) {
      expect(covered.has(section)).toBe(true);
    }
  });

  it('has unique ids and gated paths declare what runtime they require', () => {
    const ids = DESKTOP_SMOKE_MATRIX.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of DESKTOP_SMOKE_MATRIX) {
      if (p.status === 'gated-macos') expect(p.requires, p.id).toBeTruthy();
    }
  });

  it('keeps at least the boot invariants automated in unit tests', () => {
    const counts = smokeCountsByStatus();
    // boot-sqlite + health-probe are covered by boot-smoke.test.ts today.
    expect(counts['automated-unit']).toBeGreaterThanOrEqual(2);
    expect(DESKTOP_SMOKE_MATRIX.some(p => p.id === 'boot-sqlite' && p.status === 'automated-unit')).toBe(true);
    expect(DESKTOP_SMOKE_MATRIX.some(p => p.id === 'health-probe' && p.status === 'automated-unit')).toBe(true);
  });

  it('the required checklist sections still exist in the manual checklist doc', () => {
    const checklist = readFileSync(path.join(root, 'docs/RELEASE_SMOKE_CHECKLIST.md'), 'utf8');
    for (const section of REQUIRED_CHECKLIST_SECTIONS) {
      expect(checklist).toContain(section);
    }
  });

  it('the automated-unit boot smoke and the ci-boot runner are present', () => {
    expect(existsSync(path.join(root, 'e2e/desktop-smoke/boot-smoke.test.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'e2e/desktop-smoke/run-standalone-smoke.mjs'))).toBe(true);
  });

  it('boots the copied desktop resource with the bundled Node runtime and cannot skip', () => {
    const runner = readFileSync(
      path.join(root, 'e2e/desktop-smoke/run-standalone-smoke.mjs'),
      'utf8',
    );

    expect(runner).toContain("'src-tauri', 'resources', 'next-server'");
    expect(runner).toContain("'resources',\n    'node'");
    expect(runner).not.toContain("'.next', 'standalone'");
    expect(runner).not.toContain('process.execPath');
    expect(runner).not.toContain('INKMARSHAL_DATA_DIR');
    expect(runner).not.toContain('SKIP:');
  });
});
