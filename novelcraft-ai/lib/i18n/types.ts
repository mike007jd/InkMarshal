export const LOCALES = ['en', 'zh-CN', 'zh-TW'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_NAMES: Record<Locale, string> = {
  'en': 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
};

export function isZhLocale(locale: Locale): boolean {
  return locale === 'zh-CN' || locale === 'zh-TW';
}

export function normalizeLocale(value: string | null | undefined): Locale {
  let normalized = value;
  try {
    normalized = decodeURIComponent(value ?? '');
  } catch {
    normalized = value;
  }
  if (normalized === 'zh' || normalized === 'zh-CN' || normalized === 'zh-Hans') return 'zh-CN';
  if (normalized === 'zh-TW' || normalized === 'zh-Hant' || normalized === 'zh-HK') return 'zh-TW';
  if (normalized === 'en') return 'en';
  return DEFAULT_LOCALE;
}
