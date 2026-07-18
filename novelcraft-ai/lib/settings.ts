'use client';

import { normalizeLocale, isZhLocale, type Locale } from '@/lib/i18n';
import { getStoredSetting, setStoredSetting } from '@/lib/app-settings-client';

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  fontSize: 'sm' | 'md' | 'lg';
  lineSpacing: 'compact' | 'normal' | 'relaxed';
  /**
   * When true, Chinese-locale manuscript prose gets a 2em first-line indent
   * and slightly wider paragraph spacing. Defaults follow the active locale
   * (zh-* → true, en → false) but the user can override from the settings
   * panel. Stored as `undefined` for legacy installs; `applySettingsToDocument`
   * treats absence as "follow locale".
   */
  chineseTextIndent?: boolean;
  /**
   * W3-2: the global default prompt variant new novels and unbound novels fall
   * back to. Empty/absent means the seeded `'default'` workflow. Persisted in
   * the same `inkmarshal_settings` blob (no new storage key).
   */
  defaultPromptVariant?: string;
  /** Exposes prompt templates, bindings, raw vault paths, and other operator UI. */
  developerTools?: boolean;
}

const SETTINGS_KEY = 'inkmarshal_settings';

const DEFAULTS: AppSettings = {
  theme: 'system',
  fontSize: 'md',
  lineSpacing: 'normal',
};

function isTheme(value: unknown): value is AppSettings['theme'] {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isFontSize(value: unknown): value is AppSettings['fontSize'] {
  return value === 'sm' || value === 'md' || value === 'lg';
}

function isLineSpacing(value: unknown): value is AppSettings['lineSpacing'] {
  return value === 'compact' || value === 'normal' || value === 'relaxed';
}

export function normalizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULTS;
  const raw = value as Partial<Record<keyof AppSettings, unknown>>;
  const next: AppSettings = { ...DEFAULTS };
  if (isTheme(raw.theme)) next.theme = raw.theme;
  if (isFontSize(raw.fontSize)) next.fontSize = raw.fontSize;
  if (isLineSpacing(raw.lineSpacing)) next.lineSpacing = raw.lineSpacing;
  if (typeof raw.chineseTextIndent === 'boolean') {
    next.chineseTextIndent = raw.chineseTextIndent;
  }
  if (typeof raw.defaultPromptVariant === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(raw.defaultPromptVariant)) {
    next.defaultPromptVariant = raw.defaultPromptVariant;
  }
  if (typeof raw.developerTools === 'boolean') next.developerTools = raw.developerTools;
  // Backup folder: any non-empty absolute-ish path string the picker returned.
  // The Rust session allowlist is the real authority on which dir can be written
  // to, so here we only need a sane length bound, not a path syntax check.
  return next;
}

export function getSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = getStoredSetting(SETTINGS_KEY);
    return raw ? normalizeAppSettings(JSON.parse(raw)) : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(settings: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const updated = normalizeAppSettings({ ...current, ...settings });
  setStoredSetting(SETTINGS_KEY, JSON.stringify(updated));
  return updated;
}

const FONT_SIZE_PX: Record<AppSettings['fontSize'], string> = {
  sm: '15px',
  md: '17px',
  lg: '19px',
};

const LINE_HEIGHT: Record<AppSettings['lineSpacing'], string> = {
  compact: '1.5',
  normal: '1.75',
  relaxed: '2.0',
};

/**
 * Write the manuscript CSS variables to the document root. Components that
 * render manuscript prose just consume `var(--manuscript-…)` so settings
 * changes propagate without a re-render path.
 *
 * Safe to call on the server (no-op) and idempotent — ThemeProvider runs it
 * on mount and on every locale/setting change.
 */
export function applySettingsToDocument(
  settings: AppSettings,
  locale: Locale | string,
): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  root.setProperty('--manuscript-font-size', FONT_SIZE_PX[settings.fontSize] ?? FONT_SIZE_PX.md);
  root.setProperty('--manuscript-line-height', LINE_HEIGHT[settings.lineSpacing] ?? LINE_HEIGHT.normal);

  const normalized: Locale = normalizeLocale(locale);
  const useIndent = settings.chineseTextIndent ?? isZhLocale(normalized);
  root.setProperty('--manuscript-paragraph-indent', useIndent ? '2em' : '0');
  root.setProperty('--manuscript-paragraph-spacing', useIndent ? '0.6em' : '0.4em');
}
