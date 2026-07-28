# UX Rules

This file defines durable interaction behavior. Route ownership is tracked in [the live surface matrix](../novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md).

## Experience model

InkMarshal is writing-first. Runtime, model, knowledge, and AI controls remain support surfaces.

Each novel has three first-class modes:

| Mode | Purpose |
|---|---|
| Agent | Interview, guidance, conversation, and workflow coordination |
| Story Deck | Story structure, outline, knowledge, goals, and planning |
| Read/Edit | Manuscript reading, editing, chapter navigation, recovery, and export |

Legacy query values may redirect to these modes, but documentation and new links use the canonical names.

## Chat and AI work

- Stream assistant output visibly and make Stop immediate.
- A stopped response is persisted once by the server lifecycle; retry/continue must not duplicate it.
- Long work shows its current phase and a direct recovery action.
- Missing capability is explained in product terms: start a runtime, download a compatible model, or configure a connection.
- Guided workflows use step/review/edit UI when generic chat would hide important state.

## Manuscript and persistence

- Reading/review and editing are distinct states within the Read/Edit mode.
- AI edits show a diff or explicit proposal before durable apply.
- Chapter edits commit only through the save/autosave pipeline. Export, backup, updater relaunch, and accepted AI edits flush required manuscript state first.
- Dirty chapter recovery is restored only when the stored chapter version still matches.
- Closing never masquerades as Save: unsent chat text, unsubmitted forms, and unaccepted AI diffs are transient and may be discarded.
- Completed SQLite writes remain committed; cancelled work resumes only from already durable progress.

## Navigation

- Navigation is explicit and stable; gestures are enhancements.
- The manuscript remains the largest canvas. Secondary rails collapse before the primary task is compressed.
- Hidden drawers and panels retain labeled recall controls.
- Deep links preserve relevant chapter, mode, and search state through canonical redirects.

## Feedback and safety

- Routine successful persistence stays quiet.
- Toasts announce meaningful outcomes that do not already have a visible inline state.
- Errors state what happened and the next safe action.
- Destructive actions identify scope, require explicit intent, and preserve recoverable data where practical.
- Local/offline/runtime state is visible wherever it changes available actions.

## Accessibility and localization

- All interactions are keyboard reachable with visible focus and semantic labels.
- Focus is contained and restored across modal surfaces.
- Layout and strings tolerate English, Simplified Chinese, and Traditional Chinese without clipping.
- Motion preferences, contrast, and non-color state cues follow [DESIGN_RULES.md](DESIGN_RULES.md).

## Verification

For changed behavior:

1. Run the relevant tests plus `pnpm verify`.
2. Exercise success, empty, loading, error, cancellation, and recovery states that apply.
3. Check representative window sizes and both appearance modes.
4. Update this file only for durable interaction rules; update the live surface matrix for route/owner changes.
