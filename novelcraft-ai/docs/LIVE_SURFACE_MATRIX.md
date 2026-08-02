# Live Surface Matrix

This compact navigation aid is maintained from `app/**/page.tsx`,
`app/api/**/route.ts`, and each page's top-level owner. Source wins if this table
drifts.

## Page routes

| Route | Surface | Owner (top mount) | Purpose |
|---|---|---|---|
| `/` | Desktop handoff | `app/page.tsx` | Opens the Studio in local/dev runtime; redirects production Web runtime to `https://www.inkmarshal.com` |
| `/desktop-studio` | Desktop | `components/DesktopStudioShell` | The Studio home shell (projects, chat, writer desk) |
| `/desktop-studio/models` | Desktop | `app/desktop-studio/models/page.tsx` → `components/LocalModelsPanel` | Model download / Use / engine management |
| `/desktop-studio/usage` | Desktop | `app/desktop-studio/usage/page.tsx` → `components/studio/usage-panel` | Local AI usage & cost panel |
| `/desktop-studio/series`, `/series/[id]` | Desktop | `app/desktop-studio/series/*` | Series / shared-world management |
| `/desktop-studio/workflows` | Desktop | `components/workflows/WorkflowStudioSurface` | Workflow / template surface |
| `/novel/[id]` | Desktop | `components/NovelWorkspace` | Active-novel workspace (chat interview, greenlight, blueprint, autonomous writing) |
| `/novel/[id]/manuscript` | Desktop | `app/novel/[id]/manuscript/page.tsx` → redirect `/novel/[id]?view=manuscript` (`NovelWorkspace` / `ManuscriptShell`) | Compatibility redirect (preserves `autostart` / `chapter`) |

The public landing, download, examples, privacy, and terms routes live in sibling
repository `../../../AiNovelSite`. If this desktop app is accidentally served as
a production Web runtime, `proxy.ts` redirects desktop-only routes to the public
download page; the Studio itself only opens inside Tauri.

## Key API route groups → consumer

| API group | Consumer surface |
|---|---|
| `novels`, `novels/[id]`, `novels/[id]/settings`, `project-goals` | Workspace / project management |
| `novels/[id]/interview`, `greenlight`, `blueprint`, `blueprint/regenerate` | Interview → greenlight → blueprint flow |
| `novels/[id]/start-writing` | Autonomous batch writing (`lib/writing/start-writing-usecase`) |
| `novels/[id]/chapters/**` (`continue`, `edit`, `rewrite`, `revert`, `snapshots`) | Writer desk chapter lifecycle |
| `novels/[id]/knowledge/**`, `knowledge/relations`, `knowledge/[entryId]/summarize` | Knowledge base + relations (`components/knowledge/*`) |
| `novels/[id]/outline`, `outline/aggregate` | Multi-level outline |
| `novels/[id]/unify`, `unify/apply` | Whole-book unification |
| `novels/[id]/import/**`, `backup`, `export-bundle`, `backups/restore` | Import / backup / export |
| `novels/[id]/conversations/**`, `messages` | Chat runtime + persistence |
| `usage`, `app-settings`, `health`, `trash/**` | Usage panel, settings, health, trash/restore |
| Vault watcher IPC (`vault_watch_start` / `vault_watch_stop`, `vault://changed` + `watchId` / ordered generation) + `reconcileVaultChangedFiles` | `components/VaultRuntimeCoordinator` (mounted from `DesktopShellLayout`) → generation-safe live reconcile + Story Deck refresh via `inkmarshal:vault-entries-changed` |
| Knowledge vault durable outbox (`knowledge_vault_outbox`, `drainKnowledgeVaultOutboxAction`) | Same coordinator: startup drain, bounded offline backoff + focus/online resume, path-change resume via `inkmarshal:vault-path-changed`, and post-reconcile retry of pending upsert/delete intents (CAS-matched on `intent_revision`). Established-root upserts conditionally replace Markdown against `knowledge_index.mirror_content_hash` (unknown/NULL baseline fail-closed on divergent existing files; displace + no-replace install). External divergence keeps disk bytes and the pending App DB/outbox revision — reconcile must not absorb one over the other. |
| Vault root bootstrap (`bootstrapNovelVaultRootAction`, `vault_version = 0` pending) | Same coordinator: on first bind / root change, project canonical DB entries before missing-file-as-delete snapshot reconcile; established roots keep delete semantics |

## Backend surfaces without a UI consumer

None.
