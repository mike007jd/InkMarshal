# DESIGN RULES — InkMarshal

> Visual design system for a professional AI novel-writing platform.
> Every component must conform to these rules. No exceptions.

---

## 1. Design Philosophy

InkMarshal is a **writing tool**, not a social media app. The design must:

- **Disappear when writing** — The UI fades into the background so writers can focus on words
- **Feel literary** — Typography, spacing, and color choices evoke the quality of a well-set book
- **Respect the craft** — No gimmicky animations, no gratuitous gradients, no attention-stealing elements
- **Serve the content** — AI-generated text and user prose are the visual centerpiece, not chrome
- **Stay local-first** — Studio surfaces should feel like a focused manuscript room with model operations, not a cloud SaaS dashboard

### Product Design DNA

- The manuscript is the center of gravity; outline, knowledge, model readiness, and assistant panels support it instead of competing with it.
- Desktop Studio surfaces use a unified cockpit rhythm: persistent shell, clear active work surface, dense side panels, and stable full-height layouts.
- Model/runtime surfaces must show readiness, source, format, and role binding clearly; recovery states are part of the design, not error afterthoughts.
- Cards are for records, proposals, knowledge entries, model rows, and dialogs. Do not wrap whole app sections in decorative cards.
- Use plain writing-studio language: local, model, manuscript, outline, knowledge, draft, rewrite, export. Avoid account, plan, credits, or billing language unless that feature exists in code.

---

## 2. Design Token System

All visual values are expressed as **design tokens**. Never hardcode colors, spacing, or typography values directly. Use Tailwind CSS custom properties defined in `globals.css`.

### Token Hierarchy

```
Global Tokens (raw values)
    ↓
Semantic Tokens (purpose-driven aliases)
    ↓
Component Tokens (component-specific overrides)
```

### Defining Tokens

```css
/* app/globals.css */
@import "tailwindcss";

@theme {
  /* --- Color Palette --- */
  --color-ink-950: #0a0a0f;
  --color-ink-900: #121218;
  --color-ink-800: #1e1e28;
  --color-ink-700: #2a2a38;
  --color-ink-600: #3d3d50;
  --color-ink-500: #55556e;
  --color-ink-400: #7e7e9a;
  --color-ink-300: #a8a8c0;
  --color-ink-200: #d0d0e0;
  --color-ink-100: #e8e8f0;
  --color-ink-50: #f4f4f8;

  --color-parchment-50: #fdfcfa;
  --color-parchment-100: #f8f6f0;
  --color-parchment-200: #efe9db;
  --color-parchment-300: #e2d8c4;
  --color-parchment-400: #c9b896;

  --color-accent-indigo: #6366f1;
  --color-accent-violet: #8b5cf6;
  --color-accent-amber: #f59e0b;
  --color-accent-emerald: #10b981;
  --color-accent-rose: #f43f5e;

  /* --- Semantic Colors --- */
  --color-bg-primary: var(--color-parchment-50);
  --color-bg-secondary: var(--color-parchment-100);
  --color-bg-tertiary: var(--color-parchment-200);
  --color-bg-inverse: var(--color-ink-900);

  --color-text-primary: var(--color-ink-900);
  --color-text-secondary: var(--color-ink-500);
  --color-text-tertiary: var(--color-ink-400);
  --color-text-inverse: var(--color-parchment-50);

  --color-border-default: var(--color-ink-100);
  --color-border-strong: var(--color-ink-200);

  --color-interactive: var(--color-accent-indigo);
  --color-interactive-hover: #4f46e5;

  --color-success: var(--color-accent-emerald);
  --color-warning: var(--color-accent-amber);
  --color-error: var(--color-accent-rose);
  --color-info: var(--color-accent-indigo);

  /* --- AI Provider Colors --- */
  --color-ai-anthropic: #d4a574;
  --color-ai-openai: #10a37f;
  --color-ai-gemini: #4285f4;
  --color-ai-deepseek: #0066ff;

  /* --- Spacing Scale --- */
  --spacing-px: 1px;
  --spacing-0: 0;
  --spacing-0-5: 0.125rem;
  --spacing-1: 0.25rem;
  --spacing-1-5: 0.375rem;
  --spacing-2: 0.5rem;
  --spacing-2-5: 0.625rem;
  --spacing-3: 0.75rem;
  --spacing-4: 1rem;
  --spacing-5: 1.25rem;
  --spacing-6: 1.5rem;
  --spacing-8: 2rem;
  --spacing-10: 2.5rem;
  --spacing-12: 3rem;
  --spacing-16: 4rem;
  --spacing-20: 5rem;
  --spacing-24: 6rem;

  /* --- Border Radius --- */
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;
  --radius-2xl: 1rem;
  --radius-full: 9999px;

  /* --- Shadows --- */
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -4px rgba(0, 0, 0, 0.04);
  --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.08), 0 8px 10px -6px rgba(0, 0, 0, 0.04);

  /* --- Z-Index Scale --- */
  --z-dropdown: 50;
  --z-sticky: 100;
  --z-overlay: 200;
  --z-modal: 300;
  --z-toast: 400;
  --z-tooltip: 500;
}
```

### Dark Mode

Dark mode inverts the semantic tokens. Use `@media (prefers-color-scheme: dark)` or a class-based toggle.

```css
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg-primary: var(--color-ink-950);
    --color-bg-secondary: var(--color-ink-900);
    --color-bg-tertiary: var(--color-ink-800);
    --color-bg-inverse: var(--color-parchment-50);

    --color-text-primary: var(--color-ink-100);
    --color-text-secondary: var(--color-ink-400);
    --color-text-tertiary: var(--color-ink-500);
    --color-text-inverse: var(--color-ink-900);

    --color-border-default: var(--color-ink-700);
    --color-border-strong: var(--color-ink-600);
  }
}
```

---

## 3. Typography

### Font Stack

```css
@theme {
  /* Prose / reading font — serif for the literary feel */
  --font-serif: "Lora", "Georgia", "Cambria", "Times New Roman", serif;

  /* UI font — clean sans-serif for interface elements */
  --font-sans: "Inter", "system-ui", "-apple-system", "Segoe UI", "Roboto", sans-serif;

  /* Code / monospace — for word counts, stats, token displays */
  --font-mono: "JetBrains Mono", "Fira Code", "Consolas", monospace;
}
```

### Type Scale

| Token | Size | Line Height | Usage |
|---|---|---|---|
| `text-xs` | 0.75rem (12px) | 1rem | Captions, fine print |
| `text-sm` | 0.875rem (14px) | 1.25rem | Secondary text, labels |
| `text-base` | 1rem (16px) | 1.5rem | Body text, UI elements |
| `text-lg` | 1.125rem (18px) | 1.75rem | Lead paragraphs |
| `text-xl` | 1.25rem (20px) | 1.75rem | Section headers |
| `text-2xl` | 1.5rem (24px) | 2rem | Page headers |
| `text-3xl` | 1.875rem (30px) | 2.25rem | Feature headers |
| `text-4xl` | 2.25rem (36px) | 2.5rem | Hero text |

### Typography Rules

1. **Prose content uses serif font** — Novel text, chapter content, AI-generated writing
2. **UI elements use sans-serif font** — Buttons, labels, navigation, controls
3. **Statistics use monospace font** — Word counts, token counts, costs, progress numbers
4. **Maximum reading width: 65ch** — Prose content must not exceed 65 characters per line
5. **Paragraph spacing: 1.5em** — Clear separation between paragraphs for readability
6. **No font size below 12px** — Accessibility minimum

### Tailwind Typography Plugin

Use `@tailwindcss/typography` for all long-form prose content. Apply the `prose` class:

```tsx
<article className="prose prose-lg prose-ink max-w-prose mx-auto">
  {chapterContent}
</article>
```

Custom prose theme overrides:

```css
.prose-ink {
  --tw-prose-body: var(--color-text-primary);
  --tw-prose-headings: var(--color-ink-900);
  --tw-prose-links: var(--color-interactive);
  --tw-prose-bold: var(--color-ink-900);
  --tw-prose-quotes: var(--color-ink-600);
  --tw-prose-quote-borders: var(--color-accent-indigo);
}
```

---

## 4. Color System Usage

### When to Use Each Color

| Color | Usage | Example |
|---|---|---|
| `bg-primary` | Main content areas | Page background, editor |
| `bg-secondary` | Sidebars, cards | Novel card, sidebar |
| `bg-tertiary` | Hover states, selections | Hovered sidebar item |
| `bg-inverse` | High contrast elements | Dark header, tooltips |
| `text-primary` | Main readable text | Body copy, headings |
| `text-secondary` | Supporting text | Dates, metadata, labels |
| `text-tertiary` | Decorative text | Placeholders, disabled |
| `interactive` | Clickable elements | Buttons, links, CTAs |
| `success` | Positive states | Save confirmation, word count met |
| `warning` | Caution states | Token limit approaching |
| `error` | Error states | Validation errors, failures |
| `ai-*` | AI provider identity | Provider badges, model selectors |

### Color Rules

1. **Never use raw hex/rgb values in components** — Always reference tokens
2. **Maximum 3 colors per component** — Background, text, and one accent
3. **AI provider colors only for provider identity** — Badges, icons, model selectors
4. **Parchment tones for writing surfaces** — Editor backgrounds, reading views
5. **Ink tones for text hierarchy** — Dark-to-light for primary-to-tertiary

---

## 5. Spacing System

### Spacing Rules

1. **Use the 4px grid** — All spacing values are multiples of 4px (0.25rem)
2. **Consistent internal padding** — Cards: `p-6`, Buttons: `px-4 py-2`, Inputs: `px-3 py-2`
3. **Section spacing** — Between major sections: `space-y-8` or `gap-8`
4. **Component spacing** — Between sibling components: `space-y-4` or `gap-4`
5. **Tight spacing for related elements** — Labels to inputs: `space-y-1.5`

### Layout Widths

| Element | Max Width | Tailwind |
|---|---|---|
| Prose/reading content | 65ch | `max-w-prose` |
| Form content | 32rem (512px) | `max-w-lg` |
| Card grid | 80rem (1280px) | `max-w-7xl` |
| Full dashboard | 96rem (1536px) | `max-w-screen-2xl` |
| Sidebar | 16rem (256px) | `w-64` |
| Chat panel | 48rem (768px) | `max-w-3xl` |

---

## 6. Icon System — Lucide React

### Usage Rules

1. **Lucide React is the only icon library** — No Font Awesome, no Heroicons, no custom SVGs for standard UI icons
2. **Default size: 20px** — Use `size={20}` for most icons
3. **Small icons: 16px** — For inline text, badges, tight spaces
4. **Large icons: 24px** — For navigation, empty states, feature highlights
5. **Stroke width: 2** — Default. Use `strokeWidth={1.5}` for light/decorative usage
6. **Color inherits from text** — Use `className="text-current"` or the parent's text color

### Common Icon Mapping

```typescript
import {
  // Navigation
  Home, BookOpen, MessageSquare, Settings, CreditCard,
  // Actions
  Plus, Pencil, Trash2, Save, Download, Upload, Copy,
  // AI / Chat
  Bot, Sparkles, Zap, Brain, Wand2,
  // Novel
  BookText, FileText, Users, Globe, Bookmark,
  // Status
  Check, X, AlertTriangle, Info, Loader2,
  // Layout
  Menu, ChevronLeft, ChevronRight, ChevronDown, Search,
  // Auth
  LogIn, LogOut, User, Mail, Github,
} from "lucide-react";
```

### Icon + Text Pairing

```tsx
// CORRECT: Icon aligned with text
<button className="inline-flex items-center gap-2">
  <Plus size={20} />
  <span>New Novel</span>
</button>

// CORRECT: Icon-only button with accessible label
<button aria-label="Delete novel" className="p-2">
  <Trash2 size={20} />
</button>
```

---

## 7. Component Design Patterns

### Control Shape Follows Semantic Role (design-drift invariants, 2026-07-14)

These are enforced by `components/design-system-contract.static.test.ts` (`pnpm check:ui-framework`). They are convergence rules: the same control must not look like two different things in two different surfaces.

1. **Ordinary clickable actions inherit the canonical `Button` radius.** A business `<Button>` call site never sets a `rounded-*` utility — not directly, and not through a class constant. Shape is decided by the primitive, not by whoever wrote the screen.
2. **Circular geometry belongs to a named semantic role.** Book page turning lives in `PageTurnButton`; both book surfaces render that contract rather than hand-rolling book-page-turn circles. The assistant thread's scroll-to-bottom control remains round inside its named `TooltipIconButton` primitive.
3. **Business pill/dot exceptions are explicit and counted.** The collapsed stage status toggle uses `data-shape="stage-pill"`; the tiny healthy-model control uses `data-shape="model-health-dot"`. Each attribute is pinned to its owning component and may appear exactly once.
4. **The stop-stream control has exactly one shape and owns its density.** `StopStreamingButton` takes no `shape` prop; it owns compact inline and comfortable full-width height internally. Call sites vary label, width and icon scale only.
5. **Content-level empty states use the `Empty` family** (`components/ui/empty.tsx`), with explicit base and desktop density per audited surface. Loading and error stay separate — an empty state is not a spinner and not an error.
6. **A clickable status control must look actionable and stable.** A compact model-status control (`WritingModelStatusBar`) carries `Settings2`; its pre-mount placeholder uses the same rounded-md outline so hydration does not visibly switch from pill to control.

### Button Variants

```
Primary:    bg-interactive text-white          → Main actions (Save, Create, Generate)
Secondary:  bg-secondary text-primary border   → Secondary actions (Cancel, Back)
Ghost:      bg-transparent hover:bg-tertiary   → Tertiary actions (icon buttons, links)
Danger:     bg-error text-white                → Destructive actions (Delete)
```

### Button Sizes

```
sm:   px-3 py-1.5  text-sm    → Compact contexts (table rows, inline)
md:   px-4 py-2    text-base  → Default
lg:   px-6 py-3    text-base  → Hero CTAs, prominent actions
```

### Card Pattern

```tsx
<div className="rounded-xl border border-default bg-secondary p-6 shadow-sm">
  <h3 className="text-lg font-semibold text-primary">Title</h3>
  <p className="mt-1 text-sm text-secondary">Description</p>
  <div className="mt-4">{children}</div>
</div>
```

### Input Pattern

```tsx
<div className="space-y-1.5">
  <label className="text-sm font-medium text-primary">Label</label>
  <input
    className="w-full rounded-lg border border-default bg-primary px-3 py-2
               text-base text-primary placeholder:text-tertiary
               focus:border-interactive focus:outline-none focus:ring-2 focus:ring-interactive/20"
  />
  <p className="text-sm text-error">Error message</p>
</div>
```

---

## 8. Motion (CSS-first)

`app/globals.css` is the single motion source of truth: foundation tokens feed semantic presets, and components consume only those presets. InkMarshal does not use a JavaScript motion library.

### Principles

1. **Frequent feedback completes within 120ms** — Hover, press, focus, and chevron feedback must settle before the next likely input.
2. **Exit is never slower than entry** — Entry is at most 240ms; exit is at most 180ms and must release pointer ownership immediately.
3. **Spatial motion stays small** — Travel is at most 8px, overlay scale never starts below 0.98, and overshoot, springs, and entry stagger are forbidden.
4. **State is primary; motion is supporting evidence** — Shape, color, icon, and copy communicate status immediately. Infinite motion is reserved for active work and stops when work ends; the writing canvas has no decorative motion.
5. **Components do not invent timing** — Literal duration utilities, built-in easing utilities, broad transitions, and arbitrary animations are defects enforced at zero baseline.

### Foundation Tokens

| Token | Value | Role |
|---|---:|---|
| `--transition-duration-fast` | 120ms | High-frequency feedback and fast exits |
| `--transition-duration-base` | 180ms | Local state, menus, and toast entry |
| `--transition-duration-slow` | 240ms | Dialog and sheet entry, layout continuity |
| `--transition-duration-progress` | 500ms | Determinate progress smoothing only |
| `--ease-standard` | balanced | Local interpolation |
| `--ease-enter` | decelerating | Arrival and reveal |
| `--ease-exit` | accelerating | Departure |
| `--motion-shift-menu` | 4px | Menu and reveal travel |
| `--motion-shift-reveal` | 8px | Toast and bounded reveal travel |
| `--motion-scale-overlay` | 0.98 | Overlay starting scale |

Tailwind v4 transition-duration utilities are generated from the `--transition-duration-*` namespace, not `--duration-*`. Built-in easing utilities are removed with `--ease-*: initial`; component timing comes from semantic presets instead of `duration-N` or native `ease-*` classes.

### Semantic Presets and Primitive

| Preset | Use |
|---|---|
| `animate-overlay-in/out` | Dialog and sheet scrims |
| `animate-pop-in/out` | Centered dialog and command-palette content |
| `animate-menu-in/out` | Dropdown, popover, tooltip, select, and selection toolbar |
| `animate-sheet-in/out` | Side-aware sheet entry and exit |
| `animate-toast-in/out` | Toast presence; removal waits for exit `animationend` |
| `animate-reveal` | Deferred local content reveal |
| `transition-feedback` | Color, border, shadow, and opacity feedback |
| `transition-toggle` | Chevron and compact state transforms |
| `transition-layout` | Drawer width, transform, and grid continuity |
| `transition-progress` | Width and stroke progress interpolation |

`components/ui/spinner.tsx` is the only owner of `Loader2`, `animate-spin`, and the continuous-work reduced-motion exemption. Business components render `<Spinner size="sm|md|lg" />`.

### Usage Rules

- Radix scrims always pair `data-[state=open]:animate-overlay-in` with `data-[state=closed]:animate-overlay-out`.
- Centered dialog/command content uses the `pop` pair; dropdown/popover/tooltip/select content uses the `menu` pair; sheets use the `sheet` pair.
- Toast dismissal, timeout, and action completion first enter a non-interactive leaving state; DOM removal occurs only after the root exit animation ends. Capacity eviction is intentionally immediate.
- `transition-all`, arbitrary `animate-[…]`, literal `duration-N`, built-in `ease-in`, `ease-out`, `ease-in-out`, or `ease-linear`, tailwindcss-animate composition classes, direct business `Loader2`, and `motion/react` imports are forbidden by `components/design-system-contract.static.test.ts`.
- New keyframes belong only in `app/globals.css`. A new preset must name a product intent, not a raw speed.

### Reduced Motion

The global `prefers-reduced-motion: reduce` policy shortens non-essential animation and transition duration to `0.01ms` and limits animations to one iteration. It deliberately does not use `animation: none`: presence code such as Toast still receives `animationend` and completes cleanup.

`motion-essential` is restricted to active-work indicators and determinate progress. It is not a general escape hatch. `react-pageflip` is the sole JavaScript exception and listens to the media query at runtime, reducing `flippingTime` to its minimum when the preference is enabled.

### Approved Signature Motion

The pre-first-turn flip hint and `react-pageflip` page turn are the only signature motions because they explain the book interaction. The hint is non-essential and becomes effectively instant under reduced motion; page turns also become instant through the live media-query adapter.

---

## 9. Responsive Design

### Breakpoints

| Breakpoint | Width | Target |
|---|---|---|
| Default | 0-639px | Mobile phones |
| `sm` | 640px+ | Large phones / small tablets |
| `md` | 768px+ | Tablets |
| `lg` | 1024px+ | Small laptops |
| `xl` | 1280px+ | Desktops |
| `2xl` | 1536px+ | Large desktops |

### Layout Rules

1. **Mobile-first** — Write base styles for mobile, add breakpoint overrides
2. **Protect the primary canvas** — Global workspace navigation is a drawer on `<xl`; at `xl+` it may stay persistent. Within manuscript mode, keep at most one task-local auxiliary rail visible so the prose remains the largest canvas at the supported 1040px minimum window.
3. **Chat + Editor split on desktop** — Side-by-side layout on `xl+`, tabbed on smaller screens
4. **Prose always readable** — Max width `65ch` at every breakpoint
5. **Touch targets minimum 44px** — Buttons and interactive elements on mobile

---

## 10. Accessibility

1. **Color contrast ratio** — Minimum 4.5:1 for normal text, 3:1 for large text (WCAG AA)
2. **Focus indicators** — Visible focus ring on all interactive elements (`ring-2 ring-interactive/50`)
3. **Semantic HTML** — Use `<nav>`, `<main>`, `<article>`, `<aside>`, `<header>`, `<footer>`
4. **ARIA labels** — All icon-only buttons must have `aria-label`
5. **Keyboard navigation** — All features must be operable with keyboard alone
6. **Screen reader support** — AI streaming text must announce updates via `aria-live="polite"`
7. **Skip links** — "Skip to content" link as first focusable element
