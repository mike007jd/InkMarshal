// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LocaleProvider, useLocale } from '@/components/LanguageProvider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_STORAGE_KEY, type Locale } from '@/lib/i18n';

function LocaleSwitch() {
  const { setLocale } = useLocale();
  return (
    <>
      <button type="button" onClick={() => setLocale('zh-CN')}>to-zh-CN</button>
      <button type="button" onClick={() => setLocale('zh-TW')}>to-zh-TW</button>
      <button type="button" onClick={() => setLocale('en')}>to-en</button>
    </>
  );
}

function DialogHarness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Title</DialogTitle>
        <DialogDescription>Description</DialogDescription>
      </DialogContent>
    </Dialog>
  );
}

function SheetHarness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetTitle>Title</SheetTitle>
        <SheetDescription>Description</SheetDescription>
      </SheetContent>
    </Sheet>
  );
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
}

function clearLocaleCookie() {
  document.cookie = `${LOCALE_COOKIE}=;path=/;max-age=0`;
}

beforeEach(() => {
  stubLocalStorage();
  window.localStorage.clear();
  clearLocaleCookie();
  document.documentElement.lang = DEFAULT_LOCALE;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  clearLocaleCookie();
  vi.unstubAllGlobals();
});

describe('Dialog close control localization', () => {
  it.each<[Locale, string]>([
    ['en', 'Dismiss'],
    ['zh-CN', '关闭'],
    ['zh-TW', '關閉'],
  ])('names the close button %s (%s) without caller props', async (locale, name) => {
    render(
      <LocaleProvider>
        <LocaleSwitch />
        <DialogHarness />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByText(`to-${locale}`));
    await waitFor(() => {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    });
  });

  it('still closes on Escape', () => {
    const onOpenChange = vi.fn();
    render(
      <LocaleProvider>
        <DialogHarness onOpenChange={onOpenChange} />
      </LocaleProvider>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('Sheet close control localization', () => {
  it.each<[Locale, string]>([
    ['en', 'Dismiss'],
    ['zh-CN', '关闭'],
    ['zh-TW', '關閉'],
  ])('names the close button %s (%s) without caller props', async (locale, name) => {
    render(
      <LocaleProvider>
        <LocaleSwitch />
        <SheetHarness />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByText(`to-${locale}`));
    await waitFor(() => {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    });
  });
});
