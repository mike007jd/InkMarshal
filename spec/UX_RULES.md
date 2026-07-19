# UX RULES — InkMarshal

> User experience rules for the live InkMarshal product.
> This document is intentionally biased toward shipped behavior and hard constraints.
> If a rule here disagrees with the code, update one of them immediately.

---

## 1. UX Philosophy

InkMarshal is a writing tool with a literary interface, not a general chat app.

Core principles:

1. **Writing first** — The interface should keep the user close to drafting, planning, and reading.
2. **Bookish, not gimmicky** — Use the existing manuscript / parchment / ink visual language consistently.
3. **Flow over ceremony** — Avoid extra confirmation steps in the core writing loop unless data loss is at stake.
4. **Visible state** — Novel stage, writing progress, and current mode must stay legible.
5. **Code is the source of truth** — Do not document target-state UX as if it is already shipped.

---

## 2. Shipped Product Baseline

The current product has these top-level surfaces:

- **Desktop Studio home** — Local-first Tauri shell backed by local SQLite and the fixed local user.
- **Novel workspace** — Desktop-only tabbed per-novel workspace with `chat`, `files`, `knowledge`, `timeline`, `outline`, and `conversations`.
- **Manuscript route** — Separate reading/review and editing workspace for generated chapters.
- **Public site (sibling repo)** — Marketing / download / legal content lives in `../AiNovelSite`, not in this Studio repo.

There is no shipped login, guest mode, signed-in Web shell, cloud account, hosted Studio, or platform credits flow. Do not write docs that imply one unless the routes actually return.

---

## 3. Chat UX Rules

### Current baseline

The shipped chat surface must preserve these behaviors:

1. **Immediate user echo** — The user message appears before the assistant reply completes.
2. **Visible thinking state** — A loading / thinking state appears while the assistant is generating.
3. **Streaming assistant text** — Assistant output streams incrementally and renders markdown.
4. **Interview-first onboarding** — Early novel setup is guided by interview state, not freeform chat alone.
5. **Proposal review gate** — The proposal summary is reviewed before the writing flow begins.
6. **Model selection is visible** — The current model or provider choice is surfaced in the chat header.
7. **Simple input model** — `Enter` sends, `Shift+Enter` inserts a newline.

The freeform novel chat and conversation threads use assistant-ui runtime primitives. Guided interview/proposal review and manuscript editing are workflow surfaces outside the assistant thread: they may call the AI kernel, but their UI contract is step/review/edit state rather than generic chat-message rendering.

### Current constraints

The live product does **not** currently guarantee these patterns across the app:

- Slash commands
- Attachment upload in the main chat box
- Per-message edit-and-regenerate
- Context budget visualizations
- Apply/save action buttons on every assistant response
- Universal command palette or global keyboard shortcut layer

Do not spec or describe these as existing behavior.

---

## 4. Manuscript UX Rules

### Current baseline

The manuscript route must preserve these behaviors:

1. **Separate manuscript surface** — Long-form reading and editing happen on the manuscript route, not inside the chat tab.
2. **Two primary modes** — Reading/review and editing are distinct modes within the manuscript shell.
3. **Live-writing visibility** — During autonomous writing, incoming chapter text is visibly streamed into the manuscript experience.
4. **Book-style reading** — The reading view keeps the current page-flip / book-reading metaphor.
5. **Selection-driven editing** — Editing tools operate from selected text and explicit user intent.
6. **Diff confirmation before apply** — AI-assisted edits are reviewed before they are committed.
7. **Revert path exists** — Reverting to original content remains possible where `originalContent` exists.
8. **Close is not Save** — Closing a window never blocks on manuscript persistence and never turns transient UI state into committed product data.
9. **Manuscript-only recovery** — Dirty chapter text is mirrored to the local recovery store and restored only when its chapter version still matches; it is not presented as a successful manuscript save.

### Commit boundaries

- Chapter edits become committed data only through the chapter autosave/explicit Save pipeline. Export, backup, update/relaunch, and accepting an AI diff flush that pipeline before using the manuscript.
- A typed but unsent chat message, an unsubmitted knowledge form, and an unaccepted AI diff are transient UI state. Closing discards them without a prompt.
- Completed API/SQLite writes remain committed. In-flight AI generation is cancelled when its owning view closes; any resumable writing session continues from its already committed progress after relaunch.

### Current constraints

The live manuscript UX should not be documented as having:

- Full zen mode
- Universal autosave across every manuscript action
- Global version history browser
- Persistent split editor + chat workspace
- Rich inline formatting toolbar
- Full keyboard shortcut coverage for all reading/editing actions

If any of these ship later, add them after the code lands.

---

## 5. Navigation And Responsive Rules

### Current baseline

1. **Wide desktop keeps persistent side structure** where it does not compress the primary task; below `xl`, global workspace navigation becomes a drawer so a task-local rail and the manuscript never compete with two persistent sidebars.
2. **Constrained windows collapse navigation into drawers or toggles**, not multi-column layouts; hidden drawers must leave a clearly labeled recall control.
3. **The right-side project panel is optional and screen-size dependent**, not always visible.
4. **Novel workspace views switch explicitly by tab**, not by hidden gesture-only flows.
5. **Manuscript navigation supports explicit controls first**; gestures are enhancements, not the only path.

### Current constraints

Do not document these as current product behavior:

- Bottom-tab app shell across the whole product
- Three-panel always-visible desktop dashboard
- Guaranteed split editor/chat layouts on large screens
- Pull-to-refresh or floating action button conventions as part of the product baseline

---

## 6. Feedback And Loading Rules

The live product should keep feedback lightweight and legible.

1. **Toasts are for meaningful outcomes** — errors, purchase results, export failures, copy success, and similar state changes.
2. **Long AI operations need visible progress states** — thinking, writing, chapter completion, or stage progress.
3. **Routine persistence should stay quiet** unless the user needs to act.
4. **Errors should explain the next move** — retry, configure a local/provider connection, restart a local runtime, or refresh.
5. **Local-first state must stay explicit** where behavior depends on desktop runtime availability.

Do not promise persistent cross-page progress notifications or advanced retry orchestration unless they are actually implemented.

---

## 7. Future Target Direction

Provider, billing, Studio, and landing work now follows [LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md](./LOCAL_FIRST_WRITING_STUDIO_REQUIREMENTS.md). The user-facing experience must stay writing-first: local runtime, model downloads, provider connections, and cost mode are support surfaces, not the main workspace. Public Studio entry points show the macOS download until another platform has a signed and validated release path; platform credits do not exist.

These are valid directions, but they are not guaranteed shipped behavior:

- Richer context controls for AI conversations
- Message editing and regeneration
- More complete keyboard shortcut coverage
- Stronger manuscript reading controls such as zen mode or reading preferences
- More advanced model comparison or cost preview UX
- Broader inline AI editing affordances

When one of these moves from aspiration to implementation, rewrite the relevant section above instead of piling on another target-state note.
