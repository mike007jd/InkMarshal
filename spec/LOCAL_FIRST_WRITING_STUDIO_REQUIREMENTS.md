# Local-First Writing Studio Requirements

Status: current product contract.

## Goal

InkMarshal enables long-form novel planning, drafting, revision, continuity
work, and export on user-owned compute and credentials. The product remains
useful without an InkMarshal account, hosted manuscript database, or
platform-prepaid generation.

## Product shape

- Tauri v2 is the shipped Studio runtime.
- The manuscript, Agent, and Story Deck are the primary writing experience.
- Model downloads, provider connections, runtime health, usage, and recovery support writing; they do not turn the product into a generic model console.
- Public distribution currently targets signed and validated Apple Silicon macOS builds.
- The sibling `../AiNovelSite` repository owns marketing, legal pages, examples, setup guidance, and download handoff.

## Writing capabilities

The product supports:

- interview and proposal/greenlight;
- story structure, outline, knowledge, and project goals;
- resumable chapter drafting with continuity memory and quality feedback;
- reading, editing, targeted rewrite, snapshots, and recovery;
- conversation and knowledge extraction;
- whole-book unification;
- backup/restore and supported export formats.

These flows request capability roles rather than specific catalog model IDs.

## Runtime priority

1. Bundled local engine.
2. Detected compatible local servers.
3. User-owned cloud or custom OpenAI-compatible connections.

The resolver may use different ready connections for drafting, rewriting, summarizing, embedding, or other roles. If no capable route exists, the UI gives a direct fix rather than exposing a low-level provider failure.

Current supported providers, endpoints, model IDs, sources, and freshness dates are code-owned in `novelcraft-ai/lib/providers.ts` and `lib/model-supply/catalog.ts`.

## Local data and security

- Manuscripts, settings, logs, models, and Vault projections remain local by default.
- Provider secrets use the OS keychain with the documented restricted fallback.
- Normal startup never deletes or resets published user data.
- Schema evolution uses tested forward migrations from every published schema.
- Model downloads support integrity checks, resumability, compatibility/readiness states, and actionable repair.
- Credentials and manuscript data are never included in model bundles, updater assets, or optional future sync by default.

## Non-goals

- Hosted Studio, cloud auth, or cloud manuscript database.
- Platform credits or Stripe-funded generation.
- Server-owned provider fallback keys.
- Requiring model expertise before a writer can begin.
- Degrading continuity, recovery, or export safety to simplify local runtime work.
- Claiming a platform or integration is available before its signed/runtime path is verified.

## Acceptance

The contract is satisfied when:

- a fresh supported desktop install can reach a usable writing path without a cloud account;
- a writer can use the bundled engine or configure a user-owned compatible connection;
- missing models/runtimes produce understandable recovery actions;
- long-form operations remain resumable and protect committed manuscript state;
- local data survives restart, update, application removal, and failed migrations;
- the public website hands off to supported downloads rather than a hosted writing runtime;
- user-facing and developer docs contain no platform-credit or cloud-workspace assumptions.

Future sync or collaboration requires the separate decision gate in [deferred-sync-collab.md](roadmap/deferred-sync-collab.md); it is not part of the current product.
