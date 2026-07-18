# Contributing / Local Dev Setup

This file is the **fresh-machine bootstrap** for humans and coding agents.
Goal: clone the repo on a new Mac and run the product without guessing.

Chinese product overview: [README_zh-CN.md](README_zh-CN.md).
App-level scripts: [novelcraft-ai/README.md](novelcraft-ai/README.md).

## Product shape (read this first)

| Surface | What it is | Command |
|---------|------------|---------|
| **Desktop Studio** | Real writing app (Tauri v2 + local SQLite + bundled engines) | `pnpm desktop:dev` |
| **Local Next (dev only)** | App Router host used by Tauri / local checks — **not** a public landing or hosted workspace | `pnpm dev` |

Public marketing / download site lives in the sibling repo `../AiNovelSite`. There is **no** cloud login, cloud DB, or platform credits. Do not reintroduce them.

Canonical local data root: `~/.inkmarshal/app/` (`inkmarshal.db`, `models/`, `vaults/`, logs).
Override home with `INKMARSHAL_HOME` if needed. Do **not** wipe this directory unless the operator explicitly runs the reset script.

## Prerequisites

Desktop Studio is **macOS Apple Silicon only** right now. Windows/Linux desktop builds are not supported.

| Tool | Version / notes |
|------|-----------------|
| macOS | Apple Silicon (`arm64`) |
| Node.js | `24.x` — see `novelcraft-ai/.node-version` (`engines`: `>=24 <25`) |
| pnpm | `10.15.1` (Corepack). Do **not** use pnpm 11 |
| Rust | Stable, `>= 1.77.2` (`rustup` recommended) |
| Xcode CLT | Required for Tauri / native builds: `xcode-select --install` |
| Full Xcode + Metal Toolchain | Optional. Needed only to build the bundled MLX engine; without it, GGUF/`llama-server` still works |

Local Next-only checks need Node + pnpm only. Landing / marketing work belongs in `../AiNovelSite`.

## Fresh machine bootstrap

```bash
# 1) Toolchain
# Install Node 24 (nvm / fnm / official pkg), then:
corepack enable
corepack prepare pnpm@10.15.1 --activate
# Install Rust: https://rustup.rs
# macOS native toolchain:
xcode-select --install

# 2) Clone + install
git clone <repository-url> AiNovel
cd AiNovel/novelcraft-ai
pnpm install
cp .env.example .env.local
# Defaults in .env.example are fine for local dev.

# 3) Prefer desktop Studio (main product)
pnpm desktop:dev

# Or local Next host for non-Tauri checks:
# pnpm dev
```

`pnpm desktop:dev` automatically fetches the pinned bundled engine before Tauri starts.
The first run downloads it and may compile Rust for several minutes; later runs use the
engine cache and start faster.

## Verify (before claiming “it works”)

From `novelcraft-ai/`:

```bash
pnpm verify          # lint + typecheck + vitest + Next build
pnpm verify:desktop
```

## Useful paths for agents

| Path | Why it matters |
|------|----------------|
| `novelcraft-ai/` | All app code — work here |
| `novelcraft-ai/app/` | Next.js App Router (desktop-studio + local API; no public landing) |
| `novelcraft-ai/src-tauri/` | Tauri shell + Rust |
| `novelcraft-ai/lib/` | Domain logic (DB, models, providers) |
| `novelcraft-ai/.env.example` | Env contract |
| `spec/LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md` | Product direction for Studio / providers |
| `spec/SYSTEM_FRAMEWORK.md` | System framework |
| `novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md` | What is actually shipped |
| `CLAUDE.md` / `AGENTS.md` | Agent working rules (prelaunch, no cloud auth) |

## Common pitfalls

- **Wrong directory**: run `pnpm` commands from `novelcraft-ai/`, not the repo root.
- **pnpm 11**: Corepack-pin `10.15.1`; project `engines` reject pnpm 11.
- **Node 25 / Node 22**: use Node 24 only.
- **Bundled engine download fails**: retry `pnpm prepare:desktop-dev`; completed engine downloads are cached and reused.
- **MLX build skipped**: missing Metal Toolchain / Xcode is OK for GGUF path; do not treat it as a hard failure for local Studio.
- **Signing / notarization**: not required to develop. `pnpm release:mac` is maintainer-only and needs Apple Developer credentials outside the repo.

## Local data safety

- Normal startup must **not** delete or migrate old local data.
- Destructive wipe (operator only):

```bash
node scripts/reset-inkmarshal-local-state.mjs --confirm-delete-inkmarshal-local-state
```

## Pull requests (lightweight)

1. Keep changes scoped; match existing local-first product shape.
2. Run `pnpm verify` for JS/TS changes; add `pnpm verify:desktop` when touching `src-tauri/`.
3. Never commit secrets, `.env.local`, or `~/.inkmarshal/release/apple.env`.
4. Do not add cloud auth, Supabase, Stripe, or platform-credit paths.

## Out of scope for this doc

Signed DMG release, notarization, Vercel production env, and public download URL wiring belong in a future maintainer release runbook — not required to develop or smoke-test locally.
