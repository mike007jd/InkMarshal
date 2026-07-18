import { describe, expect, it } from 'vitest';

import { normalizeLocale } from '@/lib/i18n/types';
import { getTranslations } from '@/lib/i18n';
import { en } from '@/lib/i18n/en';

describe('normalizeLocale', () => {
  it('uses the same Chinese alias policy as the prepaint locale script', () => {
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hans')).toBe('zh-CN');
    expect(normalizeLocale('zh-Hant')).toBe('zh-TW');
    expect(normalizeLocale('zh-HK')).toBe('zh-TW');
  });

  it('accepts percent-encoded cookie values and rejects unknown locales', () => {
    expect(normalizeLocale('zh-Hant')).toBe('zh-TW');
    expect(normalizeLocale('zh-Hant'.replace('-', '%2D'))).toBe('zh-TW');
    expect(normalizeLocale('javascript:alert(1)')).toBe('en');
  });
});

describe('translation placeholders', () => {
  it('keeps every locale key-complete with English', () => {
    const expected = Object.keys(en).sort();
    expect(Object.keys(getTranslations('zh-CN')).sort()).toEqual(expected);
    expect(Object.keys(getTranslations('zh-TW')).sort()).toEqual(expected);
  });

  it('keeps placeholder sets identical across locales', () => {
    const placeholderSet = (value: unknown) =>
      typeof value === 'string'
        ? Array.from(new Set(value.match(/\{[A-Za-z0-9_]+\}/g) ?? [])).sort()
        : [];
    const walk = (base: unknown, target: unknown, path: string[] = []) => {
      if (typeof base === 'string') {
        expect(placeholderSet(target), path.join('.')).toEqual(placeholderSet(base));
        return;
      }
      if (!base || typeof base !== 'object') return;
      for (const key of Object.keys(base as Record<string, unknown>)) {
        walk(
          (base as Record<string, unknown>)[key],
          (target as Record<string, unknown>)[key],
          [...path, key],
        );
      }
    };

    walk(getTranslations('en'), getTranslations('zh-CN'));
    walk(getTranslations('en'), getTranslations('zh-TW'));
  });
});
