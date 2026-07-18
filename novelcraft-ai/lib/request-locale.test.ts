import { describe, expect, it } from 'vitest';

import { requestLocale } from '@/lib/request-locale';

describe('requestLocale', () => {
  it('normalizes untrusted x-locale headers to supported locales', () => {
    expect(requestLocale(new Headers({ 'x-locale': 'zh-CN' }))).toBe('zh-CN');
    expect(requestLocale(new Headers({ 'x-locale': 'zh' }))).toBe('zh-CN');
    expect(requestLocale(new Headers({ 'x-locale': 'javascript:alert(1)' }))).toBe('en');
    expect(requestLocale(new Headers({ 'x-locale': 'x'.repeat(5000) }))).toBe('en');
    expect(requestLocale(new Headers())).toBe('en');
  });
});
