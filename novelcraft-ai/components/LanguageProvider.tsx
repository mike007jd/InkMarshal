'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  type Locale,
  type Translations,
  DEFAULT_LOCALE,
  parseSupportedLocale,
  normalizeLocale,
  getTranslations,
  LOCALE_COOKIE,
  LOCALE_STORAGE_KEY,
} from '@/lib/i18n';
import { isTauriRuntime } from '@/lib/desktop-runtime';

interface LocaleContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translations;
  // Backward compat aliases
  language: Locale;
  setLanguage: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextType | undefined>(undefined);

function getInitialLocale(): Locale {
  // Client components on public/static routes are pre-rendered in the default
  // locale. Hydrating from a cookie here would make the first client render
  // differ from the static HTML and trigger a React hydration mismatch.
  return DEFAULT_LOCALE;
}

function readCookieLocale(): Locale | null {
  if (typeof document === 'undefined') return null;
  const cookieMatch = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`));
  return cookieMatch ? parseSupportedLocale(cookieMatch[1]) : null;
}

function readLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be disabled or full; the in-memory locale still works.
  }
}

function persistLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.cookie = `${LOCALE_COOKIE}=${locale};path=/;max-age=${365 * 24 * 60 * 60};SameSite=Lax`;
  writeLocalStorage(LOCALE_STORAGE_KEY, locale);
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  // Always use the default locale for the first render to match static HTML.
  // localStorage / navigator.language are deferred to useEffect to avoid hydration mismatch.
  const [locale, setLocaleState] = useState<Locale>(getInitialLocale);
  const [hydrated, setHydrated] = useState(false);
  const explicitLocaleRef = useRef<Locale | null>(null);
  const nativeLocaleWriteQueueRef = useRef<Promise<void>>(Promise.resolve());

  // On mount: reconcile from client-only sources. Cookie is host+path scoped
  // (not port), so it is the cross-runtime-port canonical frontend preference;
  // port-local localStorage is only a same-origin cache and must not outrank it.
  useEffect(() => {
    let mounted = true;
    const applyHydratedLocale = (nextLocale: Locale) => {
      queueMicrotask(() => {
        if (!mounted) return;
        // An explicit setLocale before this microtask already persisted the
        // chosen language; still mark hydrated so the desktop reveal gate and
        // post-hydration persist path can proceed.
        if (explicitLocaleRef.current === null) {
          setLocaleState(nextLocale);
        }
        setHydrated(true);
      });
    };

    const cookieLocale = readCookieLocale();
    if (cookieLocale) {
      applyHydratedLocale(cookieLocale);
      return () => {
        mounted = false;
      };
    }

    const saved = readLocalStorage(LOCALE_STORAGE_KEY);
    if (saved) {
      applyHydratedLocale(normalizeLocale(saved));
      return () => {
        mounted = false;
      };
    }

    // No saved preference — detect from browser language. Route through the
    // shared normalizeLocale (the same policy the cookie / server / pre-paint
    // paths use) so zh-Hant, zh-HK, etc. resolve to Traditional. For zh tags
    // normalizeLocale doesn't recognize (e.g. zh-Hant-TW, zh-MO), fall back to
    // Simplified rather than English so a zh browser never lands on en.
    if (navigator.language.startsWith('zh')) {
      const detected = normalizeLocale(navigator.language);
      applyHydratedLocale(detected === 'en' ? 'zh-CN' : detected);
    } else {
      applyHydratedLocale(DEFAULT_LOCALE);
    }

    return () => {
      mounted = false;
    };
  }, []);

  // The packaged desktop window starts hidden. Reveal it only after the
  // persisted/OS locale has been applied and React has committed that frame,
  // so users never see an English shell flash before their chosen language.
  useEffect(() => {
    if (!hydrated || !isTauriRuntime()) return;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().show())
      .catch(() => undefined);
  }, [hydrated]);

  // Mirror the canonical UI locale into native locale.txt only after hydration
  // so the SSR-safe default first paint cannot clobber a stored preference.
  useEffect(() => {
    if (!hydrated || !isTauriRuntime()) return;
    nativeLocaleWriteQueueRef.current = nativeLocaleWriteQueueRef.current
      .then(async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('write_app_locale', { locale });
      })
      .catch((err: unknown) => {
        if (typeof console !== 'undefined') {
          console.warn('Failed to persist locale for menu:', err);
        }
      });
  }, [locale, hydrated]);

  // Persist only after hydration so the SSR-safe default first render cannot
  // overwrite the cross-port cookie (or heal localStorage with the wrong value)
  // before the canonical preference is applied. Explicit setLocale persists
  // immediately on its own path.
  useEffect(() => {
    if (!hydrated) return;
    persistLocale(locale);
  }, [locale, hydrated]);

  const setLocale = useCallback((nextLocale: Locale) => {
    explicitLocaleRef.current = nextLocale;
    persistLocale(nextLocale);
    setLocaleState(nextLocale);
  }, []);

  const t = getTranslations(locale);

  return (
    <LocaleContext.Provider value={{
      locale, setLocale, t,
      language: locale, setLanguage: setLocale,
    }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used within LocaleProvider');
  return context;
}

// Backward compat exports — other files can still import these names
export const useLanguage = useLocale;
export const LanguageProvider = LocaleProvider;
