# Contributing

This is the fresh-machine setup and verification source of truth. Product and architecture contracts are indexed in [docs/README.md](docs/README.md).

## Product boundary

- `novelcraft-ai/` is the local-first Tauri desktop Studio.
- `../AiNovelSite` owns the public website and Vercel deployment.
- Local data lives under `~/.inkmarshal/app/`; never delete it during normal development or startup.

## Prerequisites

| Tool | Requirement |
|---|---|
| macOS | Apple Silicon for packaged desktop work |
| Node.js | `>=24 <25` from `novelcraft-ai/.node-version` |
| pnpm | `10.15.1` through Corepack |
| Rust | Stable, with `rustfmt` and `clippy` |
| Xcode CLT | Required for native builds |
| Full Xcode + Metal Toolchain | Optional; needed to build the MLX engine |

## Bootstrap

```bash
git clone <repository-url> InkMarshal
cd InkMarshal/novelcraft-ai
corepack enable
corepack prepare pnpm@10.15.1 --activate
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm desktop:dev
```

`pnpm desktop:dev` fetches the pinned engine before Tauri starts. Without the Metal toolchain, the MLX build may be skipped; the GGUF/`llama-server` path remains available.

## Common commands

Run from `novelcraft-ai/`:

```bash
pnpm dev                 # local Next host for UI work
pnpm desktop:dev         # main Tauri product
pnpm verify              # docs, lint, types, dead code, tests, full-novel QA, build
pnpm verify:desktop      # rustfmt, clippy, Cargo tests
pnpm verify:security     # OSV and Cargo advisory gates
pnpm build:desktop-web   # embedded Next resource
pnpm smoke:desktop       # bundled-Node runtime probe
pnpm clean:desktop-build # remove stale desktop outputs
pnpm desktop:build       # unsigned local app and DMG; not release-ready
```

Signed/notarized packaging is maintainer-only and follows [the macOS release runbook](novelcraft-ai/docs/LAUNCH_READINESS.md).

## Data safety

- Current schema ownership is `novelcraft-ai/lib/db/schema/` and `lib/db/migrations.ts`; do not copy schema numbers into prose.
- Every published schema change needs a tested forward migration. Startup must fail closed rather than discard incompatible data.
- `INKMARSHAL_HOME` may isolate a development home. `INKMARSHAL_DATA_DIR` is reserved for tests and scripts.
- Destructive reset is explicit:

```bash
node scripts/reset-inkmarshal-local-state.mjs --confirm-delete-inkmarshal-local-state
```

## Pull requests

1. Keep changes within the local-first product boundary.
2. Run all applicable gates and add focused tests for changed behavior.
3. Never commit secrets, `.env.local`, runtime data, or Apple release credentials.
4. Update affected English developer/design documentation in the same change.
