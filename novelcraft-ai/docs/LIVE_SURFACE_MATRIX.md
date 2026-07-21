# Live Surface Matrix — InkMarshal

> Maintained from the current route and import graph. This is the authoritative
> map of user-visible surfaces and their real owners. Regenerate it
> from `app/**/page.tsx`, `app/api/**/route.ts`, and the top-level component each
> page mounts whenever surfaces change.

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

## Backend surfaces without a UI consumer

None.
