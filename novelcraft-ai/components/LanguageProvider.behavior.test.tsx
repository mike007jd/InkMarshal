// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LocaleProvider, useLocale } from '@/components/LanguageProvider';
import { type Locale, DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_STORAGE_KEY } from '@/lib/i18n';

function LocaleProbe() {
  const { locale, setLocale } = useLocale();
  return (
    <button data-testid="locale" type="button" onClick={() => setLocale('zh-TW')}>
      {locale}
    </button>
  );
}

function renderProbe() {
  return render(
    <LocaleProvider>
      <LocaleProbe />
    </LocaleProvider>,
  );
}

async function waitForLocale(locale: Locale) {
  await waitFor(() => {
    expect(screen.getByTestId('locale').textContent).toBe(locale);
    expect(document.documentElement.lang).toBe(locale);
  });
}

function setNavigatorLanguage(language: string) {
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: language,
  });
}

function clearLocaleCookie() {
  document.cookie = `${LOCALE_COOKIE}=;path=/;max-age=0`;
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  const localStorageStub = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
  } satisfies Storage;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: localStorageStub,
  });
  vi.stubGlobal('localStorage', localStorageStub);
  return localStorageStub;
}

beforeEach(() => {
  stubLocalStorage();
  window.localStorage.clear();
  clearLocaleCookie();
  document.documentElement.lang = DEFAULT_LOCALE;
  setNavigatorLanguage('en');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearLocaleCookie();
  vi.unstubAllGlobals();
});

describe('LocaleProvider hydration reconciliation', () => {
  it('renders the default locale first, then hydrates from localStorage', async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-TW');

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    await waitForLocale('zh-TW');
  });

  it('hydrates from the locale cookie when localStorage has no preference', async () => {
    document.cookie = `${LOCALE_COOKIE}=zh-CN;path=/`;

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    await waitForLocale('zh-CN');
  });

  it('falls back to browser language only after the first default render', async () => {
    setNavigatorLanguage('zh-HK');

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    await waitForLocale('zh-TW');
  });

  it('persists explicit locale changes to html lang, cookie, and localStorage', async () => {
    renderProbe();

    fireEvent.click(screen.getByTestId('locale'));

    await waitForLocale('zh-TW');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-TW');
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh-TW`);
  });
});

describe('desktop first-frame locale gate', () => {
  it('keeps the packaged window hidden until locale hydration is wired to native show', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const [provider, tauriConfig, rust] = await Promise.all([
      readFile(join(process.cwd(), 'components/LanguageProvider.tsx'), 'utf8'),
      readFile(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
      readFile(join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8'),
    ]);

    expect(JSON.parse(tauriConfig).app.windows[0].visible).toBe(false);
    expect(provider).toContain('getCurrentWindow().show()');
    expect(provider).toContain('if (!hydrated');
    expect(rust).toContain('Failed to reveal startup error window');
  });
});
