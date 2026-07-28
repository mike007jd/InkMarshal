# Project Constitution

This file contains stable product invariants. Architecture belongs in [SYSTEM_FRAMEWORK.md](SYSTEM_FRAMEWORK.md); implementation rules belong in [ENGINEERING_RULES.md](ENGINEERING_RULES.md).

## Product

1. InkMarshal is a local-first desktop writing Studio, not a hosted SaaS workspace or generic model console.
2. Tauri owns the shipped Studio. The sibling `../AiNovelSite` repository owns marketing, downloads, examples, and legal pages.
3. A writer can create, manage, and export a novel without an InkMarshal account or platform-prepaid generation.
4. The manuscript is the primary surface. AI, model management, knowledge, outline, and runtime controls support writing rather than dominate it.

## Data and trust

- Product data is local SQLite under `~/.inkmarshal/app/`; provider credentials are local/keychain-backed.
- Published user data is never reset, deleted, or silently discarded by startup.
- Every published schema change ships with a tested forward migration from all published schema versions.
- Destructive reset requires the explicit operator command documented in [CONTRIBUTING.md](../CONTRIBUTING.md).
- Untrusted input and structured AI output are validated at their boundaries. Cross-novel access and filesystem paths remain explicitly scoped.

## Runtime and model supply

- The bundled local engine is the default path.
- Detected compatible local servers and user-owned provider connections are secondary paths.
- Writing flows request capabilities such as draft, rewrite, or summarize; they do not bind directly to catalog model IDs.
- Current catalog IDs, sources, and verification dates live in `novelcraft-ai/lib/model-supply/catalog.ts` and `novelcraft-ai/lib/providers.ts`, not in prose.

## Prohibited regressions

- No cloud auth, cloud manuscript database, hosted Studio, Supabase runtime, generation credits, or Stripe generation checkout.
- No server-owned fallback provider keys.
- No public platform claim before a signed and validated release path exists.
- No speculative compatibility layer without a published consumer.

## Quality and documentation

- Complete changes include applicable tests, static gates, build verification, and runtime/visual verification where behavior is user-visible.
- Developer, design, release, ADR, and agent docs are concise English and describe current contracts.
- Code, manifests, tests, and live release state outrank stale prose. Update or remove conflicting documentation in the same change.
