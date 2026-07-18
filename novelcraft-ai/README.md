# InkMarshal Desktop

This directory is the local-first Tauri v2 writing Studio. The public landing, download, examples, legal pages, and Vercel build live independently in sibling repository `../../AiNovelSite`.

## Commands

Run from `novelcraft-ai/` with Node 24 and pnpm 10.15.1:

```bash
pnpm install
pnpm dev                # desktop Next runtime for local UI work
pnpm desktop:dev        # Tauri desktop Studio
pnpm build              # Next desktop runtime
pnpm desktop:build      # local .app + .dmg
pnpm release:mac        # signed/notarized release assets
pnpm verify             # lint + typecheck + test + build
pnpm verify:desktop     # rustfmt + clippy + cargo test
pnpm verify:security    # JS + Rust dependency audits
pnpm verify:release-desktop
```

## Runtime contract

- The real workspace runs inside Tauri at `/desktop-studio`; `/novel/*` and local `/api/*` require the desktop session.
- Data is local under `~/.inkmarshal/app/`; provider keys are configured in the desktop UI and stored locally/keychain-backed.
- GGUF uses bundled `llama-server`; Apple Silicon can also use the native MLX server when the toolchain is available.
- There is no hosted workspace, cloud account, cloud database, platform credit system, or Vercel deployment in this repository.
- Apple release env may be loaded from `~/.inkmarshal/release/apple.env` with mode `600`.

Before publishing a desktop release, run `pnpm verify`, `pnpm verify:security`, `pnpm verify:desktop`, `CHECK_LOCAL_MAC_BUNDLE=1 pnpm verify:release-desktop`, and [the real-machine smoke checklist](docs/RELEASE_SMOKE_CHECKLIST.md).
