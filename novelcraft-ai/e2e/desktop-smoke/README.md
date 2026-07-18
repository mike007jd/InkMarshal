# Desktop smoke harness (E2E-01)

Automates the highest-risk desktop smoke paths that currently live only in
[docs/RELEASE_SMOKE_CHECKLIST.md](../../docs/RELEASE_SMOKE_CHECKLIST.md), and
makes the remaining GUI coverage **explicitly gated** rather than missing.

[`smoke-matrix.ts`](smoke-matrix.ts) is the single source of truth for every
risk path and its automation status. [`smoke-matrix.test.ts`](smoke-matrix.test.ts)
is a drift guard: every high-risk checklist section must map to a matrix path, so
coverage can only grow.

## What runs where

| Status | Paths | How |
|---|---|---|
| `automated-unit` | SQLite open+migrate to schema 18; `/api/health` readiness proof | `pnpm test` (runs `boot-smoke.test.ts`) — no GUI |
| `automated-ci-boot` | Copied Tauri Next resource boots with bundled Node and answers `/api/health` | `pnpm smoke:desktop` after `pnpm build:desktop-web` |
| `gated-macos` | first-run wizard, model download → Use → engine, first chapter, stop/continue/retry, edit/save/restart, backup/export, force-quit recovery | packaged Tauri app driven by WebDriver on macOS — **blocked on the desktop CI runner (ticket CI-01)** |

The `gated-macos` rows stay in the manual checklist until a macOS desktop CI
runner exists. They are not silently dropped — they are listed here and asserted
present by the drift guard.

## Running locally

```bash
pnpm test e2e/desktop-smoke          # automated-unit boot invariants
pnpm build:desktop-web               # produce .next/standalone
pnpm smoke:desktop                   # copied-resource + bundled-Node probe
```

`pnpm smoke:desktop` fails when either copied resource is missing. It intentionally
cannot fall back to `.next/standalone` or the host Node executable.

## CI wiring

- `automated-unit` already runs in the existing `web` CI job via `pnpm test`.
- `automated-ci-boot` runs in the web job after a Linux standalone build; CI
  treats a missing standalone artifact as a failure rather than a skip.
- `gated-macos` automation (tauri-driver / WebDriver against the packaged app)
  depends on the CI-01 decision about a macOS desktop runner; once that lands,
  convert the gated rows to a `webdriver/` suite here and flip their status.
