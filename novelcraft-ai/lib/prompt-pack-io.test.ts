import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// DB-backed: pack import/export operate on prompt_templates. Use a throwaway
// data dir so the seeded default variant is present and writes are isolated.
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-pack-io-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseVariantPack (zod validation)', () => {
  it('rejects non-JSON / non-object input', async () => {
    const { parseVariantPack } = await import('@/lib/prompt-pack-io');
    expect(() => parseVariantPack(null)).toThrow();
    expect(() => parseVariantPack('not a pack')).toThrow();
    expect(() => parseVariantPack(42)).toThrow();
  });

  it('rejects an unknown stage', async () => {
    const { parseVariantPack } = await import('@/lib/prompt-pack-io');
    expect(() =>
      parseVariantPack({
        formatVersion: 1,
        variant: 'evil',
        rows: [{ stage: 'rm_rf_slash', role: 'user', locale: 'en', templateText: 'x' }],
      }),
    ).toThrow();
  });

  it('rejects an illegal role / locale', async () => {
    const { parseVariantPack } = await import('@/lib/prompt-pack-io');
    expect(() =>
      parseVariantPack({
        formatVersion: 1,
        variant: 'x',
        rows: [{ stage: 'chapter_write', role: 'admin', locale: 'en', templateText: 'x' }],
      }),
    ).toThrow();
    expect(() =>
      parseVariantPack({
        formatVersion: 1,
        variant: 'x',
        rows: [{ stage: 'chapter_write', role: 'user', locale: 'fr', templateText: 'x' }],
      }),
    ).toThrow();
  });

  it('rejects importing over the default variant', async () => {
    const { parseVariantPack } = await import('@/lib/prompt-pack-io');
    expect(() =>
      parseVariantPack({
        formatVersion: 1,
        variant: 'default',
        rows: [{ stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'x' }],
      }),
    ).toThrow();
  });

  it('rejects an oversized template body', async () => {
    const { parseVariantPack, MAX_TEMPLATE_TEXT_LEN } = await import('@/lib/prompt-pack-io');
    expect(() =>
      parseVariantPack({
        formatVersion: 1,
        variant: 'huge',
        rows: [
          {
            stage: 'chapter_write',
            role: 'user',
            locale: 'en',
            templateText: 'x'.repeat(MAX_TEMPLATE_TEXT_LEN + 1),
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts a well-formed pack', async () => {
    const { parseVariantPack } = await import('@/lib/prompt-pack-io');
    const pack = parseVariantPack({
      formatVersion: 1,
      variant: 'good_one',
      rows: [{ stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'Write {{title}}.' }],
    });
    expect(pack.variant).toBe('good_one');
    expect(pack.rows).toHaveLength(1);
    expect(pack.rows[0].variablesSchema).toBe('{}');
  });
});

describe('import → export round-trip', () => {
  it('imports a pack and re-exports an equivalent document', async () => {
    const { importVariantPack, buildVariantPack, serializeVariantPack, parseVariantPack } = await import(
      '@/lib/prompt-pack-io'
    );

    const source = {
      formatVersion: 1 as const,
      variant: 'roundtrip_a',
      rows: [
        { stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'Custom EN {{title}}', variablesSchema: '{}' },
        { stage: 'chapter_write', role: 'system', locale: 'en', templateText: 'EN system', variablesSchema: '{}' },
      ],
    };

    const result = importVariantPack(source);
    expect(result.variant).toBe('roundtrip_a');
    expect(result.inserted).toBe(2);
    expect(result.versionedOver).toBe(false);

    const exported = buildVariantPack('roundtrip_a');
    expect(exported.rows).toHaveLength(2);
    const user = exported.rows.find((r) => r.role === 'user');
    expect(user?.templateText).toBe('Custom EN {{title}}');

    // The exported document must itself be a valid pack.
    const reparsed = parseVariantPack(JSON.parse(serializeVariantPack(exported)));
    expect(reparsed.rows).toHaveLength(2);
  });

  it('re-importing the same variant versions up instead of clobbering the default', async () => {
    const { importVariantPack } = await import('@/lib/prompt-pack-io');
    const { getPromptTemplate } = await import('@/lib/prompt-template');

    const v1 = {
      formatVersion: 1 as const,
      variant: 'versioned_b',
      rows: [{ stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'V1 {{title}}' }],
    };
    const v2 = {
      formatVersion: 1 as const,
      variant: 'versioned_b',
      rows: [{ stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'V2 {{title}}' }],
    };

    importVariantPack(v1);
    const second = importVariantPack(v2);
    expect(second.versionedOver).toBe(true);

    // Active resolution returns the latest version's text.
    const resolved = getPromptTemplate({ stage: 'chapter_write', role: 'user', locale: 'en', variant: 'versioned_b' });
    expect(resolved.templateText).toBe('V2 {{title}}');
    expect(resolved.version).toBe(2);

    // The seeded default for the same coordinate is untouched.
    const def = getPromptTemplate({ stage: 'chapter_write', role: 'user', locale: 'en', variant: 'default' });
    expect(def.variant).toBe('default');
    expect(def.templateText).not.toBe('V2 {{title}}');
  });

  it('overrideVariant lands the pack under a different name', async () => {
    const { importVariantPack, buildVariantPack } = await import('@/lib/prompt-pack-io');
    const pack = {
      formatVersion: 1 as const,
      variant: 'declared_name',
      rows: [{ stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'X {{title}}' }],
    };
    const result = importVariantPack(pack, { overrideVariant: 'forced_name' });
    expect(result.variant).toBe('forced_name');
    const exported = buildVariantPack('forced_name');
    expect(exported.variant).toBe('forced_name');
  });
});
