# InkMarshal

> Local-first AI novel-writing Studio

[Chinese overview](README_zh-CN.md)

InkMarshal is a Tauri v2 desktop writing environment with local SQLite, local
or user-owned model connections, and no required cloud account. The sibling
`../AiNovelSite` repository owns the public website; this repository owns the
desktop product.

## Download

**[Download the latest signed and notarized macOS release](https://github.com/mike007jd/InkMarshal/releases/latest)**

Current public builds target Apple Silicon macOS. Other platforms are not published until they have signed, validated release paths.

## Quick start

```bash
git clone https://github.com/mike007jd/InkMarshal.git
cd InkMarshal/novelcraft-ai
corepack enable
pnpm install --frozen-lockfile
pnpm desktop:dev
```

Use the Node and pnpm versions declared by the package. See
[CONTRIBUTING.md](CONTRIBUTING.md) for toolchain setup, commands, gates, and
local-data safety.

## Repository map

```text
InkMarshal/
├── novelcraft-ai/   desktop app, domain logic, and Tauri shell
├── spec/            current product, architecture, engineering, design, and UX contracts
├── docs/            documentation index
└── README_zh-CN.md  localized product overview
```

Documentation starts at [docs/README.md](docs/README.md). Privacy, security, and third-party attribution are in [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
