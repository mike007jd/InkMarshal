# Engineering Rules

These are enforceable rules for the shipped local-first desktop app. Use [SYSTEM_FRAMEWORK.md](SYSTEM_FRAMEWORK.md) for the architecture map.

## Source of truth

- App root: `novelcraft-ai/`; run Node/pnpm commands there.
- Package and tool versions: `package.json`, lockfiles, `.node-version`, and Cargo manifests.
- Environment contract: `novelcraft-ai/.env.example`.
- Schema and migrations: `novelcraft-ai/lib/db/schema/` and `lib/db/migrations.ts`.
- Model/provider facts: `lib/model-supply/catalog.ts` and `lib/providers.ts`.
- Routes and shipped surfaces: source graph plus `novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md`.

Do not duplicate source-owned inventories or version numbers in narrative docs.

## Application boundary

- Next App Router is embedded in Tauri; `proxy.ts` is the desktop session and accidental-web boundary.
- Desktop data uses local SQLite and the fixed local-user model. Do not add cloud sessions, OAuth, magic links, hosted manuscript storage, or web-runtime DB access.
- Public website work belongs in `../AiNovelSite`.
- Use package-owned UI primitives and existing domain modules before adding parallel abstractions.

## Persistence and mutations

- Validate untrusted input before it reaches domain logic.
- Put transaction, authorization/scope, index, Vault outbox, and recovery ordering in shared domain primitives.
- Server actions fit React-local mutations; route handlers fit fetch, streaming, abort, binary, or external-call semantics. Transport choice must not duplicate write logic.
- Writes that update SQLite plus a durable projection enqueue projection intent inside the same transaction.
- Stale or cancelled asynchronous runs must prove ownership/current-run identity before any durable or UI state write.
- Startup may run tested forward migrations but must never reset or silently discard published data.

## AI and streaming

- Resolve `operation -> capability role -> connection`; writing surfaces do not bind directly to model IDs.
- Prefer the bundled engine, then compatible local endpoints, then user-owned cloud connections.
- Chat uses AI SDK UI message streams. Project NDJSON is limited to non-chat workflows that carry product protocol state.
- Provider credentials stay local/keychain-backed. Never add server-owned provider fallbacks or commit secrets.
- Structured model output uses schema validation and explicit failure handling.

## Native and filesystem boundaries

- Rust owns engine lifecycle, model downloads, keychain access, native dialogs, updater integration, and scoped Vault/filesystem access.
- Validate paths, expected roots, hashes, sizes, and destructive intent at native boundaries.
- Keep user-data deletion behind the explicit reset command.
- Published updater asset names and manifest shape are compatibility contracts.

## UI implementation

- Use semantic `book-*` tokens from `app/globals.css` and primitives under `components/ui/`.
- Do not introduce raw controls, ad-hoc palettes, arbitrary motion, or duplicate semantic components when the design contract test covers the role.
- User-visible changes require runtime interaction and visual verification at representative window sizes and themes.

## Gates

Run from `novelcraft-ai/`:

```bash
pnpm verify            # docs, lint, types, Knip, tests, full-novel QA, build
pnpm verify:security   # dependency advisories
pnpm verify:desktop    # rustfmt, clippy, Cargo tests
```

Use targeted tests while iterating, then run every applicable full gate. Packaging work also follows [the macOS release runbook](../novelcraft-ai/docs/LAUNCH_READINESS.md) and validates the exact newly built DMG.

## Documentation

- Developer, design, release, ADR, and agent docs are concise English.
- Localized user/legal docs are explicit exceptions, not alternate engineering sources.
- Keep current contracts, not progress snapshots or dated test claims.
- Update affected docs with the code; delete stale plans or mark durable decisions superseded.
