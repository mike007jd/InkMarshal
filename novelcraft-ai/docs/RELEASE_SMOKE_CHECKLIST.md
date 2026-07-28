# macOS Release Smoke Checklist

Run this checklist on the exact final DMG after automated release gates pass. Keep the completed copy with the release evidence.

## Record

- Date and operator:
- Commit and version:
- DMG path:
- DMG SHA-256:
- macOS version and hardware:
- Mounted app executable path:

## Install and first launch

- [ ] Gatekeeper accepts the app with no damaged/unverified warning.
- [ ] The first-run flow reaches the Studio.
- [ ] Quit and relaunch preserves the session and local database.
- [ ] Only one InkMarshal process runs, and it belongs to the current package.

## Model path

- [ ] The curated starter shelf loads and a real model download completes, including pause/resume.
- [ ] Use starts the engine; a new novel generates one complete chapter.
- [ ] A real BYOK connection generates successfully and becomes unavailable after its key is removed.
- [ ] With physical network access disabled, local generation works and remote paths fail clearly.
- [ ] Stop a chat response mid-stream; the partial response persists once and retry/continue remains coherent.

## Writing and data

- [ ] Edit and save a chapter; content survives restart.
- [ ] Export a Chinese manuscript to EPUB, TXT, DOCX, PDF, and ZIP; every file opens and CJK glyphs render correctly.
- [ ] Backup and restore preserves manuscript, structure, and knowledge data.
- [ ] Force-quit and relaunch causes no data loss or migration error.

## System integration

- [ ] External links open only allowed destinations.
- [ ] Minimum window size and light/dark appearance remain usable.
- [ ] Removing the application leaves `~/.inkmarshal/app/` intact.
- [ ] Update/relaunch flushes manuscript state and returns to a healthy Studio.

## Result

- [ ] Every item passed.
- Evidence location:
- Failures and rerun reference:

Any failed item blocks the release until fixed and the complete checklist is rerun.
