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
pnpm release:mac        # signed/notarized release assets + exact-DMG oracle
pnpm verify             # lint + typecheck + Knip + Vitest + 80-chapter QA + build
pnpm verify:desktop     # rustfmt + clippy + cargo test
pnpm verify:security    # OSV + Cargo audit (advisory-ID allowlist)
pnpm verify:release-desktop
pnpm local-state:reset  # explicit destructive wipe of unpublished local state
```

## Runtime contract

- The real workspace runs inside Tauri at `/desktop-studio`; `/novel/*` and local `/api/*` require the desktop session.
- Data is local under `~/.inkmarshal/app/`; provider keys are configured in the desktop UI and stored locally/keychain-backed.
- Local SQLite supports exactly schema v1. Empty/new DBs are created at that baseline; incompatible nonempty DBs fail closed unchanged. Destructive cleanup is only via `pnpm local-state:reset -- --confirm-delete-inkmarshal-local-state`.
- DB + `knowledge_index` are canonical; Vault markdown is a durable outbox/tombstone projection.
- GGUF uses bundled `llama-server`; Apple Silicon can also use the native MLX server when the toolchain is available.
- In-app Ralph writing workflow remains; the outer unattended `scripts/ralph` loop is removed.
- There is no hosted workspace, cloud account, cloud database, platform credit system, or Vercel deployment in this repository.
- Apple release env may be loaded from `~/.inkmarshal/release/apple.env` with mode `600`.

Before publishing a desktop release, run `pnpm verify`, `pnpm verify:security`, `pnpm verify:desktop`, `CHECK_LOCAL_MAC_BUNDLE=1 pnpm verify:release-desktop`, and [the real-machine smoke checklist](docs/RELEASE_SMOKE_CHECKLIST.md). `pnpm release:mac` adds an automated exact-final-DMG health oracle; it complements that checklist and does not replace it.
