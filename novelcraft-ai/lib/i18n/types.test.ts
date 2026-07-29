import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { normalizeLocale, parseSupportedLocale } from '@/lib/i18n/types';
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

  it('distinguishes unsupported values when callers need a nullable result', () => {
    expect(parseSupportedLocale('zh%2DHant')).toBe('zh-TW');
    expect(parseSupportedLocale('')).toBeNull();
    expect(parseSupportedLocale('not-a-locale')).toBeNull();
    expect(parseSupportedLocale('%E0%A4%A')).toBeNull();
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

  it('keeps Chinese status copy readable and uses typographic ellipses', () => {
    const english = getTranslations('en');
    const simplified = getTranslations('zh-CN');
    const traditional = getTranslations('zh-TW');

    expect(simplified.statusBarUnbound.replace('{op}', 'Agent')).toBe('Agent 尚未设置');
    expect(traditional.statusBarUnbound.replace('{op}', 'Agent')).toBe('Agent 尚未設定');
    expect(english.editorChapterLabel.replace('{num}', '1')).toBe('Chapter 1 editor');
    expect(simplified.editorChapterLabel.replace('{num}', '1')).toBe('第 1 章编辑器');
    expect(traditional.editorChapterLabel.replace('{num}', '1')).toBe('第 1 章編輯器');

    const assertNoAsciiEllipses = (value: unknown, path: string[] = []) => {
      if (typeof value === 'string') {
        expect(value, path.join('.')).not.toContain('...');
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        assertNoAsciiEllipses(child, [...path, key]);
      }
    };

    assertNoAsciiEllipses(simplified);
    assertNoAsciiEllipses(traditional);
  });

  it('keeps inline Chinese product copy free of ASCII ellipses', () => {
    const sourceFiles: string[] = [];
    const collectSourceFiles = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          collectSourceFiles(entryPath);
        } else if (
          /\.(?:ts|tsx)$/.test(entry.name)
          && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
          && entry.name !== 'prompt-seed.ts'
        ) {
          sourceFiles.push(entryPath);
        }
      }
    };
    for (const directory of ['app', 'components', 'lib']) {
      collectSourceFiles(path.join(process.cwd(), directory));
    }

    const violations: string[] = [];
    const containsBadChineseEllipsis = (value: string) =>
      /\p{Script=Han}/u.test(value) && value.includes('...');
    for (const filePath of sourceFiles) {
      const sourceText = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const walk = (node: ts.Node) => {
        let value: string | undefined;
        if (ts.isStringLiteralLike(node)) {
          value = node.text;
        } else if (ts.isTemplateExpression(node)) {
          value = [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join('');
        }
        if (value && containsBadChineseEllipsis(value)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push(`${path.relative(process.cwd(), filePath)}:${line + 1}`);
        }
        ts.forEachChild(node, walk);
      };
      walk(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
