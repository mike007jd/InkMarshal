import { cookies } from 'next/headers';
import { normalizeLocale, DEFAULT_LOCALE, type Locale } from '@/lib/i18n/types';
import type { Translations } from '@/lib/i18n';

// Cache resolved translation bundles on the module so generateMetadata /
// layouts on every public page render don't re-await the dynamic import.
const translationCache = new Map<Locale, Promise<Translations>>();

function loadTranslations(locale: Locale): Promise<Translations> {
  const cached = translationCache.get(locale);
  if (cached) return cached;
  const promise: Promise<Translations> = (async () => {
    switch (locale) {
      case 'zh-CN':
        return (await import('@/lib/i18n/zh-CN')).zhCN as Translations;
      case 'zh-TW':
        return (await import('@/lib/i18n/zh-TW')).zhTW as Translations;
      case 'en':
      default:
        return (await import('@/lib/i18n/en')).en as Translations;
    }
  })().catch((error) => {
    // Don't cache a rejected promise forever — a one-time transient import
    // failure would otherwise wedge this locale for the process lifetime.
    translationCache.delete(locale);
    throw error;
  });
  translationCache.set(locale, promise);
  return promise;
}

export async function getServerLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  return normalizeLocale(cookieStore.get('locale')?.value);
}

export async function getServerTranslations(): Promise<{ locale: Locale; t: Translations }> {
  const locale = await getServerLocale();
  return {
    locale,
    t: await loadTranslations(locale),
  };
}

/**
 * Default-locale translations without reading cookies.
 * Use in generateMetadata / layouts for public pages to avoid pulling them
 * into the dynamic rendering path.
 */
export async function getDefaultTranslations(): Promise<{ locale: Locale; t: Translations }> {
  return {
    locale: DEFAULT_LOCALE,
    t: await loadTranslations(DEFAULT_LOCALE),
  };
}
