# PROJECT CONSTITUTION — InkMarshal

> Current product and architecture baseline. If this document and the code disagree, update one of them immediately.

---

## Core Principles

1. **Ship complete behavior** — No placeholder UX, no half-migrated data flows, no docs that describe a product we no longer run.
2. **Local-first by default** — The writing Studio runs entirely on the user's machine: local SQLite, local model engines, local keychain for BYOK secrets. Nothing the user creates depends on a cloud account.
3. **One platform, one writing surface** — The desktop Tauri app is the real Studio. The separate `../AiNovelSite` repository is landing + distribution only.
4. **Type safety at boundaries** — TypeScript strict mode; Zod validation for untrusted inputs and structured AI outputs.
5. **Documentation is part of the product** — Entry docs, `spec/`, and `.env.example` must stay aligned with the codebase.

---

## Product Reality

InkMarshal currently provides, **inside the desktop app**:

- Chat-first AI-assisted novel writing
- Long-form manuscript and chapter workflows (blueprint → autonomous writing → unification)
- Per-chapter rolling memory + length/quality gates
- Local SQLite store at `app_data_dir/inkmarshal.db`
- Bundled inference engines (llama-server for GGUF, mlx-server for Apple Silicon MLX)
- HuggingFace search + downloads, Ollama / LM Studio detection, BYOK cloud keys as last-resort fallback
- Exports to EPUB, TXT, DOCX, PDF with bundled font support for CJK/Cyrillic/accented Latin, plus a full-manuscript Export ZIP

The website (`../AiNovelSite`) is:

- Landing page introducing the product
- `/studio` and `/download` — desktop download surface
- Privacy / terms / example library (read-only)

The Web side has **no signed-in mode, no user accounts, no cloud database, no hosted Studio, no platform credits**.

## Active Product Direction

Provider and Studio work in this repository must follow [LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md](./LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md); landing work is implemented and verified in `../AiNovelSite`.

The approved direction is local-first / BYOK / user-owned runtime, with the bundled engine as the default path so a fresh user can write a chapter with zero external installs. Platform credits do not exist as a product path. Public Studio entry points provide the macOS desktop download, not hosted Studio generation. Windows remains unshipped until a signing and validation path exists.

---

## Technology Baseline

| Layer | Current Choice |
|---|---|
| Desktop shell | Tauri v2 (`novelcraft-ai/src-tauri/`) |
| Framework | Next.js 16 App Router (standalone, embedded in Tauri) |
| Language | TypeScript 5.9 |
| UI | React 19 |
| Styling | Tailwind CSS 4 + `@tailwindcss/typography` |
| Animation | Motion 12 |
| Icons | Lucide React |
| Component primitives | shadcn-style primitives under `components/ui/*` + Radix headless |
| Database | Local SQLite via `better-sqlite3` (`lib/db.ts`), stored under `app_data_dir/inkmarshal.db` |
| Auth | Fixed local user shim (`lib/local-auth.ts`); no cloud auth |
| Secrets | OS keychain via Rust (`src-tauri/src/secret.rs`) |
| Inference engines | Bundled `llama-server` (GGUF, pinned `b9209`) all platforms; native `mlx-server` (MLX swift) on Apple Silicon |
| Model supply | `operation → capability role → connection` three-stage resolver (`lib/model-supply/*`), BYOK as last fallback |
| AI access | Vercel AI SDK v6 (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`) |
| Validation | Zod |
| Website analytics | Vercel Analytics + Speed Insights in `../AiNovelSite` only |
| Testing | Vitest unit tests + live agent verification |
| Package manager | pnpm |

---

## Codebase Shape

```text
novelcraft-ai/
├── app/                   ← Next.js desktop-studio routes under Tauri
├── components/
│   └── ui/                ← shadcn-style primitives, locally owned
├── hooks/
├── lib/
│   ├── db.ts             ← local SQLite barrel (app_data_dir/inkmarshal.db)
│   ├── local-auth.ts      ← fixed local user shim
│   ├── model-supply/      ← three-stage capability resolver
│   └── exporters/
├── src-tauri/             ← Tauri shell + Rust capability layer + engine bundling
│   ├── src/engine/      ← engine subprocess supervisor (module dir)
│   ├── src/model_manager/ ← HF search + downloads + sha256 (module dir)
│   ├── src/secret.rs    ← OS keychain
│   └── resources/engines/ ← vendored llama-server + mlx-server (fetched at build)
├── docs/
├── public/
├── package.json
└── next.config.ts
```

The live application does **not** use a `src/` root.

---

## Architecture Summary

```text
Desktop (Tauri v2)
  ├── Next.js standalone runtime (embedded)
  ├── Local SQLite (lib/db.ts, app_data_dir/inkmarshal.db)
  ├── Fixed local user shim (lib/local-auth.ts)
  ├── Rust capability layer (src-tauri/src/)
  │     ├── engine/         — bundled engine subprocess supervisor (module dir)
  │     ├── model_manager/  — HF search + downloads (resumable + sha256) (module dir)
  │     └── secret.rs       — OS keychain for BYOK API keys
  └── Bundled inference engines
        ├── llama-server (GGUF, all platforms)
        └── mlx-server (Apple Silicon MLX)

Website (`../AiNovelSite`, Next.js)
  ├── Landing pages (marketing, privacy, terms)
  └── /studio and /download — desktop download surface (no hosted workspace)

Model supply
  └── lib/model-supply/*  — three-stage resolver:
        operation → capability role → connection
        Connections in priority order:
          1. Bundled local engine (auto-registered as openai-compatible localhost)
          2. Ollama / LM Studio / llama.cpp / other local OpenAI-compatible servers (if detected)
          3. BYOK cloud (Anthropic / OpenAI / Google / OpenAI-compatible vendors)

AI Layer (Vercel AI SDK)
  ├── lib/ai-providers.ts — provider factory
  ├── Native provider: Anthropic (@ai-sdk/anthropic)
  ├── OpenAI-compatible adapter: OpenAI, Google (Gemini), DeepSeek, Moonshot, Qwen (DashScope), Doubao (Volcengine), Step, SiliconFlow, OpenRouter, local engines, custom endpoints
  ├── Structured output via AI SDK v6 Output.object + Zod (Greenlight Pack, Book Blueprint, Chapter Edits, Chapter Summary, Chapter Quality, Unification Report)
  ├── Chat streaming via AI SDK UIMessage streams; no project-owned chat partial protocol
  └── Token-accurate usage accounting via generateText/streamText usage metadata (kept locally; no platform credit reconciliation)

Long-novel pipeline
  ├── Outline knowledge entries are the blueprint source of truth; `getNovelBlueprint()` projects them on demand
  ├── Cooperative writing lock (novels.writing_lock_token / writing_lock_expires_at)
  ├── Per-chapter rolling memory:
  │     ├── chapters.summary + chapters.key_facts (auto-generated post-write)
  │     └── streamChapter receives recentChapterTails (verbatim last N) + earlierChapterDigest (compressed)
  ├── Knowledge base injected into BOTH blueprint generation and chapter prose (8000-char budget)
  ├── Mid-flight quality gates:
  │     ├── length-retry: chapters under 70% of target trigger one continuation pass
  │     └── validateChapter: structured consistency check stored as chapters.quality_issues (advisory)
  └── whole_book_unification stage:
        ├── /api/novels/[id]/unify streams generateUnificationReport
        ├── novels.unification_report stores structured edits with severity + applied state
        └── /api/novels/[id]/unify/apply applies edits via verbatim find/replace + chapter version lock

Stage machine
  discovery_interview
    → ready_for_greenlight (greenlight pack approved)
    → autonomous_writing (start-writing acquires lock, persists blueprint, writes chapter loop)
    → whole_book_unification (full draft done; user runs unify scan)
    → completed (every unification edit applied or skipped)

Billing
  └── Desktop license / Pro / team license direction; no platform credits, no Stripe checkout for generation
```

---

## Non-Negotiable Constraints

1. **Do not reintroduce cloud auth, cloud database, or platform credits.** That includes Supabase, Stripe credit checkout, `lib/platform-models*`, `lib/gateway-models`, server-side user accounts.
2. **Use pnpm, not npm or yarn.**
3. **Use App Router only.**
4. **Do not document historical plans as current architecture.**
5. **Do not make the writing UI a model console.** Runtime state surfaces as writing-capability availability (draft model ready, rewrite model missing, local runtime offline, connection required) — never as a model picker inside the writing surface.
6. **Bundled engine is the default model path.** Ollama / LM Studio / cloud BYOK are secondary.
7. **`fetch-engines` must stay wired into `beforeBuildCommand`** so a clean checkout produces a working desktop bundle.

---

## Environment Model

The desktop environment contract is:

- [novelcraft-ai/.env.example](../novelcraft-ai/.env.example)

The desktop bundled engine works without checked-in build-time variables:

- Desktop UI provider connections stored locally/keychain-backed
- Server-owned provider variables and `DEFAULT_PROVIDER` are obsolete hidden fallback paths
- Website `NEXT_PUBLIC_*` variables belong exclusively to `../AiNovelSite/.env.example`.

All cloud-auth, cloud-database, Stripe, and platform-credit variables are obsolete and must not be reintroduced.

---

## Documentation Governance

- `README.md`, `README_zh-CN.md`, `novelcraft-ai/README.md`, and `spec/*.md` are the active narrative docs.
- `spec/SYSTEM_FRAMEWORK.md` is the maintained architecture/system map.
- `novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md` is the maintained shipped-surface map.
- `spec/LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md` is the active source for provider, Studio, and local-first direction; website implementation docs live in `../AiNovelSite`.
- `novelcraft-ai/docs/LAUNCH_READINESS.md` is the release operating doc.
- `docs/` and `novelcraft-ai/docs/` contain maintained public documentation only; internal working notes and dated reports stay outside the repository.
- When a working decision becomes current policy, rewrite it into `spec/` and remove the process artifact.
