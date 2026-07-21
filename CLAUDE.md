## InkMarshal Current State

- App code lives under `novelcraft-ai/`; repo root is `AiNovel`.
- Project is **prelaunch**: no real users, no production data, and no historical compatibility contract to preserve. For future cleanup/refactor work, do not add migrations, legacy adapters, compatibility branches, fallback paths, or "minimum viable" patch layers for old internal states. Delete or collapse old schema, old APIs, old config, old UI entries, old scripts, fake/test data, and duplicate implementations into the single current product shape.
- Prelaunch does **not** mean normal app startup may silently wipe local machine state. Destructive local cleanup must remain an explicit operator action through the reset script; implementation work should remove repo/runtime compatibility debt rather than adding automatic data-preservation migrations for old unpublished builds.
- Product in this repository is the local-first Tauri v2 desktop Studio. The public website lives in sibling repo `../AiNovelSite`; do not reintroduce landing/Vercel code, cloud auth, cloud DB, platform credits, or Supabase runtime assumptions here.
- Canonical runtime data/config root is `~/.inkmarshal/app/`: `inkmarshal.db`, SQLite WAL/SHM, `models/`, `vaults/`, `locale.txt`, `model-root.txt`, fallback `secrets/`, and logs.
- `INKMARSHAL_HOME` may override the root (`~/.inkmarshal`). `INKMARSHAL_DATA_DIR` is only a DB-dir override for tests/scripts and is intentionally not passed through the packaged desktop runtime.
- Local/generated project dot-state can be relocated with `node novelcraft-ai/scripts/relocate-dot-state.mjs --apply`; destructive cleanup requires `node novelcraft-ai/scripts/reset-inkmarshal-local-state.mjs --confirm-delete-inkmarshal-local-state`. Normal startup must not delete or migrate old data implicitly.
- Tracked repo contract files stay in repo: `.git`, `.github`, `.gitignore`, `.env.example`, `.node-version`, docs, and source-controlled config.
- Apple release env may be loaded from `~/.inkmarshal/release/apple.env` with strict file permissions; never commit or paste release secrets.
- Use Node `>=24 <25` and pnpm `>=10.15.1 <11`. If the shell exposes pnpm 11.x, use the project/Corepack-pinned pnpm 10 or local binaries for verification.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **InkMarshal** (7595 symbols, 20514 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/InkMarshal/context` | Codebase overview, check index freshness |
| `gitnexus://repo/InkMarshal/clusters` | All functional areas |
| `gitnexus://repo/InkMarshal/processes` | All execution flows |
| `gitnexus://repo/InkMarshal/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
