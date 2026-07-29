// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: { locale: string }): Promise<void> => undefined),
  show: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    show: tauriMocks.show,
  }),
}));

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

function writeAppLocaleCalls() {
  return tauriMocks.invoke.mock.calls.filter((call) => call[0] === 'write_app_locale');
}

function enableTauriRuntime() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  });
}

const nativeCookieDescriptor =
  Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  ?? Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');

function restoreNativeCookie() {
  if (nativeCookieDescriptor) {
    Object.defineProperty(document, 'cookie', nativeCookieDescriptor);
  }
}

function installCookieJar(initial = '') {
  let jar = initial;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => jar,
    set: (value: string) => {
      const [pair] = String(value).split(';');
      const eq = pair.indexOf('=');
      const name = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
      const val = eq >= 0 ? pair.slice(eq + 1) : '';
      if (String(value).includes('max-age=0')) {
        jar = jar
          .split('; ')
          .filter((entry) => entry && !entry.startsWith(`${name}=`))
          .join('; ');
        return;
      }
      const next = `${name}=${val}`;
      const rest = jar
        .split('; ')
        .filter((entry) => entry && !entry.startsWith(`${name}=`));
      jar = [...rest, next].filter(Boolean).join('; ');
    },
  });
}

beforeEach(() => {
  restoreNativeCookie();
  stubLocalStorage();
  window.localStorage.clear();
  clearLocaleCookie();
  document.documentElement.lang = DEFAULT_LOCALE;
  setNavigatorLanguage('en');
  tauriMocks.invoke.mockClear();
  tauriMocks.show.mockClear();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearLocaleCookie();
  restoreNativeCookie();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
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

  it('normalizes supported cookie aliases canonically', async () => {
    document.cookie = `${LOCALE_COOKIE}=zh-Hans;path=/`;

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    await waitFor(() => {
      expect(screen.getByTestId('locale').textContent).toBe('zh-CN');
      expect(document.documentElement.lang).toBe('zh-CN');
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
      expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh-CN`);
    });
  });

  it('prefers a cross-port cookie over stale port-local localStorage (cookie=en)', async () => {
    document.cookie = `${LOCALE_COOKIE}=en;path=/`;
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    // When the cookie matches DEFAULT_LOCALE the first paint is already "en",
    // so wait until post-hydration persist heals the stale port-local cache.
    await waitFor(() => {
      expect(screen.getByTestId('locale').textContent).toBe('en');
      expect(document.documentElement.lang).toBe('en');
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
      expect(document.cookie).toContain(`${LOCALE_COOKIE}=en`);
    });
  });

  it('prefers a cross-port cookie over stale port-local localStorage (cookie=zh-CN)', async () => {
    document.cookie = `${LOCALE_COOKIE}=zh-CN;path=/`;
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    await waitFor(() => {
      expect(screen.getByTestId('locale').textContent).toBe('zh-CN');
      expect(document.documentElement.lang).toBe('zh-CN');
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
      expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh-CN`);
    });
  });

  it('ignores an invalid cookie, hydrates from localStorage, and heals cookie + cache', async () => {
    document.cookie = `${LOCALE_COOKIE}=not-a-locale;path=/`;
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-TW');

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    await waitFor(() => {
      expect(screen.getByTestId('locale').textContent).toBe('zh-TW');
      expect(document.documentElement.lang).toBe('zh-TW');
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-TW');
      expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh-TW`);
      expect(document.cookie).not.toContain(`${LOCALE_COOKIE}=not-a-locale`);
    });
  });

  it('ignores an empty cookie, hydrates from localStorage, and heals cookie + cache', async () => {
    installCookieJar(`${LOCALE_COOKIE}=`);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    await waitFor(() => {
      expect(screen.getByTestId('locale').textContent).toBe('zh-CN');
      expect(document.documentElement.lang).toBe('zh-CN');
      expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN');
      expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh-CN`);
    });
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
  it('keeps the packaged window hidden and preserves the native startup-error reveal', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const [tauriConfig, rust] = await Promise.all([
      readFile(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
      readFile(join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8'),
    ]);

    expect(JSON.parse(tauriConfig).app.windows[0].visible).toBe(false);
    expect(rust).toContain('Failed to reveal startup error window');
  });

  it('writes zero native locale mirrors before hydration', async () => {
    enableTauriRuntime();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    expect(writeAppLocaleCalls()).toHaveLength(0);
    expect(tauriMocks.show).not.toHaveBeenCalled();
  });

  it('writes exactly one canonical native locale after hydration', async () => {
    enableTauriRuntime();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');

    renderProbe();

    expect(writeAppLocaleCalls()).toHaveLength(0);
    await waitForLocale('zh-CN');
    await waitFor(() => {
      expect(writeAppLocaleCalls()).toEqual([['write_app_locale', { locale: 'zh-CN' }]]);
      expect(tauriMocks.show).toHaveBeenCalledTimes(1);
    });
  });

  it('serializes native locale mirrors so the newest locale is written last', async () => {
    let resolveFirstWrite: (() => void) | undefined;
    tauriMocks.invoke.mockImplementationOnce(
      async () => new Promise<void>((resolve) => {
        resolveFirstWrite = resolve;
      }),
    );
    enableTauriRuntime();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');

    renderProbe();

    await waitFor(() => {
      expect(writeAppLocaleCalls()).toEqual([['write_app_locale', { locale: 'zh-CN' }]]);
    });

    fireEvent.click(screen.getByTestId('locale'));
    await waitForLocale('zh-TW');
    expect(writeAppLocaleCalls()).toHaveLength(1);

    resolveFirstWrite?.();
    await waitFor(() => {
      expect(writeAppLocaleCalls()).toEqual([
        ['write_app_locale', { locale: 'zh-CN' }],
        ['write_app_locale', { locale: 'zh-TW' }],
      ]);
    });
  });

  it('honors an explicit locale before the hydration microtask and still unlocks show', async () => {
    enableTauriRuntime();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');

    renderProbe();

    expect(screen.getByTestId('locale').textContent).toBe(DEFAULT_LOCALE);
    expect(writeAppLocaleCalls()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('locale'));

    await waitForLocale('zh-TW');
    await waitFor(() => {
      expect(writeAppLocaleCalls()).toEqual([['write_app_locale', { locale: 'zh-TW' }]]);
      expect(tauriMocks.show).toHaveBeenCalledTimes(1);
    });
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-TW');
    expect(document.cookie).toContain(`${LOCALE_COOKIE}=zh-TW`);
  });
});
