# macOS Release Smoke Checklist

Signed candidate artifacts only, after automated release gates: the exact final
DMG for install/reinstall and the exact updater artifact for update. Never use
this list for unsigned daily packages. Human UI checks only; keep the completed
copy with release evidence. Case detail lives in
[MANUAL_TEST_CASES.md](MANUAL_TEST_CASES.md) release-only and P0/P1 sections.

## Record

- Date and operator:
- Release evidence, prefilled: commit / expected version / DMG SHA-256:
- DMG path / version in **About InkMarshal**:
- macOS version and hardware:
- Evidence folder:

Use one new disposable macOS user for install and reinstall. Test update in a
separate disposable user containing the supported previous signed version and a
test novel. Every item must pass; `BLOCKED` or `NOT RUN` blocks release.

## Install and first launch

- [ ] Gatekeeper accepts the app; no damaged or unverified warning.
- [ ] First-run reaches My Desk / Studio.
- [ ] **About InkMarshal** matches the expected version from release evidence.
- [ ] Quit and relaunch keeps the novel list and **Assistant** content.
- [ ] Only one InkMarshal window and one matching process in Activity Monitor.

## Model path

- [ ] Starter **Download** → **Cancel** → **Retry** resumes; then **Use** works.
- [ ] **Approve & Begin Writing** produces one complete chapter in **Manuscript**.
- [ ] Bind non-production online AI to **Drafting**; test and generate; **Remove**
  leaves it absent and Drafting **Unbound**; key text is never shown.
- [ ] In **Capability Binding**, local Drafting works offline; online Drafting
  fails clearly with Wi-Fi off.
- [ ] Mid-stream **Stop**, then **Retry**: partial text once; retry
  coherent.

## Writing and data

- [ ] **Manuscript** save survives relaunch; **New snapshot** → **Restore** works.
- [ ] **Export Novel** (EPUB, TXT, DOCX, PDF) and **Export ZIP** open; CJK OK.
- [ ] **Backup and restore** / **Restore a backup** creates a separate copy.
- [ ] Force-quit while generation streams; saved marker remains and partial/
  chapter is not duplicated after relaunch.
- [ ] **Import manuscript** matches preview; a required second import cancelled
  before confirmation adds no novel.

## System integration

- [ ] **Help → Documentation** and **Help → Report Issue** open
  `github.com/mike007jd/InkMarshal` and its `/issues/new` page.
- [ ] Minimum window size and light/dark remain usable.
- [ ] Remove the app, reinstall from the same DMG; test novels still listed.
- [ ] From the supported previous signed version, **Update and restart** reaches
  the expected About version with the test manuscript intact.

## Result

- [ ] Every item passed.
- Failures and rerun reference:

Any failed item blocks release until fixed and this checklist is fully rerun.
