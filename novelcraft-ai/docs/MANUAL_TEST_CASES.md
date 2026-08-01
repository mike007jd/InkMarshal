# Manual QA Handbook

Test the packaged Mac app through macOS UI only: no Terminal, source, DB, logs,
or automation. Use a clean local package daily; release uses the exact signed
DMG and updater with
[RELEASE_SMOKE_CHECKLIST.md](RELEASE_SMOKE_CHECKLIST.md).

## Boundaries

- Create a disposable user in **System Settings → Users & Groups**. Use only
  sample writing and non-production BYOK.
- S1/R1 need a user that has never opened InkMarshal. Run R1 and R3 in that same
  user; run R2 separately from the supported previous signed version.
- Bring a small Chinese manuscript or known-good import sample.
- Judge visible UI only. Record `PASS` / `FAIL` / `BLOCKED` / `NOT RUN`.
- Pass scope: fast = all S; extended = all S+E; release = every checklist item.
  Required `BLOCKED`/`NOT RUN` means the scope did not pass.
- Do not score Gatekeeper on unsigned daily packages.

## Run record (copy)

| Field | Value |
|---|---|
| Date / operator | |
| Scope | fast smoke / extended / release |
| Package kind | clean local package / exact signed DMG / updater |
| App or DMG path / app version | |
| macOS | |
| Local model / online AI ready | yes-no / yes-no |
| Network | online / offline |
| Result / evidence / defects | PASS-FAIL-BLOCKED / folder / IDs |

## P0 — Fast smoke

Each case: **Prereq** · **Actions** · **Pass** · **Evidence**.

**S1 First launch** — Fresh user/package. · Complete first-run. · My Desk/Studio
opens; one InkMarshal window. · Studio + package kind.

**S2 Persist** — S1 done. · **New Novel**; premise in **Assistant**; quit/reopen. ·
Novel and prior content remain. · My Desk + Assistant before/after.

**S3 Approve & chapter** — AI ready. · In **Assistant**, reach **Approve & Begin
Writing**; open **Story**, review, approve; wait for **Manuscript**. · One complete,
non-duplicated chapter. · Approve control + chapter.

**S4 Stop then Retry** — Stream active. · **Stop**; confirm partial once; **Retry**.
· No duplicate partial; retry coherent. · Stopped + retried output.

**S5 Snapshot** — Chapter in **Manuscript**. · Edit/save; **New snapshot**; edit;
**Restore**. · Snapshot text returns and survives relaunch. · Snapshot + restored text.

**S6 Export** — Chinese chapter. · **Export Novel** EPUB/TXT/DOCX/PDF and **Export
ZIP**; open them. · Files open, CJK renders, source unchanged. · Finder + formats.

**S7 Backup** — Chapters + Story Deck. · **Backup and restore**; back up; **Restore
a backup**. · Separate matching copy; original remains. · Both novels + chapters.

**S8 Force-quit generation** — Saved unique marker. · Start generation; when text
streams, macOS **Force Quit**; relaunch. · Marker remains; partial/chapter not
duplicated; app works. · Marker before + reopened manuscript.

## P1 — Extended

**E1 Download** — Models, disk, network ready. · **Download**; **Cancel**;
**Retry**; **Use**. · Retry resumes; incomplete is not ready; Use works. · States.

**E2 Online AI** — Test key. · Add/test in **Online & Custom AI**; bind to
**Drafting**; generate; **Remove**; reopen bindings. · It works before removal,
then disappears and Drafting is **Unbound**; key never shown. · Test/binding/output.

**E3 Offline** — Local/online ready. · Bind **Drafting** local; Wi-Fi off; generate.
Wi-Fi on; bind online; Wi-Fi off; generate. · Local works; online fails clearly;
UI responds. · Bindings + output/error.

**E4 Import** — File ready; note novel count. · **Import manuscript**; review and
confirm. Start again; cancel before confirm. · First matches preview; cancel adds
nothing. · Preview + before/after list.

**E5 Story Deck** — Cards exist. · In **Story**, edit/add; quit/reopen. · Changes
remain on that novel. · Before/after.

**E6 Assistant restart** — Existing thread. · Send/wait; quit/relaunch; reopen
**Assistant**. · Turns remain once each, ordered. · Reopened thread.

**E7 Window/UI/links** — Studio open. · Min window; light/dark; Tab focus; open
both **Help** links. · Usable, visible focus; browser opens
`github.com/mike007jd/InkMarshal` and its `/issues/new` page. · Window/
appearances/focus/URLs.

## Release-only (signed candidate artifacts)

Unsigned daily packages: skip. After automated gates, run these and
[RELEASE_SMOKE_CHECKLIST.md](RELEASE_SMOKE_CHECKLIST.md).

**R1 Gatekeeper** — Exact DMG; fresh user. · Install; open; check **About
InkMarshal** and Activity Monitor. · No warning; expected version; one window/
process. · Launch + About + process + DMG.

**R2 Update** — Separate user; previous signed version/test novel; candidate
offered. · Record About; **Update and restart**; recheck; reopen. · Target version
and manuscript. · Prompt + before/after About + chapter. No feed = `BLOCKED`.

**R3 App removal** — Test novel exists. · Quit; Trash app; reinstall same DMG;
open. · Prior test novels still listed. · My Desk before removal + after
reinstall.
