import { en } from './en';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';
import { type Locale, LOCALES, DEFAULT_LOCALE, normalizeLocale, isZhLocale, LOCALE_NAMES } from './types';

// Widen literal types to string for cross-locale compatibility
type DeepStringify<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringify<T[K]>;
};

export type TranslationKeys = typeof en;
export type Translations = DeepStringify<TranslationKeys>;

/** Keys of Translations whose value is a plain string (excludes nested objects like `stages`). */
export type StringKey = { [K in keyof Translations]: Translations[K] extends string ? K : never }[keyof Translations];

// Enforce all locale files match en's shape (same keys, string values)
const translationMap = {
  'en': en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
} satisfies Record<Locale, Translations>;

export function getTranslations(locale: Locale): Translations {
  return translationMap[locale] ?? translationMap[DEFAULT_LOCALE];
}

export const LOCALE_COOKIE = 'locale';
export const LOCALE_STORAGE_KEY = 'locale';

// Re-export everything
export { type Locale, LOCALES, DEFAULT_LOCALE, normalizeLocale, isZhLocale, LOCALE_NAMES };
