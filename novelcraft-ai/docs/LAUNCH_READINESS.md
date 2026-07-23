# Launch Readiness - InkMarshal

Last checked: 2026-07-23

This is the release operating document for the current prelaunch product after the maintainability audit. It describes the launch path that exists now. This documentation pass does **not** claim that signing, notarization, real-model, BYOK, offline, or manual GUI smoke passed.

## Launch Scope

Current public launch target:

- macOS Apple Silicon DMG.
- Public website from sibling repository `../../AiNovelSite`.
- Local-first desktop Studio.

Explicitly not in scope:

- Windows public release.
- Hosted web Studio.
- Login, account, cloud database, platform credits, or Stripe credit checkout.
- Server-owned provider API keys.

## Product Contracts (prelaunch)

- `pnpm verify` is lint, typecheck, Knip dead-code analysis, the full Vitest suite, an isolated 80-chapter full-novel QA gate, and production build.
- Local SQLite supports exactly the current schema v1 baseline. Empty/new databases are created at that shape only; incompatible nonempty databases fail closed without modification. Destructive cleanup is only through `pnpm local-state:reset -- --confirm-delete-inkmarshal-local-state`.
- DB + `knowledge_index` are canonical. Vault markdown is a durable outbox/tombstone projection of that truth.
- Desktop updater order: download → durable manuscript flush/snapshot → official Tauri install → relaunch.
- Security gate: Next 16.2.11, narrow `sharp` 0.35.3 override, OSV, and Cargo audit with an explicit advisory-ID allowlist.
- Outer unattended `scripts/ralph` loop is removed. The in-app Ralph writing workflow remains.

## Release Assets

Stable macOS asset names:

- `InkMarshal-mac-aarch64.dmg`
- `InkMarshal-mac-aarch64.dmg.sha256`
- `InkMarshal-mac-aarch64.app.tar.gz`
- `InkMarshal-mac-aarch64.app.tar.gz.sig`
- `latest.json`

Canonical public URL:

```text
https://github.com/mike007jd/InkMarshal/releases/latest/download/InkMarshal-mac-aarch64.dmg
```

The website release gate in `../../AiNovelSite` pins its download button to this URL.

## Required Local Toolchain

- Node 24.
- pnpm 10.15.x.
- Rust and Cargo.
- Xcode command line tools.
- Apple Developer ID Application certificate in the login keychain.
- Apple notarization credentials:
  - `APPLE_SIGNING_IDENTITY`
  - `APPLE_ID`
  - `APPLE_TEAM_ID`
  - `APPLE_PASSWORD`

Secrets must stay in the shell or local secret manager, never in `.env*` files.

## Preflight

Run from `novelcraft-ai/`:

```bash
pnpm install
pnpm verify
pnpm verify:security
pnpm verify:desktop
```

Run the desktop release gate before publish:

```bash
pnpm verify:release-desktop
```

With a local signed bundle present on macOS:

```bash
CHECK_LOCAL_MAC_BUNDLE=1 \
pnpm verify:release-desktop
```

## Build Sequence

1. Confirm `git status --short` contains only intended release changes.
2. Export Apple signing/notarization env vars in the shell.
3. Run:

```bash
pnpm release:mac
```

   `release:mac` performs clean packaging, full engine manifest verification, mounts the exact final DMG, launches exactly one process from that mount, and checks desktop runtime health before retaining release assets. That automatic exact-DMG oracle complements — and does not replace — the deeper real-machine checklist.

   The release builder re-signs every bundled Mach-O (Node, llama/MLX,
   dylibs, and native Node modules) with the configured Developer ID Team ID
   before signing the app. The app and inference engines have no Hardened
   Runtime exceptions; only the separately spawned Node runtime has
   `allow-jit`. The build fails if any nested code has another Team ID or
   retains library-validation, DYLD, unsigned-memory, executable-protection,
   or debug exceptions.

   Verify the exact signed app before publish:

```bash
codesign --verify --deep --strict src-tauri/target/aarch64-apple-darwin/release/bundle/macos/InkMarshal.app
codesign -d --entitlements :- src-tauri/target/aarch64-apple-darwin/release/bundle/macos/InkMarshal.app
pnpm verify:mac-library-validation src-tauri/target/aarch64-apple-darwin/release/bundle/macos/InkMarshal.app
```

4. Upload all five files from `dist/release/` to the GitHub Release:
   - `InkMarshal-mac-aarch64.dmg`
   - `InkMarshal-mac-aarch64.dmg.sha256`
   - `InkMarshal-mac-aarch64.app.tar.gz`
   - `InkMarshal-mac-aarch64.app.tar.gz.sig`
   - `latest.json`
5. Re-run the public gate with published-updater checks enabled:

```bash
CHECK_PUBLISHED_UPDATER=1 \
pnpm verify:release-desktop
```

   The release is blocked unless the manifest, updater archive, and signature all resolve publicly.
6. Run the manual smoke checklist in `docs/RELEASE_SMOKE_CHECKLIST.md`.

## Website Release

Vercel settings, public environment variables, and the website build gate are
owned by `../../AiNovelSite`. A website release must run that repository's
`pnpm verify` and production build gate; no `NEXT_PUBLIC_*` configuration belongs
in this desktop repository.

## Manual Smoke

The release is not launch-ready until a real macOS machine passes `docs/RELEASE_SMOKE_CHECKLIST.md`. Automated exact-DMG health smoke from `pnpm release:mac` is a packaging oracle only.

Critical paths still requiring human confirmation:

- DMG install and first launch.
- Model download, Use, engine start, and full chapter generation.
- Chat send, Stop, persisted partial reply, retry.
- BYOK key add/use/delete.
- Physical offline behavior.
- Chapter edit/save/restart.
- EPUB, TXT, DOCX, PDF, and ZIP export.
- Force quit and restart without data loss.
- Window sizing and theme switching.

## Hygiene Before Publish

Before final release tagging:

```bash
pnpm clean
git status --short --ignored
```

Confirm there are no committed or untracked release leftovers:

- logs
- screenshots
- audit bundles
- `.cargo-tools/`
- `.ui-audit/`
- `.superpowers/`
- local `.env*`
- generated `dist/release/` unless intentionally preparing local assets

Generated caches can be recreated by the documented scripts. Source files, icons, logo, fonts, and active app docs are not cleanup targets.

## Stop Conditions

Block release if any of these are true:

- `pnpm verify`, `pnpm verify:security`, or `pnpm verify:desktop` fails for a product reason.
- The DMG is not Developer ID signed and notarized.
- Gatekeeper or stapler validation fails.
- The public macOS download URL is not reachable.
- A Windows URL is configured.
- Production env contains cloud/provider/server secrets.
- Manual smoke fails in first-run, model, chat stop/retry, export, or restart persistence paths.
