// E2E-01 — desktop smoke coverage matrix (single source of truth).
//
// The audit (P1-4 / M1) calls for automating the highest-risk manual smoke
// paths that currently live only in docs/RELEASE_SMOKE_CHECKLIST.md. Full GUI
// coverage needs a packaged app driven by WebDriver on macOS, which is gated on
// the desktop CI runner decision (ticket CI-01). This matrix enumerates every
// risk path and its automation status so coverage is EXPLICIT — a path is never
// silently dropped; a gated path is visibly gated, not missing.

export type SmokeStatus =
  // Runs today in vitest (this repo's `pnpm test`): boot invariants that need
  // no GUI — Next request handling + local SQLite open/migrate.
  | 'automated-unit'
  // Runs in CI by spawning the built Next standalone server and probing it
  // (e2e/desktop-smoke/run-standalone-smoke.mjs). Needs a desktop-web build.
  | 'automated-ci-boot'
  // Needs the packaged Tauri app driven on macOS (WebView + Rust IPC + engine
  // subprocess). Gated on the CI-01 macOS runner; stays in the manual checklist
  // until then.
  | 'gated-macos';

export interface SmokePath {
  id: string;
  title: string;
  status: SmokeStatus;
  /** Manual-checklist section (docs/RELEASE_SMOKE_CHECKLIST.md) this covers. */
  checklist: string;
  /** For gated paths: what runtime is required to automate it. */
  requires?: string;
}

export const DESKTOP_SMOKE_MATRIX: SmokePath[] = [
  {
    id: 'boot-sqlite',
    title: 'Local SQLite opens and migrates to the schema-18 epoch on first boot',
    status: 'automated-unit',
    checklist: '安装与首启',
  },
  {
    id: 'health-probe',
    title: 'Desktop readiness probe (/api/health) returns the session identity proof',
    status: 'automated-unit',
    checklist: '安装与首启',
  },
  {
    id: 'standalone-boot',
    title: 'Next standalone server boots and answers /api/health over loopback',
    status: 'automated-ci-boot',
    checklist: '安装与首启',
  },
  {
    id: 'first-run-wizard',
    title: 'First-run wizard completes and lands on the workspace',
    status: 'gated-macos',
    checklist: '安装与首启',
    requires: 'macos-webdriver',
  },
  {
    id: 'model-download-use-engine',
    title: 'Download a model → Use → engine starts',
    status: 'gated-macos',
    checklist: '模型链路（核心路径）',
    requires: 'macos-webdriver + bundled engine',
  },
  {
    id: 'first-chapter',
    title: 'New novel → generate one full chapter',
    status: 'gated-macos',
    checklist: '模型链路（核心路径）',
    requires: 'macos-webdriver + bundled engine',
  },
  {
    id: 'stop-continue-retry',
    title: 'Stop mid-generation, then continue / retry (cancelled run logged once)',
    status: 'gated-macos',
    checklist: '模型链路（核心路径）',
    requires: 'macos-webdriver + bundled engine',
  },
  {
    id: 'edit-save-restart',
    title: 'Edit a chapter, save, restart the app — content intact',
    status: 'gated-macos',
    checklist: '创作与数据',
    requires: 'macos-webdriver',
  },
  {
    id: 'backup-export',
    title: 'Backup/restore and the main export formats',
    status: 'gated-macos',
    checklist: '创作与数据',
    requires: 'macos-webdriver',
  },
  {
    id: 'force-quit-recovery',
    title: 'Force-quit then relaunch — no data loss, no migration error',
    status: 'gated-macos',
    checklist: '创作与数据',
    requires: 'macos-webdriver',
  },
];

/** High-risk manual-checklist sections that MUST each map to ≥1 matrix path so
 *  automation coverage can only grow, never silently regress. */
export const REQUIRED_CHECKLIST_SECTIONS = [
  '安装与首启',
  '模型链路（核心路径）',
  '创作与数据',
] as const;

export function smokeCountsByStatus(): Record<SmokeStatus, number> {
  const counts: Record<SmokeStatus, number> = {
    'automated-unit': 0,
    'automated-ci-boot': 0,
    'gated-macos': 0,
  };
  for (const path of DESKTOP_SMOKE_MATRIX) counts[path.status] += 1;
  return counts;
}
