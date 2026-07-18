import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getSettings, normalizeAppSettings, saveSettings } from './settings';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

let savedWindow: PropertyDescriptor | undefined;
let savedLocalStorage: PropertyDescriptor | undefined;
let memory: MemoryStorage;

beforeEach(() => {
  memory = new MemoryStorage();
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: memory },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: memory,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else delete (globalThis as Record<string, unknown>).window;
  if (savedLocalStorage) Object.defineProperty(globalThis, 'localStorage', savedLocalStorage);
  else delete (globalThis as Record<string, unknown>).localStorage;
});

describe('app settings normalization', () => {
  it('normalizes persisted localStorage settings before UI state reads them', () => {
    memory.setItem(
      'inkmarshal_settings',
      JSON.stringify({
        theme: 'invalid',
        fontSize: 'huge',
        lineSpacing: 'dense',
        chineseTextIndent: true,
        extra: 'drop-me',
      }),
    );

    expect(getSettings()).toEqual({
      theme: 'system',
      fontSize: 'md',
      lineSpacing: 'normal',
      chineseTextIndent: true,
    });
  });

  it('collapses non-object settings to defaults', () => {
    expect(normalizeAppSettings('dark')).toEqual({
      theme: 'system',
      fontSize: 'md',
      lineSpacing: 'normal',
    });
    expect(normalizeAppSettings(['dark'])).toEqual({
      theme: 'system',
      fontSize: 'md',
      lineSpacing: 'normal',
    });
  });

  it('rewrites corrupted settings through the same normalizer on save', () => {
    memory.setItem('inkmarshal_settings', JSON.stringify('corrupted'));

    const saved = saveSettings({ theme: 'dark' });

    expect(saved).toEqual({
      theme: 'dark',
      fontSize: 'md',
      lineSpacing: 'normal',
    });
    expect(JSON.parse(memory.getItem('inkmarshal_settings')!)).toEqual(saved);
  });

  it('keeps developer surfaces opt-in and ignores non-boolean flags', () => {
    expect(normalizeAppSettings({ developerTools: true }).developerTools).toBe(true);
    expect(normalizeAppSettings({ developerTools: 'yes' }).developerTools).toBeUndefined();
    expect(normalizeAppSettings({}).developerTools).toBeUndefined();
  });
});
