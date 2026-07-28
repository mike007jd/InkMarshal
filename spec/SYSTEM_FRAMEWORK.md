# System Framework

This is the current architecture map. It intentionally omits dependency versions, schema counts, and model IDs that are owned by code.

## Runtime boundary

```text
Tauri desktop shell
  -> embedded Next.js standalone server
  -> local SQLite + local filesystem/Vault
  -> Rust capability bridge
  -> bundled or detected local engine
  -> optional user-owned provider connection

Sibling public website (`../AiNovelSite`)
  -> marketing, examples, legal pages, download handoff
  -> no Studio data, provider keys, or generation runtime
```

`novelcraft-ai/proxy.ts` protects the split: desktop routes require the Tauri session, production web API access fails closed, and accidental web entry hands off to the public download surface.

## Code map

| Area | Owner |
|---|---|
| Routes and desktop session | `novelcraft-ai/app/` |
| Product UI and primitives | `novelcraft-ai/components/` |
| Domain logic and integrations | `novelcraft-ai/lib/` |
| Schema and queries | `novelcraft-ai/lib/db/` |
| Model capability resolution | `novelcraft-ai/lib/model-supply/` |
| AI workflows | `novelcraft-ai/lib/ai/` |
| Vault projection | `novelcraft-ai/lib/vault/` |
| Exporters | `novelcraft-ai/lib/exporters/` |
| Native capabilities | `novelcraft-ai/src-tauri/src/` |
| Bundled engine resources | `novelcraft-ai/src-tauri/resources/engines/` |

The application has no `src/` source root.

## Data and persistence

- SQLite is canonical for product state; `knowledge_index` participates in the same domain consistency model.
- Vault Markdown is a durable outbox/tombstone projection, not an independent source of truth.
- Schema ownership is `lib/db/schema/`; forward migration ownership is `lib/db/migrations.ts`.
- Native filesystem, model, engine, and secret operations cross the Rust boundary with path/input validation.
- Manuscript drafts use explicit save/autosave and recovery semantics. Update, export, backup, and accepted AI edits flush required durable state first.

## Model and AI path

```text
writing operation
  -> capability role
  -> ready configured connection
  -> provider/engine adapter
  -> AI SDK or local compatible endpoint
```

- `lib/model-supply/` owns readiness, role binding, connection priority, and bundled-engine registration.
- `lib/ai-providers.ts` owns provider construction.
- `lib/providers.ts` and `lib/model-supply/catalog.ts` own source-backed catalog facts.
- Usage accounting is local and has no platform-credit reconciliation.

## Writing lifecycle

```text
interview -> proposal/greenlight -> story deck/outline
  -> chapter writing and rolling memory
  -> read/edit and targeted rewrite
  -> whole-book unification
  -> export/backup
```

Writing locks, chapter versions, durable summaries, quality results, and stale-run suppression are domain contracts rather than UI state.

## Transport contracts

- Chat uses AI SDK UI message streams and server-owned persistence.
- Non-chat writing/editor workflows may use project NDJSON when locks, truncation, patch progress, or other workflow state must travel with the stream.
- Binary exports, abortable work, and non-React callers use route handlers where their transport requires it.
- Route handlers and server actions both call shared domain primitives; transport code does not own duplicate persistence logic.

## Release boundary

The public desktop release is an Apple Silicon macOS DMG plus updater assets. Packaging and exact-DMG validation are in `novelcraft-ai/scripts/`; the operating procedure is [LAUNCH_READINESS.md](../novelcraft-ai/docs/LAUNCH_READINESS.md).

## Change routing

| Change | Update |
|---|---|
| Product invariant or requirement | `PROJECT_CONSTITUTION.md`, `LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md` |
| Runtime/data architecture | this file |
| Coding or validation rule | `ENGINEERING_RULES.md` |
| Visual system | `DESIGN_RULES.md` and code-owned design contracts |
| Interaction behavior | `UX_RULES.md` and the live surface matrix |
| Release procedure | app release runbook/checklist |
