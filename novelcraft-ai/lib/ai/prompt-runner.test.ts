import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { variantForStage } from '@/lib/ai/prompt-runner';
import type { NovelSettings } from '@/lib/db-types';

// Pure unit: the variant-selection precedence (per-stage override > whole-novel
// default > undefined). This is the rule the 5 ai/* call sites depend on.
describe('variantForStage', () => {
  it('returns undefined for empty settings', () => {
    expect(variantForStage(null, 'chapter_write')).toBeUndefined();
    expect(variantForStage({}, 'chapter_write')).toBeUndefined();
  });

  it('uses the whole-novel default when no stage override exists', () => {
    const s: NovelSettings = { promptVariant: 'genre_mystery' };
    expect(variantForStage(s, 'chapter_write')).toBe('genre_mystery');
  });

  it('prefers the per-stage override over the whole-novel default', () => {
    const s: NovelSettings = {
      promptVariant: 'genre_mystery',
      promptVariants: { chapter_write: 'my_custom' },
    };
    expect(variantForStage(s, 'chapter_write')).toBe('my_custom');
    // A stage without an override still falls back to the whole-novel default.
    expect(variantForStage(s, 'book_blueprint')).toBe('genre_mystery');
  });

  it('treats an empty-string variant as unset (avoids a nonexistent-variant lookup)', () => {
    expect(variantForStage({ promptVariant: '' }, 'chapter_write')).toBeUndefined();
    expect(
      variantForStage({ promptVariant: 'x', promptVariants: { chapter_write: '' } }, 'chapter_write'),
    ).toBe('x');
  });
});

// DB-backed: prove the resolver actually returns a CUSTOM variant's text once a
// variant row exists, and falls back to the seeded default text otherwise. This
// is the "接通" check — without it, custom templates would silently resolve to
// default.
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-prompt-runner-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveTemplate with a custom variant', () => {
  it('returns the custom variant text when present, default text otherwise', async () => {
    const { resolveTemplate } = await import('@/lib/ai/prompt-runner');
    const { importVariantPack } = await import('@/lib/prompt-pack-io');

    const defaultText = resolveTemplate('chapter_write', 'user', 'en');
    expect(defaultText.length).toBeGreaterThan(0);

    expect(() => resolveTemplate('chapter_write', 'user', 'en', 'nope_variant'))
      .toThrow(/prompt template not found/);

    importVariantPack({
      formatVersion: 1,
      variant: 'runner_custom',
      rows: [{ stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'CUSTOM {{title}}' }],
    });

    expect(resolveTemplate('chapter_write', 'user', 'en', 'runner_custom')).toBe('CUSTOM {{title}}');
    // Default coordinate is unaffected.
    expect(resolveTemplate('chapter_write', 'user', 'en')).toBe(defaultText);
  });
});
