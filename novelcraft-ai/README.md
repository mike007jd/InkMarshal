# InkMarshal Desktop Package

The real Studio runs in Tauri at `/desktop-studio`. The sibling `../../AiNovelSite` repository owns all public web pages.

Run package commands here with the toolchain declared in `package.json`:

```bash
pnpm desktop:dev
pnpm verify
pnpm verify:desktop
pnpm verify:security
pnpm desktop:build
pnpm release:mac
```

Runtime contracts:

- Product data lives under `~/.inkmarshal/app/`; schema and migration ownership is in `lib/db/schema/` and `lib/db/migrations.ts`.
- DB state plus `knowledge_index` is canonical; Vault Markdown is a durable outbox/tombstone projection.
- Provider keys are configured locally and stored through the OS keychain, with a restricted local fallback.
- The bundled GGUF engine is the default; compatible local servers and BYOK connections are secondary.
- There is no hosted workspace, cloud account/database, platform-credit system, or Vercel deployment in this package.

For setup use [CONTRIBUTING.md](../CONTRIBUTING.md). For architecture use [SYSTEM_FRAMEWORK.md](../spec/SYSTEM_FRAMEWORK.md). For release work use [LAUNCH_READINESS.md](docs/LAUNCH_READINESS.md).
