## InkMarshal Current State

- App code lives under `novelcraft-ai/`; repo root is `AiNovel`.
- Project is **launched** (publicly released since 2026-07-23): released builds may hold real user data. Changes touching the local SQLite schema, vault layout, `~/.inkmarshal/app/` data layout, updater manifest, or published release asset names must preserve existing user data and published contracts — schema changes ship with forward migrations from every published release, and the updater path must keep working from every published version.
- Launched does **not** mean hoarding speculative compatibility debt: dead code, unused config, and duplicate implementations with no published dependents should still be deleted outright. Destructive local cleanup remains an explicit operator action through the reset script; normal startup must never delete or silently discard user data.
- Product in this repository is the local-first Tauri v2 desktop Studio. The public website lives in sibling repo `../AiNovelSite`; do not reintroduce landing/Vercel code, cloud auth, cloud DB, platform credits, or Supabase runtime assumptions here.
- Canonical runtime data/config root is `~/.inkmarshal/app/`: `inkmarshal.db`, SQLite WAL/SHM, `models/`, `vaults/`, `locale.txt`, `model-root.txt`, fallback `secrets/`, and logs.
- `INKMARSHAL_HOME` may override the root (`~/.inkmarshal`). `INKMARSHAL_DATA_DIR` is only a DB-dir override for tests/scripts and is intentionally not passed through the packaged desktop runtime.
- Local/generated project dot-state can be relocated with `node novelcraft-ai/scripts/relocate-dot-state.mjs --apply`; destructive cleanup requires `node novelcraft-ai/scripts/reset-inkmarshal-local-state.mjs --confirm-delete-inkmarshal-local-state`. Normal startup must not delete or migrate old data implicitly.
- Tracked repo contract files stay in repo: `.git`, `.github`, `.gitignore`, `.env.example`, `.node-version`, docs, and source-controlled config.
- Apple release env may be loaded from `~/.inkmarshal/release/apple.env` with strict file permissions; never commit or paste release secrets.
- Use Node `>=24 <25` and pnpm `>=10.15.1 <11`. If the shell exposes pnpm 11.x, use the project/Corepack-pinned pnpm 10 or local binaries for verification.
