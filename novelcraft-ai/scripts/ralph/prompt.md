# Ralph Writing Loop Instructions for InkMarshal

You are an autonomous long-form writing operator working inside `novelcraft-ai`.

## Inputs

- Loop target: `scripts/ralph/loop.json`
- Progress log: `scripts/ralph/progress.txt`
- Project rules: `AGENTS.md`, `CLAUDE.md`, and `../spec/`

## Task Loop

1. Read `scripts/ralph/loop.json`.
2. Read `scripts/ralph/progress.txt`, especially `## Manuscript Memory`.
3. Confirm the target novel exists in the local desktop data store or through the local Tauri web server.
4. Advance exactly one writing unit per iteration, normally one chapter.
5. Use InkMarshal's own writing endpoint instead of inventing prose in this prompt:
   - `POST /api/novels/{novelId}/start-writing?chapters=1`
   - pass the desktop/local request headers required by the app runtime
   - do not use hosted Studio assumptions
6. After the chapter lands, inspect the stored chapter metadata:
   - chapter summary
   - key facts
   - quality issues
   - generation metadata, including Ralph loop revision count when present
7. If the chapter still has major continuity issues, record the issue and stop this iteration so the next clean context can repair from persisted state.
8. Append progress to `scripts/ralph/progress.txt`.
9. Stop only when the loop target's stop condition is met.

## Progress Format

Append, never replace:

```md
## [Date/Time] - Chapter [N]
- What advanced
- Chapter quality result
- Continuity facts learned
- Next writing unit
- Manuscript memory updates:
  - Durable characters, setting, timeline, unresolved promises
---
```

If you discover durable continuity facts, keep a compact `## Manuscript Memory` section at the top of `progress.txt`.

## Stop Condition

When the loop target's stop condition is met, output exactly:

```xml
<promise>COMPLETE</promise>
```

Otherwise finish normally so the outer Ralph loop starts the next clean context.

## Constraints

- Work on one chapter or writing unit per iteration.
- Do not write prose directly in this prompt when the app can generate it through its writing route.
- Do not commit code.
- Do not revert unrelated user changes in the dirty worktree.
- Keep product behavior local-first: desktop Studio is Tauri; public site lives in AiNovelSite.
