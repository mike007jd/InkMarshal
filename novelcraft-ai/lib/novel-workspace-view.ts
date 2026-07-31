// Pure helpers for NovelWorkspace + NovelTopBar. Lives outside the React
// component so the same logic can be unit-tested under the vitest `node`
// environment (no DOM, no React).

/** The first-class per-novel modes. Agent talks; Story Deck structures; Read/Edit owns text. */
export type NovelView = 'agent' | 'story-deck' | 'read-edit';

const VALID_VIEWS: ReadonlySet<NovelView> = new Set<NovelView>([
  'agent',
  'story-deck',
  'read-edit',
]);

const LEGACY_VIEW_ALIASES: Readonly<Record<string, NovelView>> = {
  chat: 'agent',
  conversations: 'agent',
  brainstorm: 'agent',
  story: 'story-deck',
  deck: 'story-deck',
  command: 'read-edit',
  knowledge: 'story-deck',
  manuscript: 'read-edit',
  inbox: 'read-edit',
  publishing: 'read-edit',
};

/** Coerce a `?view=` query param into a valid NovelView, returning null
 *  when the value is missing or unknown. */
export function parseViewParam(raw: string | null | undefined): NovelView | null {
  if (!raw) return null;
  if (VALID_VIEWS.has(raw as NovelView)) return raw as NovelView;
  return LEGACY_VIEW_ALIASES[raw] ?? null;
}

/** Build a canonical project-entry URL, restoring its durable mode when known. */
export function buildNovelEntryHref(
  novelId: string,
  rememberedView: NovelView | null | undefined,
): string {
  return `/novel/${novelId}?view=${rememberedView ?? 'agent'}`;
}

/** Build the canonical URL for a workspace-mode switch without dropping
 * manuscript deep-link state such as chapter, edit mode, or search offset. */
export function buildNovelViewHref(
  pathname: string,
  search: string,
  view: NovelView,
  hash = '',
): string {
  const params = new URLSearchParams(search);
  params.set('view', view);
  return `${pathname}?${params.toString()}${hash}`;
}
