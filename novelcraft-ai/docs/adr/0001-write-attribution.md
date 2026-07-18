# ADR 0001 — Mutation goes through a server action; client-fetch reads use an API route

- Status: Accepted
- Date: 2026-06-05

## Context

InkMarshal is a local-first desktop app (Tauri + Next standalone
Node runtime). It has two server-side write surfaces:

1. **Server Actions** (`app/actions/*`, `'use server'`) — invoked directly from
   client components, no hand-rolled fetch.
2. **API Route Handlers** (`app/api/**/route.ts`) — invoked via `fetch` from the
   client, or hit by streaming/SSE consumers.

The boundary between them had been drawn ad hoc per feature. The
clearest symptom: the **knowledge** feature **reads through an API route but
writes through a server action**, and the same form both `fetch`es and calls an
action — a split-brain that forced two mental models for one feature and let a
fourth, hand-written write path (the AI-summarize route) drift from the action's
write sequence (it originally skipped the vault `.md` sync the actions all do).

## Decision

- **All mutations go through a server action** (`app/actions/*`). Actions are the
  single write surface: they own validation, ownership checks, the DB+index
  transaction, and the vault/embedding side effects.
- **Use an API Route handler only when the client genuinely needs `fetch`
  semantics** that actions can't express:
  - **Streaming** responses: AI SDK UIMessage streams for chat; project NDJSON
    only for autonomous writing/editor workflows that carry workflow state.
  - **AbortSignal**-driven cancellation of a long server task.
  - **Binary / file** responses (export bundle download).
  - A **non-React or external** caller (a watcher, a probe).
- A read that only feeds a React render should prefer a Server Component or an
  action; reach for a `GET` route only when a client effect must re-fetch it.

## Shared write primitive

To keep the action path and any *justified* route write path (e.g. AI-summarize,
which is a route because it streams a model call + needs abort) from diverging,
the actual entry-write side effects are centralised:

- `lib/knowledge/apply-write.ts#applyKnowledgeEntryWrite` — DB row + index in one
  transaction, then best-effort vault `.md` sync, embedding invalidation, and a
  scheduled re-embed. Both `updateKnowledgeEntry` (action) and the summarize
  route call it, so the "what happens on a knowledge write" list lives once.
- `lib/knowledge/refresh-index.ts#buildIndexSyncInputForEntry` — the single
  entry-row → index-input projection (relations folded in, with optional
  add/exclude adjustments). Replaces three near-identical copies.

## Consequences

- New write features default to a server action; choosing a route requires one of
  the justifications above.
- The knowledge read-route/write-action split remains for now (the read route is
  consumed by a client effect), but no *new* feature should reproduce it.
