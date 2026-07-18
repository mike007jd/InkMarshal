import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// DB-backed server-action tests. getUser() always returns the fixed local user,
// so no auth mock is needed — a throwaway data dir gives us the seeded default
// variant plus an isolated write surface.
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-pt-actions-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('prompt-template server actions', () => {
  it('clones the default into a new variant at version 1', async () => {
    const { cloneAsVariant, getTemplate } = await import('@/app/actions/prompt-templates');
    const created = await cloneAsVariant('chapter_write', 'user', 'custom_a');
    expect(created.length).toBeGreaterThan(0);

    const en = await getTemplate('chapter_write', 'user', 'custom_a', 'en');
    expect(en).not.toBeNull();
    expect(en?.variant).toBe('custom_a');
    expect(en?.version).toBe(1);
    expect(en?.active).toBe(true);
  });

  it('refuses to clone over an existing variant', async () => {
    const { cloneAsVariant } = await import('@/app/actions/prompt-templates');
    await expect(cloneAsVariant('chapter_write', 'user', 'custom_a')).rejects.toThrow();
  });

  it('refuses to edit the default variant', async () => {
    const { saveVariantDraft } = await import('@/app/actions/prompt-templates');
    await expect(
      saveVariantDraft({
        stage: 'chapter_write',
        role: 'user',
        locale: 'en',
        variant: 'default',
        templateText: 'hacked',
      }),
    ).rejects.toThrow();
  });

  it('publishes a new version and activates it; getPromptTemplate resolves it', async () => {
    const { publishNewVersion } = await import('@/app/actions/prompt-templates');
    const { getPromptTemplate } = await import('@/lib/prompt-template');

    const published = await publishNewVersion({
      stage: 'chapter_write',
      role: 'user',
      locale: 'en',
      variant: 'custom_a',
      templateText: 'V2 body {{title}}',
    });
    expect(published.version).toBe(2);
    expect(published.active).toBe(true);

    const resolved = getPromptTemplate({ stage: 'chapter_write', role: 'user', locale: 'en', variant: 'custom_a' });
    expect(resolved.version).toBe(2);
    expect(resolved.templateText).toBe('V2 body {{title}}');
  });

  it('rolls back to an older version (active flips, no physical delete)', async () => {
    const { rollbackToVersion, listVersions } = await import('@/app/actions/prompt-templates');
    const { getPromptTemplate } = await import('@/lib/prompt-template');

    const rolled = await rollbackToVersion({
      stage: 'chapter_write',
      role: 'user',
      locale: 'en',
      variant: 'custom_a',
      targetVersion: 1,
    });
    expect(rolled.version).toBe(1);
    expect(rolled.active).toBe(true);

    const resolved = getPromptTemplate({ stage: 'chapter_write', role: 'user', locale: 'en', variant: 'custom_a' });
    expect(resolved.version).toBe(1);

    // Both versions still exist on disk — nothing was deleted.
    const all = await listVersions('chapter_write', 'user', 'custom_a');
    const enVersions = all.filter((v) => v.locale === 'en').map((v) => v.version).sort();
    expect(enVersions).toEqual([1, 2]);
    // Exactly one active row for the en coordinate.
    const activeEn = all.filter((v) => v.locale === 'en' && v.active);
    expect(activeEn).toHaveLength(1);
    expect(activeEn[0].version).toBe(1);
  });

  it('blocks deleting a variant a novel still references, then allows it after reassignment', async () => {
    const { deleteVariant, setNovelVariant } = await import('@/app/actions/prompt-templates');
    const { createNovel } = await import('@/lib/db/queries-novel');

    const novel = await createNovel({ userId: 'local-user', title: 'Bound novel' });
    await setNovelVariant(novel.id, 'custom_a');

    await expect(deleteVariant('custom_a')).rejects.toThrow();

    // Clear the binding, then deletion succeeds.
    await setNovelVariant(novel.id, '');
    const result = await deleteVariant('custom_a');
    expect(result.deleted).toBeGreaterThan(0);
  });

  it('importing a pack never overwrites the default variant', async () => {
    const { importVariantPack } = await import('@/app/actions/prompt-templates');
    const { getPromptTemplate } = await import('@/lib/prompt-template');

    const before = getPromptTemplate({ stage: 'chapter_write', role: 'user', locale: 'en', variant: 'default' });

    const json = JSON.stringify({
      formatVersion: 1,
      variant: 'imported_pack',
      rows: [{ stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'Imported {{title}}' }],
    });
    const result = await importVariantPack(json);
    expect(result.inserted).toBe(1);

    const after = getPromptTemplate({ stage: 'chapter_write', role: 'user', locale: 'en', variant: 'default' });
    expect(after.templateText).toBe(before.templateText);
    expect(after.variant).toBe('default');
  });

  it('rejects malformed import JSON', async () => {
    const { importVariantPack } = await import('@/app/actions/prompt-templates');
    await expect(importVariantPack('}{ not json')).rejects.toThrow();
    await expect(
      importVariantPack(JSON.stringify({ formatVersion: 1, variant: 'x', rows: [{ stage: 'nope', role: 'user', locale: 'en', templateText: 'y' }] })),
    ).rejects.toThrow();
  });

  it('imports from base64 (the readLocalFile path)', async () => {
    const { importVariantPackFromBase64 } = await import('@/app/actions/prompt-templates');
    const { getPromptTemplate } = await import('@/lib/prompt-template');
    const json = JSON.stringify({
      formatVersion: 1,
      variant: 'from_b64',
      rows: [{ stage: 'chapter_write', role: 'user', locale: 'en', templateText: 'B64 {{title}}' }],
    });
    const b64 = Buffer.from(json, 'utf-8').toString('base64');
    const result = await importVariantPackFromBase64(b64);
    expect(result.inserted).toBe(1);
    const resolved = getPromptTemplate({ stage: 'chapter_write', role: 'user', locale: 'en', variant: 'from_b64' });
    expect(resolved.templateText).toBe('B64 {{title}}');
  });
});
