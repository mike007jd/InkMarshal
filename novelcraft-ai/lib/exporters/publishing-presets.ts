/**
 * The three publishing presets (Submission / Editorial / Publication) and the
 * resolver that merges a novel's stored `NovelSettings.publishing` over a preset
 * baseline.
 *
 * A "preset" is a complete default `PublishingConfig`; the user's stored config
 * (if any) is a deep partial overlaid on top. `resolvePublishingConfig` is the
 * single entry point used by the export path, the preview, and the workspace UI
 * so they all agree on the effective config.
 */

import type { NovelSettings, PublishingConfig, PublishingSection } from '@/lib/db-types';

export type PublishingPreset = PublishingConfig['activePreset'];

const ENABLED: PublishingSection = { enabled: true };
const DISABLED: PublishingSection = { enabled: false };

/**
 * Submission: clean reading copy for an editor's inbox. Continuous chapter
 * flow, generous margins, digital trim, minimal front matter. No font embed.
 */
export const SUBMISSION: PublishingConfig = {
  metadata: {
    language: 'zh',
  },
  frontMatter: {
    titlePage: ENABLED,
    copyrightPage: DISABLED,
    toc: ENABLED,
    dedication: DISABLED,
    acknowledgements: DISABLED,
    authorBio: DISABLED,
  },
  layout: {
    chapterStartStyle: 'newPage',
    trim: 'digital',
    marginsMm: 20,
  },
  activePreset: 'submission',
};

/**
 * Editorial: review copy. Same as submission but every chapter on a fresh page
 * and the copyright page present so the editor sees rights/contact info.
 */
export const EDITORIAL: PublishingConfig = {
  metadata: {
    language: 'zh',
  },
  frontMatter: {
    titlePage: ENABLED,
    copyrightPage: ENABLED,
    toc: ENABLED,
    dedication: DISABLED,
    acknowledgements: DISABLED,
    authorBio: DISABLED,
  },
  layout: {
    chapterStartStyle: 'newPage',
    trim: 'a5',
    marginsMm: 18,
  },
  activePreset: 'editorial',
};

/**
 * Publication: print-ready. Recto chapter starts, full front + back matter,
 * tighter print margins, A5 trim. Font embed is recommended (the workspace
 * surfaces the ~size cost) so CJK renders identically on any reader.
 */
export const PUBLICATION: PublishingConfig = {
  metadata: {
    language: 'zh',
  },
  frontMatter: {
    titlePage: ENABLED,
    copyrightPage: ENABLED,
    toc: ENABLED,
    dedication: ENABLED,
    acknowledgements: ENABLED,
    authorBio: ENABLED,
  },
  layout: {
    chapterStartStyle: 'newRecto',
    trim: 'a5',
    marginsMm: 16,
  },
  activePreset: 'publication',
};

export const PRESETS: Record<PublishingPreset, PublishingConfig> = {
  submission: SUBMISSION,
  editorial: EDITORIAL,
  publication: PUBLICATION,
};

/** Only the publication preset embeds the CJK font by default. */
export function presetEmbedsFont(preset: PublishingPreset): boolean {
  return preset === 'publication';
}

function mergeSection(base: PublishingSection, over?: Partial<PublishingSection>): PublishingSection {
  if (!over) return { ...base };
  return {
    enabled: typeof over.enabled === 'boolean' ? over.enabled : base.enabled,
    ...(over.body !== undefined ? { body: over.body } : base.body !== undefined ? { body: base.body } : {}),
  };
}

type DeepPartialConfig = {
  metadata?: Partial<PublishingConfig['metadata']>;
  frontMatter?: Partial<Record<keyof PublishingConfig['frontMatter'], Partial<PublishingSection>>>;
  layout?: Partial<PublishingConfig['layout']>;
  activePreset?: PublishingPreset;
};

/**
 * Resolve the EFFECTIVE publishing config:
 *   preset baseline  ←  stored config overlay  ←  explicit preset override
 *
 * `presetOverride` lets the workspace preview a preset the user is *trying*
 * (preset switcher) without persisting it. When omitted, the stored
 * `activePreset` (or 'submission') selects the baseline.
 *
 * The stored config is treated as untrusted deep-partial: every field is merged
 * defensively so a half-written settings bag can never produce an invalid config.
 */
export function resolvePublishingConfig(
  novelSettings: NovelSettings | null | undefined,
  presetOverride?: PublishingPreset,
): PublishingConfig {
  const stored = (novelSettings?.publishing ?? undefined) as DeepPartialConfig | undefined;
  const preset = presetOverride ?? stored?.activePreset ?? 'submission';
  const base = PRESETS[preset] ?? SUBMISSION;

  return {
    metadata: {
      ...base.metadata,
      ...(stored?.metadata ?? {}),
    },
    frontMatter: {
      titlePage: mergeSection(base.frontMatter.titlePage, stored?.frontMatter?.titlePage),
      copyrightPage: mergeSection(base.frontMatter.copyrightPage, stored?.frontMatter?.copyrightPage),
      toc: mergeSection(base.frontMatter.toc, stored?.frontMatter?.toc),
      dedication: mergeSection(base.frontMatter.dedication, stored?.frontMatter?.dedication),
      acknowledgements: mergeSection(base.frontMatter.acknowledgements, stored?.frontMatter?.acknowledgements),
      authorBio: mergeSection(base.frontMatter.authorBio, stored?.frontMatter?.authorBio),
    },
    layout: {
      chapterStartStyle: normalizeChapterStart(stored?.layout?.chapterStartStyle) ?? base.layout.chapterStartStyle,
      trim: normalizeTrim(stored?.layout?.trim) ?? base.layout.trim,
      marginsMm:
        typeof stored?.layout?.marginsMm === 'number' && Number.isFinite(stored.layout.marginsMm)
          ? Math.max(0, Math.min(60, stored.layout.marginsMm))
          : base.layout.marginsMm,
      ...(stored?.layout?.header !== undefined ? { header: stored.layout.header } : base.layout.header !== undefined ? { header: base.layout.header } : {}),
      ...(stored?.layout?.footer !== undefined ? { footer: stored.layout.footer } : base.layout.footer !== undefined ? { footer: base.layout.footer } : {}),
    },
    activePreset: preset,
  };
}

function normalizeChapterStart(v: unknown): PublishingConfig['layout']['chapterStartStyle'] | undefined {
  return v === 'newPage' || v === 'newRecto' || v === 'continuous' ? v : undefined;
}

function normalizeTrim(v: unknown): PublishingConfig['layout']['trim'] | undefined {
  return v === 'a5' || v === 'b6' || v === '6x9' || v === 'digital' ? v : undefined;
}
