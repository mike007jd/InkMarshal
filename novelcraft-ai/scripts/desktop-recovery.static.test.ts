import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('standalone desktop startup recovery', () => {
  it('ships a self-contained localized page with three recovery actions', () => {
    const page = source('src-tauri/fallback/error.html');
    expect(page).toContain('navigator.languages && navigator.languages[0]');
    expect(page).toContain('normalizeLocale(preferredLocale)');
    expect(page).toContain('id="retry"');
    expect(page).toContain('id="download"');
    expect(page).toContain('id="copy"');
    expect(page).toContain('<details>');
    expect(page).toContain('navigator.userAgent');
    expect(page).not.toMatch(/<script[^>]+src=/);
    expect(page).not.toContain('/_next/');
  });

  it('passes persisted locale and opens only the verified stable release', () => {
    const rust = source('src-tauri/src/lib.rs');
    const menu = source('src-tauri/src/app_menu.rs');
    const page = source('src-tauri/fallback/error.html');
    const config = JSON.parse(source('src-tauri/tauri.conf.json'));
    const stableUrl = 'https://github.com/mike007jd/InkMarshal/releases/latest/download/InkMarshal-mac-aarch64.dmg';
    expect(rust).toContain('error.html?locale={locale}&msg={encoded}');
    expect(menu).toContain('sys_locale::get_locale()');
    expect(page).toContain(`var DOWNLOAD_URL = "${stableUrl}"`);
    expect(page).toContain('invoke("plugin:shell|open", { path: DOWNLOAD_URL, with: null })');
    expect(new RegExp(`^${config.plugins.shell.open}$`).test(stableUrl)).toBe(true);
  });
});
