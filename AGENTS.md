# InkMarshal Repository Guide

## Scope

- The repository root is `InkMarshal`; application code lives in `novelcraft-ai/`.
- The shipped product is the local-first Tauri v2 desktop Studio. The sibling `../AiNovelSite` repository owns the public website, downloads, examples, legal pages, and Vercel configuration.
- Do not add a hosted writing workspace, cloud auth/database, platform credits, Supabase, or Stripe generation paths to this repository.

## Delivery

- Complete the authorized scope end to end and run every applicable gate; do not leave QA to the user.
- Reply to the user in concise Chinese. Keep implementation details focused on risks, trade-offs, and non-obvious decisions.
- Make reversible product and engineering decisions autonomously. Ask only before destructive, paid, production-data, or shared-state changes.

## Published Data Contracts

- Published builds may contain real user data. SQLite schema, Vault layout, `~/.inkmarshal/app/`, updater manifests, and release asset names are compatibility contracts.
- Schema changes require tested forward migrations from every published schema. Startup may migrate data forward but must never delete, reset, or silently discard it.
- `~/.inkmarshal/app/` owns the database, WAL/SHM, models, Vaults, locale/model-root files, fallback secrets, and logs. `INKMARSHAL_HOME` overrides the root; `INKMARSHAL_DATA_DIR` is test/script-only.
- Destructive cleanup is operator-only through `node novelcraft-ai/scripts/reset-inkmarshal-local-state.mjs --confirm-delete-inkmarshal-local-state`.
- Dead code and duplicate implementations without published dependants should still be removed; do not preserve speculative compatibility debt.

## Verification

- Use Node `>=24 <25` and pnpm `>=10.15.1 <11`; run package commands from `novelcraft-ai/`.
- Run `pnpm verify` for TypeScript/UI/docs changes, `pnpm verify:desktop` for Rust/Tauri changes, and `pnpm verify:security` when dependencies or security boundaries change.
- Unsigned local packaging uses
  `pnpm clean:desktop-build && pnpm desktop:build` and is never a release-ready
  artifact. Publishable packaging must use `pnpm release:mac`, which performs
  cleanup, signing/notarization, and exact-final-DMG single-instance smoke.
- Packaging does not authorize upload, tag, release, or deployment changes. Release steps live in `novelcraft-ai/docs/LAUNCH_READINESS.md`.

## Documentation

- Start with `docs/README.md`; use code, manifests, tests, and live service state as the source of truth.
- All developer, design, release, ADR, and agent documentation must be concise English. Localized user/legal documents such as `README_zh-CN.md` and the Chinese summary in `PRIVACY.md` are explicit exceptions.
- Link to code-owned values instead of copying token tables, dependency versions, model catalogs, schema counts, or recent test results into prose.
- Update affected docs in the same change. Remove stale plans or mark durable decisions superseded; do not archive misleading snapshots in active docs.
