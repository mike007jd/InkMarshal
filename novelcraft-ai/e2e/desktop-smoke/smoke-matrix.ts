// Desktop smoke coverage matrix. Required high-risk checklist sections stay
// explicitly represented as automated or packaged-app coverage.

export type SmokeStatus =
  // Runs today in vitest (this repo's `pnpm test`): boot invariants that need
  // no GUI — Next request handling + local SQLite open/migrate.
  | 'automated-unit'
  // Runs in CI by spawning the built Next standalone server and probing it
  // (e2e/desktop-smoke/run-standalone-smoke.mjs). Needs a desktop-web build.
  | 'automated-ci-boot'
  // Needs the exact packaged Tauri app, WebView/Rust IPC, and where applicable
  // a real model/provider/network state. Remains manual until a reliable
  // packaged-app driver covers it.
  | 'manual-packaged-gui';

export interface SmokePath {
  id: string;
  title: string;
  status: SmokeStatus;
  /** Manual-checklist section (docs/RELEASE_SMOKE_CHECKLIST.md) this covers. */
  checklist: string;
  /** For manual paths: what runtime is required to automate it. */
  requires?: string;
}

export const DESKTOP_SMOKE_MATRIX: SmokePath[] = [
  {
    id: 'boot-sqlite',
    title: 'Local SQLite opens at the current schema on first boot',
    status: 'automated-unit',
    checklist: 'Install and first launch',
  },
  {
    id: 'health-probe',
    title: 'Desktop readiness probe (/api/health) returns the session identity proof',
    status: 'automated-unit',
    checklist: 'Install and first launch',
  },
  {
    id: 'standalone-boot',
    title: 'Next standalone server boots and answers /api/health over loopback',
    status: 'automated-ci-boot',
    checklist: 'Install and first launch',
  },
  {
    id: 'first-run-wizard',
    title: 'First-run wizard completes and lands on the workspace',
    status: 'manual-packaged-gui',
    checklist: 'Install and first launch',
    requires: 'macos-webdriver',
  },
  {
    id: 'model-download-use-engine',
    title: 'Download a model → Use → engine starts',
    status: 'manual-packaged-gui',
    checklist: 'Model path',
    requires: 'macos-webdriver + bundled engine',
  },
  {
    id: 'first-chapter',
    title: 'New novel → generate one full chapter',
    status: 'manual-packaged-gui',
    checklist: 'Model path',
    requires: 'macos-webdriver + bundled engine',
  },
  {
    id: 'stop-continue-retry',
    title: 'Stop mid-generation, then continue / retry (cancelled run logged once)',
    status: 'manual-packaged-gui',
    checklist: 'Model path',
    requires: 'macos-webdriver + bundled engine',
  },
  {
    id: 'edit-save-restart',
    title: 'Edit a chapter, save, restart the app — content intact',
    status: 'manual-packaged-gui',
    checklist: 'Writing and data',
    requires: 'macos-webdriver',
  },
  {
    id: 'backup-export',
    title: 'Backup/restore and the main export formats',
    status: 'manual-packaged-gui',
    checklist: 'Writing and data',
    requires: 'macos-webdriver',
  },
  {
    id: 'force-quit-recovery',
    title: 'Force-quit then relaunch — no data loss, no migration error',
    status: 'manual-packaged-gui',
    checklist: 'Writing and data',
    requires: 'macos-webdriver',
  },
  {
    id: 'external-link-allowlist',
    title: 'External project/support links open only allowed destinations',
    status: 'manual-packaged-gui',
    checklist: 'System integration',
    requires: 'macos-webdriver + browser observation',
  },
  {
    id: 'window-theme',
    title: 'Minimum window size and light/dark appearance remain usable',
    status: 'manual-packaged-gui',
    checklist: 'System integration',
    requires: 'macos-webdriver + visual assertions',
  },
  {
    id: 'uninstall-data-retention',
    title: 'Removing the app leaves the local data root intact',
    status: 'manual-packaged-gui',
    checklist: 'System integration',
    requires: 'packaged app + isolated INKMARSHAL_HOME',
  },
  {
    id: 'update-relaunch',
    title: 'Update/relaunch flushes manuscript state and returns to a healthy Studio',
    status: 'manual-packaged-gui',
    checklist: 'System integration',
    requires: 'signed updater path + macos-webdriver',
  },
];

/** High-risk manual-checklist sections that MUST each map to ≥1 matrix path so
 *  automation coverage can only grow, never silently regress. */
export const REQUIRED_CHECKLIST_SECTIONS = [
  'Install and first launch',
  'Model path',
  'Writing and data',
  'System integration',
] as const;

export function smokeCountsByStatus(): Record<SmokeStatus, number> {
  const counts: Record<SmokeStatus, number> = {
    'automated-unit': 0,
    'automated-ci-boot': 0,
    'manual-packaged-gui': 0,
  };
  for (const path of DESKTOP_SMOKE_MATRIX) counts[path.status] += 1;
  return counts;
}
