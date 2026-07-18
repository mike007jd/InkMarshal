# InkMarshal Local-First Writing Studio Requirements

Date: 2026-05-17
Status: Active product direction; desktop/local-first baseline is shipped. Future-only items must be called out as future.

## Background

InkMarshal will not use platform-prepaid credits as a cost model for long-form writing. Full-novel drafting, rewrite passes, chapter summaries, knowledge extraction, and whole-book unification can create heavy recurring model cost. The product must not front that cost and recover it through credits.

The new direction is not to reduce writing quality or hide generation. The direction is to keep InkMarshal as a literary writing workspace while moving default generation cost to user-owned runtime: user provider keys, self-hosted endpoints, local models, and desktop-managed assets.

## Core Decision

InkMarshal keeps the existing writing-studio experience and changes the model supply layer to:

- BYOK provider connections
- OpenAI-compatible cloud or self-hosted endpoints
- Local model runtime
- Curated Hugging Face model download and management
- Optional local workflow services for embeddings, summaries, style analysis, and manuscript assistance

The product moves from "platform sells credits for writing tokens" to "writers use their own keys, local models, self-hosted endpoints, and licensed InkMarshal workflows."

## Non-Goals

- Do not turn InkMarshal into a model manager, generic chat app, or Open WebUI-style console.
- Do not make users understand model internals before they can start writing.
- Do not remove the writing workspace, manuscript surface, outline, knowledge base, chapter flow, or export workflow.
- Do not keep platform credits anywhere in the product direction.
- Do not present Vercel-hosted online writing as the main product if desktop/local-first is the direction.
- Do not degrade long-form quality, continuity, or resumability to make local-first easier.

## Product Experience To Preserve

InkMarshal must still feel like a writing product:

- Literary brand and current book/manuscript visual language.
- Interview-first story setup and proposal approval before autonomous writing.
- Novel workspace with chat, files, knowledge, timeline, outline, conversations, and manuscript flow.
- Separate manuscript reading/review/editing surface.
- Chapter generation with visible progress and resumability.
- Whole-book unification, rewrite, selected-text editing, style refinement, and export.
- Local desktop mode that remains useful without an account. Future cloud sync, if introduced, must stay optional and must not become the default writing path.

The user-facing promise remains: "I am writing and managing a novel with InkMarshal." It must not become: "I am configuring models and running commands."

## New Model Supply Layer

### 1. Provider Connections

InkMarshal needs first-class user-owned provider connections:

- OpenAI
- Anthropic
- Google Gemini
- DeepSeek
- Moonshot / Kimi
- Qwen / DashScope
- Volcengine / Doubao
- SiliconFlow
- OpenRouter
- Stepfun
- Any OpenAI-compatible endpoint
- Local localhost endpoints

Connection methods:

- API key
- Bearer token
- Base URL + model id
- Local endpoint URL
- Provider-native auth only after a dedicated implementation exists; it is not a current shipped path.

Provider keys should not enter a platform-managed generation chain. Desktop should store secrets in the system keychain. Self-hosted deployments should use deployment-owned environment/config storage. Browser-only web mode can keep BYOK in local browser storage as a transitional path, but it is not the target secure storage model.

### 2. Hugging Face And Local Model Management

InkMarshal needs curated local model discovery and download. It should not expose the full Hugging Face catalog as an unfiltered model search surface.

Curated categories:

- Long-context writing LLM
- Fast draft model
- Rewrite/editor model
- Summarizer/knowledge extraction model
- Embedding model
- Reranker/recall model
- Style analysis model
- Lightweight offline assistant model

Required model-management behavior:

- Download into a local model directory
- Disk-space checks before download
- Resumable download
- File integrity verification
- Version and variant visibility
- Runtime compatibility checks
- Clear states: not downloaded, downloading, ready, missing dependency, incompatible hardware, failed
- Retry and repair actions that do not require manual terminal work

First supported runtime/model paths should prioritize:

- Ollama library models
- GGUF / llama.cpp
- MLX / mlx-lm on Apple Silicon
- OpenAI-compatible local servers

### 3. Runtime Broker

The writing pipeline should call a runtime broker, not a fixed platform model path. The broker chooses a capable runtime for each task:

- Story interview
- Greenlight/proposal generation
- Blueprint/outlining
- Chapter drafting
- Chapter continuation
- Rewrite/edit
- Chapter summary and key facts
- Knowledge extraction
- Whole-book unification
- Export-adjacent metadata

Supported backend classes:

- User BYOK cloud provider
- User OpenAI-compatible endpoint
- Ollama
- LM Studio
- llama.cpp server
- MLX server
- Local embedding service
- Optional future self-hosted team endpoint

The Studio should expose capability status, not raw backend complexity. A writer should see "drafting model ready", "rewrite model missing", or "connect provider to continue", not a low-level runtime error dump.

## Desktop Shape

Primary desktop direction: Tauri 2.

Reason: InkMarshal needs local files, manuscript projects, system keychain, model directories, sidecar process control, long-running generation, offline-first behavior, and runtime health checks. Tauri 2 can reuse the current web UI while giving the product a credible local-first shell.

Electron remains a fallback only if a later integration requires an Electron-only mature runtime ecosystem.

## Web / Vercel Shape (`../AiNovelSite`)

The separate `../AiNovelSite` repository is the public distribution surface on Vercel, not a writing runtime.

Web responsibilities:

- Landing page explaining InkMarshal as a long-form AI writing studio.
- Download page for macOS now; Windows only after a signed and validated release path exists.
- Pricing/license page for Desktop, Pro, team, and optional cloud sync.
- Docs/setup for provider connections, local models, Hugging Face downloads, and runtimes.
- Future license activation and device management if shipped.
- Optional future cloud sync. It must not create a required cloud account for local writing.

Web should not provide:

- Online Studio as the main product entry.
- Platform-prepaid generation.
- Credit purchase.
- Hosted provider calls as the default path after upload or draft start.

All primary CTAs such as "Open Studio", "Start Writing", and "Try Now" should move toward:

- Download for Mac
- View setup guide
- Open local app

If a web Studio remains, it must be demo, legacy, or optional cloud mode. It cannot reintroduce platform-funded credits.

## Information Architecture

The writing workspace remains the center. Supporting runtime controls should be discoverable but not dominant.

Add or promote these settings surfaces:

- Provider Connections: BYOK providers, custom endpoints, local endpoints.
- Local Models: curated model list, downloads, status, delete/update.
- Runtime Health: Ollama/LM Studio/llama.cpp/MLX availability, ports, hardware fit, recovery.
- Cost Mode: current task uses local model, user key, or self-hosted endpoint.
- Project Storage: local manuscript files, cloud sync status, export backup state.

These controls support writing. They should not turn the home screen into a model dashboard.

## Agent Behavior

The agent must route by writing capability:

- Understand the user task first: brainstorm, interview, outline, draft, continue, rewrite, edit, summarize, unify, export.
- Select an appropriate capability path: local model, BYOK provider, or self-hosted endpoint.
- Mix runtimes when useful, for example local model for chapter summaries and BYOK long-context model for final prose.
- Keep the writing flow uninterrupted when a suitable runtime exists.
- When a capability is missing, explain the missing requirement in product terms and provide the direct fix: connect provider, download model, start runtime, or choose another configured model.
- Never require users to manually choose every model step before writing can begin.

## Cost And Business Model

InkMarshal has no platform credits product path.

Recommended monetization:

- Desktop license
- Pro license for advanced long-form workflows
- Local model/runtime management
- Character memory and worldbuilding systems
- Whole-book unification and rewrite workflows
- Export/submission packages
- Cloud sync and device management
- Team/self-hosted license
- Template packs and genre workflow packs

Platform credits should be removed from product surfaces, docs, legal copy, billing, and default runtime decisions.

## Conflict With Existing Rules

Current code and docs still contain obsolete assumptions:

- Vercel AI Gateway as a platform-model list source.
- Platform credits and Stripe checkout.
- Server fallback provider paths.
- Landing copy that references gateway/platform models.

Those are obsolete paths, not product direction. For provider, billing, Studio, onboarding, or landing-page work, this document supersedes any older assumption that platform credits exist.

Implementation should migrate gradually without lying about shipped behavior:

- Current docs must not present credits as an available product path.
- Product strategy docs must say credits are removed, not legacy or optional.
- New code should route through user-owned runtime abstractions instead of expanding platform-credit coupling.

## Acceptance Criteria

The direction is complete when:

- Opening InkMarshal still shows a writing workspace, not a model console.
- A user can connect their own provider key or OpenAI-compatible endpoint.
- A user can download a curated local writing model.
- InkMarshal can detect local runtime availability and present understandable recovery actions.
- Long-form writing tasks route to local or BYOK runtime without platform-prepaid credits.
- Missing capability states are clear and actionable.
- Vercel entry points lead to download/setup/license flows instead of default hosted Studio generation.
- Landing, legal, billing, and provider docs no longer imply platform credits are the main product economy.
- The old Vercel Gateway/platform-credit path is removed from the user-facing product.

## First Delivery Boundary

A complete first implementation pass should include at least:

- Tauri 2 desktop shell direction confirmed and scaffolded around the current writing UI.
- Runtime broker abstraction for writing tasks.
- Provider Connections settings surface.
- OpenAI-compatible endpoint support preserved and promoted.
- Local Models panel with curated model metadata.
- One working local LLM route through Ollama, LM Studio, llama.cpp, or MLX.
- Runtime Health surface with actionable status.
- Agent routing updated from fixed platform model assumptions to capability routing.
- Platform credits removed from the default writing path.
- Vercel landing/download/license path updated so online Studio is not the main CTA.
