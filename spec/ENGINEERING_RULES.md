# ENGINEERING RULES — InkMarshal

> Current engineering rules for the live codebase. This repository is the local-first Tauri desktop Studio; the landing/download web surface lives in sibling repository `../AiNovelSite`. There is no cloud auth, cloud database, or platform credits.

---

For landing-side Vercel usage spikes and route classification, use
`../AiNovelSite/docs/VERCEL_FUNCTION_USAGE_RUNBOOK.md`.

## 1. Application Structure

The live app root is `novelcraft-ai/`, and the active source layout is:

```text
novelcraft-ai/
├── app/
│   ├── actions/
│   ├── api/
│   ├── desktop-studio/      ← real writing workspace, only mounted under Tauri
│   ├── novel/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   └── ui/                  ← shadcn-style primitives, locally owned
├── hooks/
├── lib/
│   ├── db.ts                ← local SQLite barrel (better-sqlite3) at app_data_dir/inkmarshal.db
│   ├── db/                  ← connection, migrations, schema, queries-*
│   ├── local-auth.ts        ← fixed local user shim
│   ├── model-supply/        ← operation → capability role → connection resolver
│   ├── ai/                  ← generation, blueprint, quality, structured-output (zod)
│   ├── exporters/
│   ├── i18n/
│   └── types/               ← shared types + zod schemas
└── src-tauri/
    ├── src/engine/        ← engine subprocess supervisor (module dir)
    ├── src/model_manager/ ← HF search + downloads + sha256 (module dir)
    ├── src/secret.rs      ← OS keychain
    ├── src/health.rs      ← runtime health checks
    └── resources/engines/ ← vendored llama-server + mlx-server (fetched at build)
```

Do not document or scaffold `src/app` / `src/lib` paths. Do not reintroduce `lib/supabase/`, `lib/credits.ts`, `lib/platform-models*`, `lib/gateway-models*`, `lib/stripe.ts`, `app/auth/`, or `app/login/`.

---

## 2. Rendering and Mutation Model

### Runtime split

`INKMARSHAL_RUNTIME=desktop` is injected by the Tauri shell. Server code branches on it to choose between:

- **Desktop runtime** (`INKMARSHAL_RUNTIME=desktop`): local SQLite via `lib/db/` (`lib/db.ts` barrel), fixed local user, OS keychain, bundled engines.
- **Accidental production Web runtime**: redirects to the separate public site; database access is short-circuited.

### Server Components by Default

Use Server Components for:

- Route shells
- Metadata
- Server-rendered marketing content
- Reading from local SQLite under the desktop runtime

Use Client Components for:

- Chat interactions
- Manuscript editing
- Local settings, model picker, onboarding
- Theme, transient UI state
- Animations

### Writes

The codebase uses a mix of:

- Route handlers under `app/api/`
- Server-side helper modules under `lib/`
- Limited action modules under `app/actions/`

All writes go through `lib/db/` (the `lib/db.ts` barrel and its query handlers) — no remote database driver.

---

## 3. Data Mode

There is exactly one data mode: **local**.

- Database: local SQLite at `app_data_dir/inkmarshal.db`, accessed only inside the desktop runtime.
- User: fixed local user shim (`lib/local-auth.ts`). All `getUser()` calls return the same desktop user.
- Secrets: OS keychain via Rust (`src-tauri/src/secret.rs`).
- Accidental Web runtime: no user, no DB, no session; hand off to the separate public site.

Do not reintroduce guest mode / signed-in mode branching. Do not reintroduce cloud sessions, cookies, OAuth callbacks, or magic-link flows.

---

## 4. Authentication Rules

There is **no authentication**.

- No login UI. No OAuth. No magic link. No email/password.
- `app/login/*`, `app/auth/*`, `lib/auth-helpers.ts` are removed and must not be reintroduced.
- The desktop app trusts the local user. BYOK API keys are stored in the OS keychain, not in any user record.

---

## 5. AI Provider Architecture

Provider and runtime strategy must follow [LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md](./LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md). Platform credits do not exist as a product path.

### Current Model

The desktop app is **bundled-engine first, BYOK last**.

Resolution order (`lib/model-supply/*`) for any operation:

1. **Bundled local engine** — `llama-server` (GGUF) on every platform, `mlx-server` (MLX) on Apple Silicon. Auto-registered as an `openai-compatible` localhost connection by `lib/model-supply/local-engine.ts`.
2. **Other detected local servers** — Ollama, LM Studio, llama.cpp, any other OpenAI-compatible localhost endpoint.
3. **BYOK cloud** — Anthropic / OpenAI / Google / OpenAI-compatible vendors.

The three stages are: **operation → capability role → connection**. Never let the writing surface pick a model directly; always route through capability roles (`draft`, `rewrite`, `summarize`, ...) so the writing UI only sees capability availability, never model identifiers.

Primary files:

- `lib/model-supply/*`
- `lib/ai-providers.ts`
- `lib/providers.ts`
- `lib/ai.ts`
- `app/api/novels/[id]/messages/route.ts` (novel chat)
- `app/api/novels/[id]/conversations/[convId]/chat/route.ts` (conversation chat)

### Provider Reality

Current cloud BYOK provider support:

- Anthropic
- OpenAI
- Google (Gemini)
- DeepSeek
- Moonshot / Kimi
- Qwen / DashScope
- Volcengine / Doubao (preset allowed, no default model unless current Ark model IDs are verified)
- SiliconFlow
- OpenRouter
- Stepfun
- Custom OpenAI-compatible endpoint

### Engine Layer (Rust)

Engines are managed by `src-tauri/src/engine/` (module directory):

- `engine_start` / `engine_stop` / `engine_status` Tauri commands.
- Port assignment, readiness polling (180s upper bound), process-group cleanup on shutdown.
- Bundled binaries live in `src-tauri/resources/engines/<platform>/` and are vendored by `pnpm fetch-engines` (also wired into `beforeBuildCommand`).
- For Apple Silicon, `mlx-server` is shipped as a `.app`-style bundle with its metallib, and is invoked accordingly.

Tauri capability scope is intentionally pragmatic for the local desktop app: custom commands are available to the app-owned frontend origin, and high-impact commands enforce validation in Rust command bodies. Later hardening can split vault writes/deletes, engine start/stop, and keychain access into narrower permission sets without changing user-facing flows.

Model downloads go through `src-tauri/src/model_manager/` (module directory):

- Format-aware HuggingFace search (`gguf` vs `mlx`).
- Single-file core extraction for GGUF.
- MLX multi-file snapshot with resumable downloads.
- sha256 verification.

### Streaming Contract

Chat routes use AI SDK v6 UIMessage streams through `streamText(...).toUIMessageStreamResponse()`:

- `app/api/novels/[id]/messages/route.ts`
- `app/api/novels/[id]/conversations/[convId]/chat/route.ts`

Do not reintroduce a project-owned chat NDJSON/SSE wrapper, client-side stopped-message persistence, or `/messages/partial` write path. Stopped replies are persisted from the server-side AI SDK stream lifecycle.

Project NDJSON streams are allowed only for non-chat writing/editor workflows where the product protocol carries writing locks, truncation metadata, patch progress, or explicit workflow state. Keep those helpers isolated from the assistant chat runtime.

---

## 6. Billing

Platform credits do not exist as a product path. Do not add credits UX, credits copy, Stripe checkout for generation, or platform-prepaid generation.

The billing direction is:

- Desktop license
- Pro workflows
- Team / self-hosted license
- Optional cloud sync / device management (future, not yet shipped)

---

## 7. Export Rules

Current export/download behavior:

- Full novel export: EPUB, TXT, DOCX, PDF
- Export ZIP with full-manuscript EPUB/TXT/DOCX/PDF plus per-chapter TXT/DOCX
- Browser download flows from within the desktop app

The current PDF exporter uses bundled font support for CJK, Cyrillic, and accented Latin. Scripts outside the bundled glyph coverage must fail clearly instead of emitting broken glyphs.

Primary files:

- `components/ManuscriptSidebar.tsx`
- `components/ChapterDownloadMenu.tsx`
- `lib/export-client.ts`
- `lib/exporters/*`
- `app/api/novels/[id]/export-bundle/route.ts`

---

## 8. UI Component Rules

- Tailwind v4 with `@theme` tokens.
- Component primitives under `components/ui/` are shadcn-style and **locally owned** (no shadcn CLI dependency, no Radix-only).
- Use the in-repo `book-*` tokens and `variant=ink|accent|boxed` props rather than inventing ad-hoc Tailwind classes.

---

## 9. File and Naming Conventions

- Components: `PascalCase.tsx`
- Hooks/utilities: `camelCase.ts`
- Route files: `page.tsx`, `layout.tsx`, `route.ts`, `not-found.tsx`
- Shared server/browser helpers: `lib/`
- Rust capabilities: `src-tauri/src/<area>.rs`

---

## 10. Quality Gates

Run from `novelcraft-ai/`:

```bash
pnpm lint
pnpm typecheck
pnpm test          # vitest
pnpm build         # Next.js desktop-runtime production build
pnpm desktop:build # Tauri desktop bundle (.app + .dmg)
```

Cargo gates from `novelcraft-ai/src-tauri/`:

```bash
cargo build --release
cargo test
```

Validation otherwise relies on live agent testing against the running desktop app.

---

## 11. Documentation Rules

1. Active truth lives in `README.md`, `README_zh-CN.md`, `novelcraft-ai/README.md`, and `spec/*.md`.
2. `spec/*.md` must describe current policy or architecture, not one-off implementation plans.
3. `docs/` and `novelcraft-ai/docs/` contain maintained public documentation only; internal working notes and dated reports stay outside the repository.
4. Delete stale documents instead of retaining an in-repository archive.
5. If architecture changes, update active docs in the same task.
6. Remove or correct any claims about:
   - cloud auth / cloud database / signed-in mode
   - Supabase, Stripe credit checkout, or platform credits
   - `src/` app roots
   - npm-first workflow

---

## 12. Environment Documentation

The environment variable source of truth is:

- `novelcraft-ai/.env.example`

All envs are optional — the bundled engine and local SQLite store let a fresh user run the desktop app with zero configuration. Do not maintain stale env lists in docs once `.env.example` changes.
