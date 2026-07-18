import { normalizeLocale, type Locale } from '@/lib/i18n';

export function requestLocale(headers: Pick<Headers, 'get'>): Locale {
  return normalizeLocale(headers.get('x-locale'));
}
