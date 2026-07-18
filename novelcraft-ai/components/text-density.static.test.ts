import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function stringValue(file: string, key: string): string {
  const match = source(file).match(new RegExp(`${key}: '([^']*)'`));
  if (!match) throw new Error(`Missing i18n key: ${key} in ${file}`);
  return match[1];
}

describe('high-traffic UI text density', () => {
  it('keeps model drawer helper copy quiet instead of competing with state badges', () => {
    const models = source('components/ModelsPanel.tsx');
    const providers = source('components/ProviderConnectionsPanel.tsx');

    expect(models).not.toContain('<Badge variant="muted">{t.modelsTabHelperLocal}</Badge>');
    expect(models).not.toContain('<Badge variant="muted">{t.modelsTabHelperAdvanced}</Badge>');
    expect(models).not.toContain('{t.modelManagerProviderConnectionsDesc}\n              </p>');
    expect(providers).not.toContain('<p className="text-xs leading-5 text-book-ink-muted">');
  });

  it('keeps helper copy short across supported languages', () => {
    const files = ['lib/i18n/en.ts', 'lib/i18n/zh-CN.ts', 'lib/i18n/zh-TW.ts'];
    const keys = [
      'studioOnboardSubtle',
      'modelManagerProviderConnectionsDesc',
      'modelManagerDesktopOnly',
      'modelManagerSearchHint',
      'diagnosticsNoModelsDetail',
      'firstRunStarterShelfHint',
    ];

    for (const file of files) {
      for (const key of keys) {
        expect(stringValue(file, key).length, `${file}:${key}`).toBeLessThanOrEqual(58);
      }
    }
  });

  it('keeps the desktop onboarding narrative centered on local LLMs', () => {
    const files = ['lib/i18n/en.ts', 'lib/i18n/zh-CN.ts', 'lib/i18n/zh-TW.ts'];
    const keys = [
      'studioOnboardSubtle',
    ];

    for (const file of files) {
      for (const key of keys) {
        expect(stringValue(file, key), `${file}:${key}`).toContain('LLM');
      }
    }

    for (const file of files) {
      expect(stringValue(file, 'firstRunStep1Title'), file).toContain('AI');
      expect(stringValue(file, 'firstRunStep1Title'), file).not.toContain('LLM');
    }
  });

  it('keeps desktop example pitches scannable', () => {
    const files = [
      'lib/examples/spark-from-the-forge.ts',
      'lib/examples/cartographers-daughter.ts',
      'lib/examples/salt-and-hollow.ts',
      'lib/examples/last-light-of-avenmoor.ts',
    ];

    for (const file of files) {
      const match = source(file).match(/pitch: '((?:\\'|[^'])*)'/);
      if (!match) throw new Error(`Missing pitch in ${file}`);
      expect(match[1].replace(/\\'/g, "'").length, file).toBeLessThanOrEqual(82);
    }
  });
});
