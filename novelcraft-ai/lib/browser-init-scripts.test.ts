import { describe, expect, it } from 'vitest';

import { localeInitScriptContent, manuscriptInitScriptContent } from '@/lib/browser-init-scripts';

describe('browser init scripts', () => {
  it('normalizes the locale cookie before assigning html lang', () => {
    expect(localeInitScriptContent).not.toContain('document.documentElement.lang=c[1]');
    expect(localeInitScriptContent).toContain("return'zh-CN'");
    expect(localeInitScriptContent).toContain("return'zh-TW'");
    expect(localeInitScriptContent).toContain("return'en'");
  });

  it('does not treat arbitrary locale cookie text as Chinese manuscript layout', () => {
    expect(manuscriptInitScriptContent).not.toContain("locale==='zh-Hans'||locale==='zh-Hant'");
    expect(manuscriptInitScriptContent).toContain("var locale=n(c&&c[1])");
    expect(manuscriptInitScriptContent).toContain("var isZh=locale==='zh-CN'||locale==='zh-TW'");
  });
});
