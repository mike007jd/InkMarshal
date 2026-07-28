# Desktop Smoke Harness

The smoke matrix keeps automated and manual package coverage explicit.

| Coverage | Paths | Gate |
|---|---|---|
| Unit | Current SQLite schema opens; `/api/health` proves readiness | `pnpm test` |
| Bundled boot | Copied Next resource starts with the bundled Node runtime and answers `/api/health` | macOS CI: `pnpm build:desktop-web && pnpm smoke:desktop` |
| Manual packaged GUI | First run, real model/BYOK/offline paths, writing, export, and recovery | exact final DMG plus `docs/RELEASE_SMOKE_CHECKLIST.md` |

`smoke-matrix.ts` maps every required high-risk manual section to its current
coverage. `smoke-matrix.test.ts` prevents a required section from disappearing
silently.

## Local commands

Run from `novelcraft-ai/`:

```bash
pnpm test e2e/desktop-smoke
pnpm build:desktop-web
pnpm smoke:desktop
```

The standalone smoke must use `src-tauri/resources/next-server` and the bundled Node executable. It may not fall back to `.next/standalone`, the host Node process, or production user data.

The macOS CI runner covers bundled boot, not full WebView/Tauri GUI automation. Packaged GUI paths remain manual until a reliable packaged-app driver is implemented.
