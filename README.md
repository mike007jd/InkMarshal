# InkMarshal

> Local-first AI novel writing Studio

**New machine / coding agent?** Start with [CONTRIBUTING.md](CONTRIBUTING.md) — prerequisites, bootstrap, and verify commands.

中文说明：[README_zh-CN.md](README_zh-CN.md)

## Download

**[Download the latest signed and notarized InkMarshal DMG for macOS (Apple Silicon)](https://github.com/mike007jd/InkMarshal/releases/latest)**

## Current Product Shape

InkMarshal is a **local-first desktop writing Studio** built on Tauri v2. The public website is maintained separately in sibling repository `../AiNovelSite`.

- **Desktop (Tauri v2, `novelcraft-ai/src-tauri/`)** is the real Studio: Next.js standalone runtime, local SQLite (`~/.inkmarshal/app/inkmarshal.db`), and inference engines (`llama.cpp llama-server` for GGUF; native `mlx-server` on Apple Silicon when Metal is available).
- **Website (`../AiNovelSite`)** owns landing, download, examples, legal pages, and Vercel. No hosted writing workspace, login, cloud database, or platform credits.
- **Model supply** is HuggingFace / local-engine first; OpenAI-compatible / Anthropic / Google API keys are last-resort BYOK in the UI.

## Prerequisites

| Need | Detail |
|------|--------|
| Platform | **macOS Apple Silicon** for desktop Studio |
| Node.js | **24.x** (`novelcraft-ai/.node-version`; `>=24 <25`) |
| pnpm | **10.15.1** via Corepack — not pnpm 11 |
| Rust | Stable `>= 1.77.2` (desktop only) |
| Xcode CLT | `xcode-select --install` (desktop only) |

## Quick Start

```bash
git clone https://github.com/mike007jd/InkMarshal.git
cd InkMarshal/novelcraft-ai
corepack enable && corepack prepare pnpm@10.15.1 --activate
pnpm install
pnpm desktop:dev      # desktop Studio (main product)
```

## Build the Desktop App (unsigned local package)

```bash
cd novelcraft-ai
pnpm fetch-engines    # vendor llama-server (+ mlx-server when Metal/Xcode allow)
pnpm desktop:build    # .app + .dmg under src-tauri/target/release/bundle/macos/
```

`fetch-engines` is also wired into `beforeBuildCommand`, so a plain `pnpm desktop:build` works on a clean checkout. Signing/notarization is **not** required for local builds.

## Commands (from `novelcraft-ai/`)

```bash
pnpm dev                # desktop Next runtime
pnpm desktop:dev        # desktop Studio (Tauri)
pnpm desktop:build      # local .app + .dmg
pnpm build              # Next.js desktop-runtime build
pnpm lint
pnpm typecheck
pnpm test               # vitest
pnpm verify             # lint + typecheck + dead-code (Knip) + test + full-novel QA gate + build
pnpm verify:desktop     # rustfmt + clippy + cargo test
```

## Environment

Provider keys are configured in the **desktop UI** (local/keychain). Public-site `NEXT_PUBLIC_*` values belong only to `../AiNovelSite`.

## Repository Layout

```text
InkMarshal/
├── README.md / README_zh-CN.md
├── CONTRIBUTING.md      ← fresh-machine bootstrap (start here)
├── LICENSE              ← Apache-2.0
├── spec/                ← product / engineering rules
├── docs/                ← policy only
└── novelcraft-ai/       ← all app code (cd here for pnpm)
    ├── app/             ← Next.js desktop-studio routes
    ├── lib/             ← domain logic
    ├── src-tauri/       ← Tauri + Rust
    ├── .env.example
    └── package.json
```

## Documentation Map

- Bootstrap: [CONTRIBUTING.md](CONTRIBUTING.md)
- Privacy and network behavior: [PRIVACY.md](PRIVACY.md)
- Security support and private reporting: [SECURITY.md](SECURITY.md)
- App scripts / release notes for maintainers: [novelcraft-ai/README.md](novelcraft-ai/README.md)
- System framework: [spec/SYSTEM_FRAMEWORK.md](spec/SYSTEM_FRAMEWORK.md)
- Live surfaces: [novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md](novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md)
- Product direction: [spec/LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md](spec/LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md)
- Launch readiness: [novelcraft-ai/docs/LAUNCH_READINESS.md](novelcraft-ai/docs/LAUNCH_READINESS.md)

`docs/` is policy-only. Prefer deleting stale plans over archiving them.
