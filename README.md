<p align="center">
  <img src="novelcraft-ai/public/inkmarshal-logo.png" width="136" alt="InkMarshal logo">
</p>

<h1 align="center">InkMarshal</h1>

<p align="center">
  <strong>Local-first AI novel-writing Studio</strong><br>
  Plan, draft, revise, and export long-form fiction without a required cloud account.
</p>

<p align="center">
  <a href="#download">Download for macOS</a> ·
  <a href="#run-from-source">Run from source</a> ·
  <a href="README_zh-CN.md">Chinese overview</a>
</p>

<p align="center">
  <img src=".github/readme/inkmarshal-studio-overview.svg" alt="Illustrated InkMarshal Studio overview showing manuscript, story, knowledge, and local writing paths" width="100%">
</p>

InkMarshal is a Tauri v2 desktop writing environment for the full novel: from
the first interview and story deck to continuous drafting, revision, and export.
Your manuscript lives locally in SQLite; use the bundled engine, a compatible
local server, or your own model connection when it suits the work.

## A manuscript room, not a cloud dashboard

| Shape the story | Carry the draft | Finish with confidence |
| --- | --- | --- |
| Turn an interview into a story structure, outline, knowledge, and project goals. | Draft resumable chapters with continuity memory and quality feedback. | Read, edit, rewrite, snapshot, recover, unify, back up, and export the book. |

<p align="center">
  <img src=".github/readme/local-first-flow.svg" alt="InkMarshal local-first flow from manuscript through the Studio and selected compute path to draft, revise, and export" width="100%">
</p>

## Yours by design

- **Local by default.** Manuscripts, settings, models, logs, and Vault projections stay on your machine.
- **Compute is your choice.** The bundled local engine comes first; compatible local servers and user-owned connections are available when needed.
- **No platform layer in the way.** InkMarshal does not require an account, hosted manuscript database, or platform credits to write.

## Download

**[Download the latest signed and notarized macOS release](https://github.com/mike007jd/InkMarshal/releases/latest)**

Current public builds target Apple Silicon macOS. Other platforms are not
published until they have signed, validated release paths.

## Run from source

```bash
git clone https://github.com/mike007jd/InkMarshal.git
cd InkMarshal/novelcraft-ai
corepack enable
pnpm install --frozen-lockfile
pnpm desktop:dev
```

Use the Node and pnpm versions declared by the package. See [CONTRIBUTING.md](CONTRIBUTING.md)
for toolchain setup, commands, gates, and local-data safety.

## Repository map

```text
InkMarshal/
├── novelcraft-ai/   desktop app, domain logic, and Tauri shell
├── spec/            current product, architecture, engineering, design, and UX contracts
├── docs/            documentation index
└── README_zh-CN.md  localized product overview
```

Documentation starts at [docs/README.md](docs/README.md). Privacy, security,
and third-party attribution are in [PRIVACY.md](PRIVACY.md),
[SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
