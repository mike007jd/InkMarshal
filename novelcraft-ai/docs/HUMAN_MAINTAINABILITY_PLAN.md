# InkMarshal human-maintainability plan

This package is a **ratchet, not a rewrite**. It prevents the current high-risk modules from growing while preserving the safety work already present around locks, persistence, usage accounting, cancellation, and terminal ordering.

## What the deeper source pass confirmed

The writing flow has sensible seams, but the client owns too many representations of the same run:

| Layer | Current responsibility | Keep |
| --- | --- | --- |
| `app/api/novels/[id]/start-writing/route.ts` | ownership, stage preflight, lock acquisition, context build, stream assembly | Yes |
| `lib/writing/lease.ts` | renew/release semantics for the database lock | Yes |
| `lib/writing/ndjson-sink.ts` | controller, framing, heartbeat, timer renewal, teardown | Yes |
| `lib/writing/start-writing-usecase.ts` | batch progress and terminal persistence ordering | Yes, split internally |
| `lib/writing-orchestrator.ts` | one chapter from draft through persistence and post-processing | Yes |
| `lib/writing-session.ts` | protocol decoding on the client | Yes |
| `lib/use-manuscript-session.ts` | transport, run ownership, durable reconciliation, timers, UI state | Split first |

The key problem is not missing correctness. It is that a maintainer must reconcile all of these at once:

- `novel.stage`
- `writing_jobs.status`
- `WritingRunState.phase`
- `isStreaming`
- `latestWritingJob`
- active/paused run refs and durable fetch generations

That is why small lifecycle changes create large tests and defensive comments.

## Non-negotiable invariants

Do not weaken these while refactoring:

1. The server persists the terminal novel/job truth before exposing a terminal frame.
2. A chapter is persisted before successful usage is recorded.
3. Lock release is idempotent across stream teardown and client cancellation.
4. A paused late chunk may preserve prose only; it may not mutate lifecycle state.
5. A stale durable read may not overwrite a newer run's local terminal.
6. The route remains the synchronous owner of authorization, preflight, and lock acquisition.

## Refactor sequence

### PR 1 — explicit run state

Create a pure `writing-run-reducer.ts`.

Events should describe facts rather than setters:

```ts
type WritingRunEvent =
  | { type: 'run-started'; runId: number; startedAt: string }
  | { type: 'phase-received'; runId: number; phase: WritingPhase; at: string }
  | { type: 'chapter-progress'; runId: number; chapterNumber: number; words: number }
  | { type: 'paused'; runId: number; at: string }
  | { type: 'failed'; runId: number; message: string; at: string }
  | { type: 'completed'; runId: number; at: string }
  | { type: 'durable-reconciled'; job: WritingJob | null; novel: Novel };
```

Keep abort controllers and timers outside the reducer. The reducer owns only state transitions.

### PR 2 — durable reconciliation

Move the `latestWritingJob` comparison, invalidated job IDs, and stale-fetch generation checks into a dedicated `useDurableWritingRun` hook.

Its output should be one command:

```ts
reconcileDurableSnapshot({ novel, chapters, writingJob })
```

The UI hook should not compare timestamps itself.

### PR 3 — transport controller

Extract start/pause/cancel and partial-prose bookkeeping into `useWritingTransport`.

It owns:

- the active `AbortController`
- run identity
- partial chapter capture
- pause cancellation
- the call to `startWritingSession`

It does not own durable job interpretation or presentation labels.

### PR 4 — workspace split

After the writing hook has a stable API, split `NovelWorkspace.tsx` into:

- `useNovelWorkspaceNavigation`
- `useNovelBundleExport`
- `AgentWorkspacePane`
- `StoryDeckWorkspacePane`
- `ManuscriptWorkspacePane`

Do not split visual fragments first. Split by ownership and side effects.

## Tests to retain versus replace

Retain:

- terminal persistence ordering
- pause/late-flush behavior
- stale durable read protection
- lock loss and cancellation
- chapter usage after persistence
- end-to-end full novel gate

Replace gradually:

- exact source string counts
- exact import/function names
- exact class ordering
- exact occurrence counts such as one spinner implementation appearing N times

Rendered behavior, accessibility, reducer transitions, and persisted outcomes are durable contracts. Source text is not.

## What the ratchet does

`pnpm check:maintainability`:

- fails if a known hotspot grows above its current reviewed ceiling;
- allows every reduction without editing a baseline;
- rejects a new oversized source file and rejects growth in an already-oversized legacy file;
- compares against `HEAD^`, while explicit named hotspots also have fixed reviewed ceilings;
- prints the intended next extraction boundary beside each remaining hotspot.

This prevents another AI pass from "solving" a local request by adding 150 lines to an already overloaded module.

## Completion criteria

The current ratchet entries can be removed when:

- `NovelWorkspace.tsx` is below 400 lines;
- `use-manuscript-session.ts` is below 350 lines;
- `start-writing-usecase.ts` is below 400 lines;
- the static design contract file is below 300 lines and no longer pins harmless source structure.
