# Design Rules

InkMarshal should feel like a focused manuscript room: literary, calm, dense enough for serious work, and subordinate to the writing.

## Code-owned sources

Do not copy token values or component examples into this document.

| Contract | Source |
|---|---|
| Color, type, spacing, radius, shadow, and motion tokens | `novelcraft-ai/app/globals.css` |
| Loaded fonts | `novelcraft-ai/app/layout.tsx` |
| Semantic primitives | `novelcraft-ai/components/ui/` |
| Enforced UI invariants | `novelcraft-ai/components/design-system-contract.static.test.ts` |
| Shipped surfaces | `novelcraft-ai/docs/LIVE_SURFACE_MATRIX.md` |

## Product design principles

- The manuscript is the center of gravity; chrome, AI, knowledge, outline, and model controls support it.
- Use literary typography and restrained parchment/ink/gold semantics without imitating a decorative book everywhere.
- Recovery, offline, downloading, and unavailable-model states are designed product states, not raw errors.
- Use plain writing language. Avoid account, credits, billing, or cloud-dashboard metaphors that do not exist in the product.
- Prefer stable full-height work surfaces and predictable navigation over floating dashboards or decorative cards.

## Visual system

- Components consume semantic `book-*` tokens; raw palette utilities and component-local hex colors are defects except in explicitly tested render-time constraints.
- Prose uses the manuscript type role; controls use the interface type role; technical identifiers and measurements use the mono role.
- Never reduce UI text below the accessibility floor defined in `globals.css`.
- Keep prose measure readable. The manuscript must remain the largest visual region at supported window sizes.
- Cards represent bounded records or proposals. Do not wrap entire application sections in decorative cards.
- Lucide is the standard icon set. Icon-only actions require accessible names.

## Component invariants

- Business actions use the canonical `Button`; call sites do not invent shape.
- Circular controls require a named semantic primitive. Page turning uses `PageTurnButton`.
- Streaming stop/pause behavior uses `StopStreamingButton`.
- Empty content uses the `Empty` family; loading uses `Spinner`; errors remain distinct.
- Form controls, dialogs, menus, sheets, tabs, and tooltips use the locally owned primitives.
- New exceptions must be named, owned by one component, and enforced in the static design-contract test.

## Motion

- CSS in `app/globals.css` is the motion source of truth; no JavaScript motion library is part of the design system.
- Feedback is fast, exits are no slower than entries, spatial travel is small, and decorative continuous motion is forbidden.
- Components consume semantic motion utilities rather than literal durations, easing classes, `transition-all`, or arbitrary keyframes.
- `Spinner` owns continuous work indication. Page-turn behavior is the only approved signature motion.
- Reduced-motion behavior must preserve lifecycle cleanup while making non-essential motion effectively instant.

## Responsive behavior

- Protect the primary writing canvas before preserving secondary rails.
- Global navigation collapses below wide desktop; hidden navigation always has a labeled recall control.
- Do not require a gesture when a visible control can provide the same action.
- Validate the minimum supported window, a typical desktop window, and light/dark appearance for affected surfaces.

## Accessibility

- Meet WCAG AA contrast for text and interactive states.
- Preserve keyboard access, visible focus, semantic labels, and correct dialog/menu focus behavior.
- Do not rely on color, motion, hover, or icon shape alone to communicate state.
- Touch/click targets and reading size must remain usable at constrained dimensions.

## Change checklist

1. Reuse an existing token and primitive.
2. Add a semantic token/primitive only when no existing role fits.
3. Update the static design contract for new durable invariants.
4. Run `pnpm check:ui-framework` and `pnpm verify`.
5. Interact with and visually inspect the changed surface.
