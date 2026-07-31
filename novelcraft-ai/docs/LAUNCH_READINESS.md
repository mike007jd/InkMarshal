# macOS Release Runbook

This file retains its historical name to preserve links. It is the operating procedure for every published Apple Silicon macOS release.

## Boundaries

- Packaging, Git tagging, GitHub upload/release mutation, and website deployment are separate actions.
- A package is not ready until it is built cleanly, validated from the exact final DMG, and passes the manual checklist.
- Published SQLite/Vault data, updater manifest shape, and stable asset names are compatibility contracts.
- Windows and other platforms remain unpublished until their signed and validated paths exist.

## Stable assets

Every macOS updater release contains:

- `InkMarshal-mac-aarch64.dmg`
- `InkMarshal-mac-aarch64.dmg.sha256`
- `InkMarshal-mac-aarch64.app.tar.gz`
- `InkMarshal-mac-aarch64.app.tar.gz.sig`
- `latest.json`

Canonical download:

```text
https://github.com/mike007jd/InkMarshal/releases/latest/download/InkMarshal-mac-aarch64.dmg
```

Do not rename published assets without an updater migration covering every published version.

## Toolchain and secrets

Use the Node/pnpm versions declared by the package, stable Rust, Xcode command-line tools, a Developer ID Application certificate, and a notarytool keychain profile.

The release scripts require these non-secret process-environment values:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_TEAM_ID`
- `APPLE_NOTARY_KEYCHAIN_PROFILE`

Notarization authenticates only via `notarytool --keychain-profile`. Create the profile once with
`xcrun notarytool store-credentials`; `release:mac` preflights it with `notarytool history` before
cleaning or building. Do not pass Apple ID or app-specific passwords on the release command line,
and do not load them from `apple.env`.

## Preflight

Run from `novelcraft-ai/`:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm verify:security
pnpm verify:desktop
pnpm verify:third-party-notices
git status --short
```

Stop any non-release InkMarshal instance before packaging. Resolve every product failure and confirm the intended source state before continuing.

## Clean package

```bash
pnpm release:mac
```

`release:mac` is the required packaging entry point. It:

1. stops InkMarshal/desktop runtime processes;
2. detaches stale InkMarshal DMGs;
3. removes packaged artifacts and cleans the Tauri target;
4. fetches and verifies engine resources;
5. signs nested native code and the app;
6. builds, notarizes, staples, and validates release assets;
7. mounts the exact final DMG;
8. launches exactly one app process from that mount and checks runtime health.

Do not validate an older mount, `/Applications/InkMarshal.app`, an incremental bundle, or a prior `dist/release` artifact as the new package.

## Verify the exact output

```bash
CHECK_LOCAL_MAC_BUNDLE=1 pnpm verify:release-desktop
```

Also confirm:

- `codesign --verify --deep --strict` succeeds for the final app;
- Gatekeeper accepts the final DMG/app;
- stapling validates;
- the updater archive is created with `COPYFILE_DISABLE=1`;
- `scripts/verify-updater-archive.mjs` confirms one signed `InkMarshal.app` root
  with no AppleDouble, `._*`, or `.DS_Store` members;
- the updater Minisign signature and `latest.json` match the final archive;
- exactly one running InkMarshal process points inside the current DMG mount.

Run [RELEASE_SMOKE_CHECKLIST.md](RELEASE_SMOKE_CHECKLIST.md) against that package before calling it ready.

## Publish verification

Uploading or changing a GitHub release requires separate authorization. When authorized, upload all five stable assets without moving an existing tag, then run:

```bash
CHECK_PUBLISHED_UPDATER=1 pnpm verify:release-desktop
```

The published manifest, archive, signature, checksum, and canonical DMG URL must all resolve and agree.

Website work is owned by `../../AiNovelSite` and runs that repository's independent verification/deployment flow.

## Stop conditions

Block release when:

- any applicable verification gate fails for a product reason;
- the exact final DMG is not signed, notarized, stapled, or Gatekeeper-accepted;
- more than one InkMarshal instance runs during package smoke;
- the running executable is not inside the current final DMG mount;
- updater assets are missing, inconsistent, unreachable, or fail the raw-tar AppleDouble gate;
- manual first-run, model, offline, writing, export, or recovery smoke fails;
- a platform URL is configured without a signed validated build;
- secrets or local user data appear in source or release assets.
