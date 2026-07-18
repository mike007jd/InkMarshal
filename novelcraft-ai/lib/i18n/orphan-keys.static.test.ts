import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { en } from '@/lib/i18n/en';
import { zhCN } from '@/lib/i18n/zh-CN';
import { zhTW } from '@/lib/i18n/zh-TW';

// Guard against dead i18n keys creeping back in. The existing i18n guards only
// check shape/placeholder parity across locales — they never check whether a
// key is *used*, which is how ~253 orphan keys accumulated before the 2026-06
// cleanup. This walks the source tree and flags any `en` leaf key that is never
// referenced.
//
// "Referenced" = the key name appears as a whole-word token anywhere in the
// scanned source (covers `t.key`, `t['key']`, and literal `'key' as StringKey`
// arrays). This deliberately errs toward "used" so a key whose name collides
// with an unrelated identifier is not falsely flagged — the goal is to catch
// orphans without false positives, not to be exhaustive.

const PROJECT_ROOT = process.cwd();
const SCAN_ROOTS = ['app', 'components', 'lib', 'hooks'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage']);

// The locale *definition* files — every key appears here by definition, so they
// can't count as "usage".
const LOCALE_DEFINITION_FILES = new Set(
  ['en.ts', 'zh-CN.ts', 'zh-TW.ts'].map(f => path.join('lib', 'i18n', f)),
);

// Add dynamic-key families here only when production code constructs a key.
const DYNAMIC_KEY_ALLOWLIST: RegExp[] = [];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function collectSource(): string {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(path.join(PROJECT_ROOT, root), files);
  }
  return files
    .filter(file => {
      const rel = path.relative(PROJECT_ROOT, file);
      return !LOCALE_DEFINITION_FILES.has(rel);
    })
    .map(file => readFileSync(file, 'utf8'))
    .join('\n');
}

describe('i18n orphan-key guard', () => {
  const source = collectSource();
  const keys = Object.keys(en);

  it('every `en` key is referenced somewhere in app/components/lib/hooks', () => {
    const orphans = keys.filter(key => {
      if (DYNAMIC_KEY_ALLOWLIST.some(re => re.test(key))) return false;
      return !new RegExp(`\\b${key}\\b`).test(source);
    });
    expect(orphans).toEqual([]);
  });

  it('every allowlisted dynamic prefix still matches at least one real key (no stale allowlist)', () => {
    for (const re of DYNAMIC_KEY_ALLOWLIST) {
      expect(keys.some(key => re.test(key))).toBe(true);
    }
  });

  it('describes PDF font coverage failures without claiming CJK is unsupported', () => {
    const copies = [
      en.bundlePdfFontUnsupported,
      zhCN.bundlePdfFontUnsupported,
      zhTW.bundlePdfFontUnsupported,
    ];

    expect(en.bundlePdfFontUnsupported).toContain('bundled PDF fonts');
    expect(copies.join('\n')).not.toMatch(/CJK|中日韩|中日韓/);
  });
});
