// Integration tests for project-backup (W1-3) against real SQLite via the
// temp-DATA_DIR + getDb pattern. Covers every reviewer-flagged invariant:
//   - export produces the full fixed package layout (unzip check)
//   - no secret leaks: grep the whole package for apiKey/token and assert
//     manifest.secretsStripped === true
//   - tamper one byte → sha256 mismatch rejected
//   - delete a relation's target entry → referential integrity (dangling) caught
//   - restore creates a copy: new novelId, counts match, original untouched
//   - clean-DB import: copy opens, content + snapshots visible, templates render

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { strFromU8, unzipSync, Zip, ZipDeflate } from 'fflate';
import { LOCAL_USER_ID } from '@/lib/local-user';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-backup-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  return {
    db: await import('@/lib/db'),
    extract: await import('@/lib/backup/extract'),
    build: await import('@/lib/backup/build-package'),
    verify: await import('@/lib/backup/verify'),
    restore: await import('@/lib/backup/restore'),
    knowledge: await import('@/lib/knowledge/index-sync'),
    connection: await import('@/lib/db/connection'),
  };
}

async function replacePackagedJson(
  bytes: Uint8Array,
  packagePath: string,
  value: unknown,
): Promise<Uint8Array> {
  const entries = unzipSync(bytes);
  entries[packagePath] = new TextEncoder().encode(JSON.stringify(value));
  const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
    sha256: Record<string, string>;
  };
  const { sha256Hex } = await import('@/lib/backup/build-package');
  manifest.sha256[packagePath] = await sha256Hex(entries[packagePath]);
  entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
  const { zipSync } = await import('fflate');
  return zipSync(entries, { level: 6 });
}

/**
 * Build a fully-populated novel: settings (with a secret), 2 chapters (one with
 * a snapshot), a 2-chapter blueprint/outline, 2 knowledge entries + a relation
 * between them, and a unification report.
 */
async function buildRichNovel(): Promise<{ novelId: string; entryIds: string[] }> {
  const { db, knowledge } = await mods();
  const novel = await db.createNovel({ userId: LOCAL_USER_ID, title: 'Backup Source' });
  const novelId = novel.id;

  // Settings with a secret key that MUST be stripped.
  await db.updateNovel(novelId, {
    settings: {
      creativity: 'balanced',
      dailyWordGoal: 1500,
      // Secret payloads — must never reach the package. The excess-property check
      // fires on the whole literal, so one directive covers both injected fields.
      // @ts-expect-error — deliberately injecting non-schema secret fields.
      providerApiKey: 'sk-LIVE-DO-NOT-LEAK-123',
      auth: { token: 'bearer-SECRET-TOKEN-456', label: 'keep-me' },
    },
  });

  // Blueprint → outline rows.
  await db.setNovelBlueprint(novelId, {
    chapters: [
      { chapterNumber: 1, title: 'Opening', summary: 'The start.' },
      { chapterNumber: 2, title: 'Rising', summary: 'It escalates.' },
    ],
    targetWordsPerChapter: 2000,
    generatedAt: new Date().toISOString(),
    modelId: 'test-model',
  });

  // Chapters with content + a snapshot on ch1.
  await db.upsertChapter(novelId, 1, 'Opening', 'Once upon a time, chapter one body.');
  await db.upsertChapter(novelId, 2, 'Rising', 'And then chapter two body unfolds.');
  await db.createChapterSnapshot(novelId, 1, 'milestone');

  // Re-project the blueprint now that chapters exist so the outline rows carry a
  // populated `data.chapterId` (only blueprint projection back-fills the link).
  // This exercises the restore's chapterId remap path with non-empty ids.
  await db.setNovelBlueprint(novelId, {
    chapters: [
      { chapterNumber: 1, title: 'Opening', summary: 'The start.' },
      { chapterNumber: 2, title: 'Rising', summary: 'It escalates.' },
    ],
    targetWordsPerChapter: 2000,
    generatedAt: new Date().toISOString(),
    modelId: 'test-model',
  });

  // Knowledge entries + a relation.
  const e1Id = crypto.randomUUID();
  const e2Id = crypto.randomUUID();
  const now = new Date().toISOString();
  const e1Data = { description: 'A brave hero', aliases: [], importance: 'major' };
  const e2Data = { description: 'A shadowy city', details: {} };
  const e1Index = await knowledge.buildKnowledgeIndexInsert({
    id: e1Id, novelId, type: 'character', title: 'Hero', summary: 'A brave hero',
    data: e1Data, tags: ['protagonist'], updatedAt: now,
  });
  const e2Index = await knowledge.buildKnowledgeIndexInsert({
    id: e2Id, novelId, type: 'world', title: 'City', summary: 'A shadowy city',
    data: e2Data, tags: [], updatedAt: now,
  });
  await db.createKnowledgeEntryWithIndex({
    id: e1Id, novelId, type: 'character', title: 'Hero', summary: 'A brave hero',
    data: JSON.stringify(e1Data), sortOrder: 0, tags: JSON.stringify(['protagonist']),
    createdAt: now, updatedAt: now,
  }, e1Index);
  await db.createKnowledgeEntryWithIndex({
    id: e2Id, novelId, type: 'world', title: 'City', summary: 'A shadowy city',
    data: JSON.stringify(e2Data), sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
  }, e2Index);

  const relIndex = await knowledge.buildKnowledgeIndexInsert({
    id: e1Id, novelId, type: 'character', title: 'Hero', summary: 'A brave hero',
    data: { ...e1Data, relations: [{ target: 'City', type: 'lives_in', label: '' }] },
    tags: ['protagonist'], updatedAt: now,
  });
  await db.createKnowledgeRelationWithSourceIndex({
    id: crypto.randomUUID(), sourceId: e1Id, targetId: e2Id,
    relationType: 'lives_in', label: '', createdAt: now,
  }, relIndex);

  // Unification report (revision items).
  await db.persistUnificationReportWithMessage(
    novelId,
    {
      edits: [
        {
          id: 'edit-1', chapterNumber: 1, original: 'time', replacement: 'a time',
          rationale: 'clarity', severity: 'minor',
        },
      ],
      summary: 'one minor edit',
      generatedAt: now,
      modelId: 'test-model',
    },
    'Unification done.',
  );

  // Volume summaries (book-owned canonical history on novels.volume_summaries).
  await db.appendVolumeSummary(novelId, {
    start: 1,
    end: 2,
    summary: 'Opening arc wraps chapters 1-2.',
  });

  // Conversations + nested parent-message fork + a null-conversation message.
  const rootConv = await db.createConversation({
    id: crypto.randomUUID(),
    novelId,
    userId: LOCAL_USER_ID,
    topic: 'plot',
    title: 'Root thread',
    parentMessageId: null,
    createdAt: now,
    updatedAt: now,
  });
  const rootUserMsg = await db.addMessage(novelId, 'user', 'What happens next?', rootConv.id);
  const rootAssistantMsg = await db.addMessage(
    novelId,
    'assistant',
    'The hero leaves the city.',
    rootConv.id,
  );
  const forkConv = await db.createConversation({
    id: crypto.randomUUID(),
    novelId,
    userId: LOCAL_USER_ID,
    topic: 'characters',
    title: 'Fork about the hero',
    parentMessageId: rootAssistantMsg.id,
    createdAt: now,
    updatedAt: now,
  });
  await db.addMessage(novelId, 'user', 'Tell me more about the hero.', forkConv.id);
  // Novel-scoped message with null conversation_id (still book-owned history).
  await db.addMessage(novelId, 'system', 'Null-conversation system note.', null);
  // Keep a stable handle so restore tests can assert the fork remap.
  void rootUserMsg;

  // Chapter chat history (status + changes preserved).
  await db.addChatMessage(novelId, 1, {
    role: 'user',
    content: 'Tighten the opening line.',
    status: 'pending',
  });
  await db.addChatMessage(novelId, 1, {
    role: 'assistant',
    content: 'Opening line revised.',
    changes: JSON.stringify([{ from: 'Once', to: 'Long ago' }]),
    status: 'applied',
  });

  return { novelId, entryIds: [e1Id, e2Id] };
}

describe('export → package layout', () => {
  it('produces the full fixed layout with all sections present', async () => {
    const { extract, build } = await mods();
    const { novelId } = await buildRichNovel();

    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes, manifest } = await build.buildBackupPackage(bundle);

    const entries = unzipSync(bytes);
    const names = Object.keys(entries);

    expect(names).toContain('manifest.json');
    expect(names).toContain('novel.json');
    expect(names).toContain('chapters/0001.json');
    expect(names).toContain('chapters/0002.json');
    expect(names).toContain('knowledge/entries.json');
    expect(names).toContain('knowledge/relations.json');
    expect(names).toContain('outline.json');
    expect(names).toContain('unification.json');
    expect(names).toContain('prompt-templates.json');
    expect(names).toContain('history/conversations.json');
    expect(names).toContain('history/messages.json');
    expect(names).toContain('history/chapter-chat.json');

    expect(manifest.formatVersion).toBe('2.0');
    expect(manifest.counts.chapters).toBe(2);
    expect(manifest.counts.outline).toBe(2);
    expect(manifest.counts.knowledgeRelations).toBe(1);
    // Entries include the 2 explicit ones + 2 outline rows (outline entries).
    expect(manifest.counts.knowledgeEntries).toBe(4);
    expect(manifest.counts.conversations).toBeGreaterThanOrEqual(2);
    expect(manifest.counts.messages).toBeGreaterThanOrEqual(4);
    expect(manifest.counts.chapterChat).toBe(2);
    expect(manifest.sha256['history/conversations.json']).toBeTruthy();
    expect(manifest.sha256['history/messages.json']).toBeTruthy();
    expect(manifest.sha256['history/chapter-chat.json']).toBeTruthy();
    expect(manifest.secretsStripped).toBe(true);

    const novelJson = JSON.parse(strFromU8(entries['novel.json'])) as {
      volumeSummaries: { start: number; end: number; summary: string }[];
    };
    expect(novelJson.volumeSummaries).toEqual([
      { start: 1, end: 2, summary: 'Opening arc wraps chapters 1-2.' },
    ]);
  });
});

describe('secret stripping', () => {
  it('package bytes contain no apiKey/token/secret material', async () => {
    const { extract, build } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes, manifest } = await build.buildBackupPackage(bundle);

    // Decompress every entry and grep the decoded text — a secret could hide in
    // any section, not just novel.json.
    const entries = unzipSync(bytes);
    const allText = Object.values(entries).map(b => strFromU8(b)).join('\n');

    expect(allText).not.toContain('sk-LIVE-DO-NOT-LEAK-123');
    expect(allText).not.toContain('bearer-SECRET-TOKEN-456');
    expect(allText.toLowerCase()).not.toContain('apikey');
    expect(allText.toLowerCase()).not.toContain('providerapikey');
    // A non-secret sibling under the same object is preserved.
    expect(allText).toContain('keep-me');
    expect(manifest.secretsStripped).toBe(true);
  });
});

describe('verify — integrity', () => {
  it('accepts a clean package', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.bundle).not.toBeNull();
  });

  it('rejects a one-byte tamper with a sha256 mismatch', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    // Repack with a mutated novel.json so its bytes no longer match the manifest.
    const entries = unzipSync(bytes);
    const novelText = strFromU8(entries['novel.json']);
    const tampered = novelText.replace('Backup Source', 'Tampered Title!');
    entries['novel.json'] = new TextEncoder().encode(tampered);
    const { zipSync } = await import('fflate');
    const repacked = zipSync(entries, { level: 6 });

    const report = await verify.verifyBackupPackage(repacked);
    expect(report.ok).toBe(false);
    expect(report.errors.some(e => e.code === 'sha256_mismatch')).toBe(true);
  });

  it('rejects a tampered file even when its checksum entry is removed', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const entries = unzipSync(bytes);
    entries['novel.json'] = new TextEncoder().encode('{"title":"tampered"}');
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    delete manifest.sha256['novel.json'];
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const { zipSync } = await import('fflate');

    const report = await verify.verifyBackupPackage(zipSync(entries, { level: 6 }));
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'missing_checksum',
      ref: 'novel.json',
    }));
    expect(report.bundle).toBeNull();
  });

  it('does not mistake prototype property names for manifest checksums', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const entries = Object.assign(Object.create(null) as Record<string, Uint8Array>, unzipSync(bytes));
    entries['toString'] = new TextEncoder().encode('unlisted payload');
    const { zipSync } = await import('fflate');

    const report = await verify.verifyBackupPackage(zipSync(entries, { level: 6 }));
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'missing_checksum',
      ref: 'toString',
    }));
  });

  it('rejects a dangling relation when a target entry is removed', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);

    // Drop the relation's target entry from the bundle, then rebuild + verify.
    const targetId = bundle.knowledgeRelations[0].targetId;
    bundle.knowledgeEntries = bundle.knowledgeEntries.filter(e => e.id !== targetId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(false);
    expect(report.errors.some(e => e.code === 'dangling_relation')).toBe(true);
  });

  it('rejects an incompatible major format version', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const entries = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    manifest.formatVersion = '9.0';
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const { zipSync } = await import('fflate');
    const repacked = zipSync(entries, { level: 6 });

    const report = await verify.verifyBackupPackage(repacked);
    expect(report.formatCompatible).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('accepts current 2.0 and rejects unknown legacy or future formats', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const current = await verify.verifyBackupPackage(bytes);
    expect(current.formatCompatible).toBe(true);
    expect(current.ok).toBe(true);
    expect(current.manifest?.formatVersion).toBe('2.0');

    const { zipSync } = await import('fflate');
    for (const unsupportedVersion of [
      '1.2',
      '1.9',
      '2.1',
      '2.9',
      '3.0',
      '2.x',
      '2',
      '2.0.0',
    ]) {
      const entries = unzipSync(bytes);
      const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
        formatVersion: string;
      };
      manifest.formatVersion = unsupportedVersion;
      entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
      const report = await verify.verifyBackupPackage(zipSync(entries, { level: 6 }));
      expect(report.formatCompatible).toBe(false);
      expect(report.ok).toBe(false);
      expect(report.errors).toContainEqual(
        expect.objectContaining({ code: 'format_incompatible', ref: unsupportedVersion }),
      );
    }
  });

  it('requires processingStatus in every 2.0 chapter payload', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const entries = unzipSync(bytes);
    const chapterPath = 'chapters/0001.json';
    const chapter = JSON.parse(strFromU8(entries[chapterPath])) as Record<string, unknown>;
    delete chapter.processingStatus;

    const report = await verify.verifyBackupPackage(
      await replacePackagedJson(bytes, chapterPath, chapter),
    );
    expect(report.ok).toBe(false);
    expect(report.bundle).toBeNull();
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'corrupt_section',
      ref: chapterPath,
    }));
  });

  it('rejects nonempty attachments instead of verifying them as restorable', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    bundle.attachments = [
      { name: 'cover.bin', contentsBase64: Buffer.from('attachment-bytes').toString('base64') },
    ];
    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(false);
    expect(report.bundle).toBeNull();
    expect(report.errors).toContainEqual(
      expect.objectContaining({ code: 'unsupported_attachments' }),
    );
  });

  it('rejects missing or partially malformed volume summaries in format 1.1+', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    bundle.novel.volumeSummaries = [{ start: 1, end: 2, summary: 'Keep this.' }];
    const { bytes } = await build.buildBackupPackage(bundle);
    const cleanNovel = JSON.parse(strFromU8(unzipSync(bytes)['novel.json'])) as Record<string, unknown>;

    for (const novelJson of [
      Object.fromEntries(Object.entries(cleanNovel).filter(([key]) => key !== 'volumeSummaries')),
      {
        ...cleanNovel,
        volumeSummaries: [
          { start: 1, end: 2, summary: 'Valid' },
          { start: 3, end: 4 },
        ],
      },
    ]) {
      const report = await verify.verifyBackupPackage(
        await replacePackagedJson(bytes, 'novel.json', novelJson),
      );
      expect(report.ok).toBe(false);
      expect(report.bundle).toBeNull();
      expect(report.errors).toContainEqual(expect.objectContaining({
        code: 'corrupt_section',
        ref: 'novel.json',
      }));
    }
  });

  it('returns controlled corrupt_section reports for malformed fixed array sections', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    for (const packagePath of [
      'knowledge/entries.json',
      'knowledge/relations.json',
      'outline.json',
      'prompt-templates.json',
    ]) {
      const malformed = await replacePackagedJson(bytes, packagePath, {});
      await expect(verify.verifyBackupPackage(malformed)).resolves.toEqual(
        expect.objectContaining({
          ok: false,
          bundle: null,
          errors: expect.arrayContaining([
            expect.objectContaining({ code: 'corrupt_section', ref: packagePath }),
          ]),
        }),
      );
    }
  });

  it('rejects duplicate restore identities before SQLite remapping', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    for (const packagePath of [
      'knowledge/entries.json',
      'knowledge/relations.json',
      'history/conversations.json',
      'history/messages.json',
      'history/chapter-chat.json',
    ]) {
      const entries = unzipSync(bytes);
      const rows = JSON.parse(strFromU8(entries[packagePath])) as unknown[];
      expect(rows.length, packagePath).toBeGreaterThan(0);
      const duplicated = await replacePackagedJson(bytes, packagePath, [
        ...rows,
        rows[0],
      ]);
      const report = await verify.verifyBackupPackage(duplicated);
      expect(report.ok, packagePath).toBe(false);
      expect(report.bundle, packagePath).toBeNull();
      expect(report.errors, packagePath).toContainEqual(expect.objectContaining({
        code: 'duplicate_identity',
      }));
    }

    const entries = unzipSync(bytes);
    const chapterPath = Object.keys(entries).find(
      path => path.startsWith('chapters/') && path.endsWith('.json'),
    );
    expect(chapterPath).toBeTruthy();
    const duplicatePath = 'chapters/9999.json';
    entries[duplicatePath] = entries[chapterPath!];
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
      counts: { chapters: number };
      sha256: Record<string, string>;
    };
    const { sha256Hex } = await import('@/lib/backup/build-package');
    manifest.counts.chapters += 1;
    manifest.sha256[duplicatePath] = await sha256Hex(entries[duplicatePath]);
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const { zipSync } = await import('fflate');
    const report = await verify.verifyBackupPackage(zipSync(entries, { level: 6 }));
    expect(report.ok).toBe(false);
    expect(report.bundle).toBeNull();
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'duplicate_identity',
      detail: expect.stringContaining('chapter number'),
    }));
  });

  it('rejects outline.json rows that drift from their canonical knowledge entries', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    bundle.outline[0] = {
      ...bundle.outline[0],
      chapterNumber: bundle.outline[0].chapterNumber + 10,
    };

    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);

    expect(report.ok).toBe(false);
    expect(report.bundle).toBeNull();
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'conflicting_outline_projection',
      ref: bundle.outline[0].entryId,
    }));
  });

  it('rejects one old chapter id mapped to different outline chapter numbers', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const sharedChapterId = bundle.outline[0].chapterId;
    expect(sharedChapterId).not.toBe('');
    bundle.outline[1] = {
      ...bundle.outline[1],
      chapterId: sharedChapterId,
    };
    const secondEntry = bundle.knowledgeEntries.find(
      entry => entry.id === bundle.outline[1].entryId,
    );
    expect(secondEntry).toBeDefined();
    secondEntry!.data = JSON.stringify({
      ...JSON.parse(secondEntry!.data) as Record<string, unknown>,
      chapterId: sharedChapterId,
    });

    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);

    expect(report.ok).toBe(false);
    expect(report.bundle).toBeNull();
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'conflicting_outline_projection',
      ref: sharedChapterId,
    }));
  });

  it('rejects outline parents that are missing or are not outline entries', async () => {
    const { extract, build, verify } = await mods();
    const { novelId, entryIds } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const child = bundle.knowledgeEntries.find(
      entry => entry.id === bundle.outline[1].entryId,
    );
    expect(child).toBeDefined();

    for (const parentId of ['missing-outline-parent', entryIds[0]]) {
      child!.data = JSON.stringify({
        ...JSON.parse(child!.data) as Record<string, unknown>,
        parentId,
      });
      const { bytes } = await build.buildBackupPackage(bundle);
      const report = await verify.verifyBackupPackage(bytes);

      expect(report.ok, parentId).toBe(false);
      expect(report.bundle, parentId).toBeNull();
      expect(report.errors, parentId).toContainEqual(expect.objectContaining({
        code: 'conflicting_outline_projection',
        ref: child!.id,
      }));
    }
  });
});

describe('restore — create a copy', () => {
  it('rejects nonempty attachments before any DB mutation', async () => {
    const { db, extract, restore, connection } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const gdb = connection.getDb();
    const novelsBefore = (
      gdb.prepare('SELECT COUNT(*) AS n FROM novels').get() as { n: number }
    ).n;

    await expect(
      restore.restoreBundleAsCopy({
        ...bundle,
        attachments: [
          {
            name: 'cover.bin',
            contentsBase64: Buffer.from('attachment-bytes').toString('base64'),
          },
        ],
      }),
    ).rejects.toThrow(/cannot restore package attachments/i);

    const novelsAfter = (
      gdb.prepare('SELECT COUNT(*) AS n FROM novels').get() as { n: number }
    ).n;
    expect(novelsAfter).toBe(novelsBefore);
    expect(await db.getNovel(novelId)).toBeDefined();
  });

  it('mints a new novelId, matches counts, and leaves the original untouched', async () => {
    const { db, extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();

    const originalBefore = await db.getNovel(novelId);
    const originalChaptersBefore = await db.getChapters(novelId);
    const originalEntriesBefore = await db.getKnowledgeEntriesByNovel(novelId);

    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);

    const result = await restore.restoreBundleAsCopy(report.bundle!);

    // New id, distinct from the source.
    expect(result.novelId).not.toBe(novelId);
    expect(result.counts.chapters).toBe(2);
    expect(result.counts.knowledgeRelations).toBe(1);

    // The copy is real + openable.
    const copy = await db.getNovel(result.novelId);
    expect(copy).toBeDefined();
    expect(copy!.title).toBe('Backup Source');

    const copyChapters = await db.getChapters(result.novelId);
    expect(copyChapters).toHaveLength(2);
    expect(copyChapters[0].content).toContain('chapter one body');
    // Snapshot survived the round-trip.
    const ch1 = await db.getChapter(result.novelId, 1);
    expect((ch1!.snapshots ?? []).length).toBeGreaterThan(0);

    // Relation re-points within the COPY's id space (same-novel trigger held).
    const copyRelations = await db.getKnowledgeRelationsByNovel(result.novelId);
    expect(copyRelations).toHaveLength(1);
    const copyEntries = await db.getKnowledgeEntriesByNovel(result.novelId);
    const copyEntryIds = new Set(copyEntries.map(e => e.id));
    expect(copyEntryIds.has(copyRelations[0].source_id)).toBe(true);
    expect(copyEntryIds.has(copyRelations[0].target_id)).toBe(true);

    // Outline survived + chapter linkage remapped to the copy's chapter ids.
    const copyOutline = await db.getOutlineWithChapterStatus(result.novelId);
    expect(copyOutline).toHaveLength(2);
    expect(copyOutline.some(r => r.hasChapter)).toBe(true);

    // The outline rows' embedded chapterId must point at chapters that exist in
    // the COPY (not the source) — i.e. the id remap actually rewired the link.
    const copyChapterIdSet = new Set(copyChapters.map(c => c.id));
    const outlineRows = await db.getOutlineEntries(result.novelId);
    let linkedCount = 0;
    for (const row of outlineRows) {
      const data = JSON.parse(row.data) as { chapterId?: string };
      if (data.chapterId) {
        expect(copyChapterIdSet.has(data.chapterId)).toBe(true);
        linkedCount += 1;
      }
    }
    // Both outline rows had drafted chapters, so both links must be present.
    expect(linkedCount).toBe(2);

    // Original is byte-for-byte unchanged.
    const originalAfter = await db.getNovel(novelId);
    expect(originalAfter!.title).toBe(originalBefore!.title);
    expect((await db.getChapters(novelId)).length).toBe(originalChaptersBefore.length);
    expect((await db.getKnowledgeEntriesByNovel(novelId)).length).toBe(originalEntriesBefore.length);
  });

  it('round-trips content_saved under an explicit 2.0 version signal', async () => {
    const { db, extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();
    await db.updateChapterMeta(novelId, 1, { processingStatus: 'content_saved' });

    const bundle = await extract.extractBackupBundle(novelId);
    expect(bundle.chapters.find(ch => ch.chapterNumber === 1)?.processingStatus)
      .toBe('content_saved');

    const { bytes, manifest } = await build.buildBackupPackage(bundle);
    expect(manifest.formatVersion).toBe('2.0');
    expect(manifest.formatVersion.split('.')[0]).not.toBe('1');
    const packagedChapter = JSON.parse(
      strFromU8(unzipSync(bytes)['chapters/0001.json']),
    ) as Record<string, unknown>;
    expect(packagedChapter.processingStatus).toBe('content_saved');

    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);
    const result = await restore.restoreBundleAsCopy(report.bundle!);
    expect((await db.getChapter(result.novelId, 1))?.processingStatus)
      .toBe('content_saved');
  });

  it('remaps outline parentId links into the restored entry id space', async () => {
    const { db, extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const sourceParentId = bundle.outline[0].entryId;
    const sourceChildId = bundle.outline[1].entryId;
    const sourceParent = bundle.knowledgeEntries.find(entry => entry.id === sourceParentId);
    const sourceChild = bundle.knowledgeEntries.find(entry => entry.id === sourceChildId);
    expect(sourceParent).toBeDefined();
    expect(sourceChild).toBeDefined();
    sourceChild!.data = JSON.stringify({
      ...JSON.parse(sourceChild!.data) as Record<string, unknown>,
      parentId: sourceParentId,
    });

    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);
    const result = await restore.restoreBundleAsCopy(report.bundle!);
    const restoredEntries = await db.getKnowledgeEntriesByNovel(result.novelId);
    const restoredParent = restoredEntries.find(
      entry => entry.type === 'outline' && entry.title === sourceParent!.title,
    );
    const restoredChild = restoredEntries.find(
      entry => entry.type === 'outline' && entry.title === sourceChild!.title,
    );
    expect(restoredParent).toBeDefined();
    expect(restoredChild).toBeDefined();
    const restoredChildData = JSON.parse(restoredChild!.data) as { parentId?: string };

    expect(restoredParent!.id).not.toBe(sourceParentId);
    expect(restoredChildData.parentId).toBe(restoredParent!.id);
  });

  it('restores into a clean DB-like state: copy is independent of source deletion', async () => {
    const { db, extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();

    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);
    const result = await restore.restoreBundleAsCopy(report.bundle!);

    // Delete the source entirely — the copy must remain intact + openable.
    await db.deleteNovelCascade(novelId, LOCAL_USER_ID);
    expect(await db.getNovel(novelId)).toBeUndefined();

    const copy = await db.getNovel(result.novelId);
    expect(copy).toBeDefined();
    const copyChapters = await db.getChapters(result.novelId);
    expect(copyChapters).toHaveLength(2);
    expect(copyChapters[1].content).toContain('chapter two body');
  });

  // S5b: a post-commit outline-reorder failure used to be swallowed
  // (console.warn only) and the restore reported full success — leaving a
  // scrambled chapter order with no signal to the user. The fix surfaces the
  // failure as a warning on RestoreResult (the copy is still intact).
  it('surfaces a warning when the post-commit outline reorder fails', async () => {
    const { extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();

    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);

    const reorderModule = await import('@/lib/db/queries-knowledge');
    const spy = vi.spyOn(reorderModule, 'reorderOutlineAtomic').mockRejectedValue(
      new Error('forced reorder failure'),
    );
    try {
      const result = await restore.restoreBundleAsCopy(report.bundle!);
      // The restore still succeeds (copy intact)…
      expect(result.novelId).toBeTruthy();
      expect(result.counts.chapters).toBe(2);
      // …but warns the user the outline order may need a manual re-save.
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0]).toMatch(/outline order/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves volume summaries, nested conversation refs, null-conversation messages, and chapter chat with remapped ids', async () => {
    const { db, extract, build, verify, restore, connection } = await mods();
    const { novelId } = await buildRichNovel();

    const sourceBundle = await extract.extractBackupBundle(novelId);
    expect(sourceBundle.novel.volumeSummaries).toEqual([
      { start: 1, end: 2, summary: 'Opening arc wraps chapters 1-2.' },
    ]);
    expect(sourceBundle.conversations.length).toBeGreaterThanOrEqual(2);
    expect(sourceBundle.messages.some(m => m.conversationId == null)).toBe(true);
    expect(sourceBundle.messages.some(m => m.conversationId != null)).toBe(true);
    expect(sourceBundle.chapterChat).toHaveLength(2);

    const fork = sourceBundle.conversations.find(c => c.parentMessageId != null);
    expect(fork).toBeDefined();
    expect(sourceBundle.messages.some(m => m.id === fork!.parentMessageId)).toBe(true);

    const { bytes } = await build.buildBackupPackage(sourceBundle);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);

    const result = await restore.restoreBundleAsCopy(report.bundle!);
    expect(result.novelId).not.toBe(novelId);

    const volumes = await db.getVolumeSummaries(result.novelId);
    expect(volumes).toEqual([
      { start: 1, end: 2, summary: 'Opening arc wraps chapters 1-2.' },
    ]);

    const gdb = connection.getDb();
    const copyConvs = gdb
      .prepare('SELECT * FROM conversations WHERE novel_id = ? ORDER BY created_at ASC, id ASC')
      .all(result.novelId) as {
        id: string;
        parent_message_id: string | null;
        topic: string;
        title: string;
        is_archived: number;
      }[];
    const copyMsgs = gdb
      .prepare('SELECT * FROM messages WHERE novel_id = ? ORDER BY created_at ASC, id ASC')
      .all(result.novelId) as {
        id: string;
        conversation_id: string | null;
        role: string;
        content: string;
      }[];
    const copyChat = gdb
      .prepare('SELECT * FROM chapter_chat_history WHERE novel_id = ? ORDER BY created_at ASC, id ASC')
      .all(result.novelId) as {
        id: string;
        chapter_number: number;
        role: string;
        content: string;
        changes: string | null;
        status: string;
      }[];

    expect(copyConvs.length).toBe(sourceBundle.conversations.length);
    expect(copyMsgs.length).toBe(sourceBundle.messages.length);
    expect(copyChat).toHaveLength(2);

    // All conversation / message ids were reminted.
    const sourceConvIds = new Set(sourceBundle.conversations.map(c => c.id));
    const sourceMsgIds = new Set(sourceBundle.messages.map(m => m.id));
    const sourceChatIds = new Set(sourceBundle.chapterChat.map(c => c.id));
    for (const c of copyConvs) expect(sourceConvIds.has(c.id)).toBe(false);
    for (const m of copyMsgs) expect(sourceMsgIds.has(m.id)).toBe(false);
    for (const c of copyChat) expect(sourceChatIds.has(c.id)).toBe(false);

    // Nested parent-message reference remapped completely into the copy.
    const copyFork = copyConvs.find(c => c.parent_message_id != null);
    expect(copyFork).toBeDefined();
    expect(copyMsgs.some(m => m.id === copyFork!.parent_message_id)).toBe(true);
    expect(sourceMsgIds.has(copyFork!.parent_message_id!)).toBe(false);

    // Null-conversation message survived with null conversation_id.
    expect(copyMsgs.some(m => m.conversation_id == null && m.content.includes('Null-conversation'))).toBe(true);

    // Non-null conversation refs point only at copy conversation ids.
    const copyConvIds = new Set(copyConvs.map(c => c.id));
    for (const m of copyMsgs) {
      if (m.conversation_id != null) expect(copyConvIds.has(m.conversation_id)).toBe(true);
    }

    // Chapter chat preserves content/status/changes with fresh ids.
    const applied = copyChat.find(c => c.status === 'applied');
    expect(applied).toBeDefined();
    expect(applied!.chapter_number).toBe(1);
    expect(applied!.changes).toContain('Long ago');
    expect(copyChat.some(c => c.role === 'user' && c.content.includes('Tighten'))).toBe(true);
  });
});

describe('published 1.x backward compatibility', () => {
  it('normalizes v1.1 chapters to complete without a lifecycle contract', async () => {
    const { db, extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const entries = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
      formatVersion: string;
      sha256: Record<string, string>;
    };
    const { sha256Hex } = await import('@/lib/backup/build-package');
    for (const chapterPath of Object.keys(entries).filter(path =>
      path.startsWith('chapters/') && path.endsWith('.json')
    )) {
      const chapter = JSON.parse(strFromU8(entries[chapterPath])) as Record<string, unknown>;
      if (chapterPath === 'chapters/0001.json') {
        // An unknown extra field cannot smuggle 2.0 lifecycle semantics under a
        // 1.1 version signal; published 1.x chapters are complete by contract.
        chapter.processingStatus = 'content_saved';
      } else {
        delete chapter.processingStatus;
      }
      entries[chapterPath] = new TextEncoder().encode(JSON.stringify(chapter));
      manifest.sha256[chapterPath] = await sha256Hex(entries[chapterPath]);
    }
    manifest.formatVersion = '1.1';
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const { zipSync } = await import('fflate');

    const report = await verify.verifyBackupPackage(zipSync(entries, { level: 6 }));
    expect(report.formatCompatible).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.bundle!.chapters.every(ch => ch.processingStatus === 'complete'))
      .toBe(true);

    const result = await restore.restoreBundleAsCopy(report.bundle!);
    expect((await db.getChapters(result.novelId)).every(
      chapter => chapter.processingStatus === 'complete',
    )).toBe(true);
  });

  it('verifies and restores a v1.0 package without history files / volumeSummaries as empty history', async () => {
    const { db, extract, build, verify, restore, connection } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    // Strip 1.1-only payload so the rebuilt bytes look like a legacy 1.0 package.
    bundle.conversations = [];
    bundle.messages = [];
    bundle.chapterChat = [];
    bundle.novel.volumeSummaries = [];
    const { bytes } = await build.buildBackupPackage(bundle);

    const entries = unzipSync(bytes);
    delete entries['history/conversations.json'];
    delete entries['history/messages.json'];
    delete entries['history/chapter-chat.json'];
    for (const chapterPath of Object.keys(entries).filter(path =>
      path.startsWith('chapters/') && path.endsWith('.json')
    )) {
      const chapter = JSON.parse(strFromU8(entries[chapterPath])) as Record<string, unknown>;
      delete chapter.processingStatus;
      entries[chapterPath] = new TextEncoder().encode(JSON.stringify(chapter));
    }
    const novel = JSON.parse(strFromU8(entries['novel.json'])) as Record<string, unknown>;
    delete novel.volumeSummaries;
    entries['novel.json'] = new TextEncoder().encode(JSON.stringify(novel, null, 2));

    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
      formatVersion: string;
      counts: Record<string, number>;
      sha256: Record<string, string>;
    };
    manifest.formatVersion = '1.0';
    delete manifest.counts.conversations;
    delete manifest.counts.messages;
    delete manifest.counts.chapterChat;
    delete manifest.sha256['history/conversations.json'];
    delete manifest.sha256['history/messages.json'];
    delete manifest.sha256['history/chapter-chat.json'];
    // Re-hash the legacy payloads after removing newer fields.
    const { sha256Hex } = await import('@/lib/backup/build-package');
    manifest.sha256['novel.json'] = await sha256Hex(entries['novel.json']);
    for (const chapterPath of Object.keys(entries).filter(path =>
      path.startsWith('chapters/') && path.endsWith('.json')
    )) {
      manifest.sha256[chapterPath] = await sha256Hex(entries[chapterPath]);
    }
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    const { zipSync } = await import('fflate');
    const v10Bytes = zipSync(entries, { level: 6 });

    const report = await verify.verifyBackupPackage(v10Bytes);
    expect(report.formatCompatible).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.warnings.filter(w => w.code === 'count_mismatch')).toHaveLength(0);
    expect(report.bundle!.conversations).toEqual([]);
    expect(report.bundle!.messages).toEqual([]);
    expect(report.bundle!.chapterChat).toEqual([]);
    expect(report.bundle!.novel.volumeSummaries).toEqual([]);

    const result = await restore.restoreBundleAsCopy(report.bundle!);
    expect(await db.getVolumeSummaries(result.novelId)).toEqual([]);
    const gdb = connection.getDb();
    expect(
      (gdb.prepare('SELECT COUNT(*) AS n FROM conversations WHERE novel_id = ?').get(result.novelId) as { n: number }).n,
    ).toBe(0);
    expect(
      (gdb.prepare('SELECT COUNT(*) AS n FROM messages WHERE novel_id = ?').get(result.novelId) as { n: number }).n,
    ).toBe(0);
    expect(
      (gdb.prepare('SELECT COUNT(*) AS n FROM chapter_chat_history WHERE novel_id = ?').get(result.novelId) as { n: number }).n,
    ).toBe(0);
    expect((await db.getNovel(result.novelId))?.title).toBe('Backup Source');
  });
});

describe('verify — ZIP resource guard', () => {
  it('rejects a valid backup whose local and central headers conceal oversized DEFLATE output', async () => {
    const { db, extract, build, verify } = await mods();
    const novel = await db.createNovel({
      userId: LOCAL_USER_ID,
      title: 'Concealed ZIP bomb',
    });
    const packaged = await build.buildBackupPackage(
      await extract.extractBackupBundle(novel.id),
    );
    const entries = unzipSync(packaged.bytes);
    const concealed = compressedZeroPayload(64 * 1024 * 1024 + 1);

    // fflate trusts the declared 1-byte output buffer and truncates the real
    // stream to one zero byte. Give that unsafe legacy result a valid package
    // checksum so only the ZIP resource guard can reject the archive.
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
      sha256: Record<string, string>;
    };
    manifest.sha256['bomb.bin'] = await build.sha256Hex(new Uint8Array([0]));
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));

    const bytes = craftStoredZip([
      ...Object.entries(entries).map(([name, data]) => ({ name, data })),
      {
        name: 'bomb.bin',
        data: concealed.data,
        declaredUncompressedSize: 1,
        method: 8 as const,
        crc: concealed.crc,
      },
    ]);
    expect(bytes.byteLength).toBeLessThan(100_000);

    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'zip_entry_too_large',
      ref: 'bomb.bin',
    }));
    expect(report.bundle).toBeNull();
  });

  it('rejects a checksum-valid package when DEFLATE output length contradicts both headers', async () => {
    const { db, extract, build, verify } = await mods();
    const novel = await db.createNovel({
      userId: LOCAL_USER_ID,
      title: 'Concealed ZIP length',
    });
    const packaged = await build.buildBackupPackage(
      await extract.extractBackupBundle(novel.id),
    );
    const entries = unzipSync(packaged.bytes);
    const concealed = compressedZeroPayload(1024);
    const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
      sha256: Record<string, string>;
    };
    manifest.sha256['concealed.bin'] = await build.sha256Hex(new Uint8Array([0]));
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));

    const report = await verify.verifyBackupPackage(craftStoredZip([
      ...Object.entries(entries).map(([name, data]) => ({ name, data })),
      {
        name: 'concealed.bin',
        data: concealed.data,
        declaredUncompressedSize: 1,
        method: 8 as const,
        crc: concealed.crc,
      },
    ]));

    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'not_a_zip' }));
    expect(report.bundle).toBeNull();
  });

  it('rejects a package whose local and central CRC agree but do not match the payload', async () => {
    const { db, extract, build, verify } = await mods();
    const novel = await db.createNovel({
      userId: LOCAL_USER_ID,
      title: 'Invalid ZIP CRC',
    });
    const packaged = await build.buildBackupPackage(
      await extract.extractBackupBundle(novel.id),
    );
    const entries = unzipSync(packaged.bytes);
    const wrongCrc = (crc32(entries['manifest.json']) ^ 1) >>> 0;

    const report = await verify.verifyBackupPackage(craftStoredZip(
      Object.entries(entries).map(([name, data]) => ({
        name,
        data,
        crc: name === 'manifest.json' ? wrongCrc : undefined,
      })),
    ));

    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'not_a_zip' }));
    expect(report.bundle).toBeNull();
  });

  it('accepts a valid backup written with signed data descriptors', async () => {
    const { db, extract, build, verify } = await mods();
    const novel = await db.createNovel({
      userId: LOCAL_USER_ID,
      title: 'Streamed backup',
    });
    const packaged = await build.buildBackupPackage(
      await extract.extractBackupBundle(novel.id),
    );
    const bytes = zipWithDataDescriptors(unzipSync(packaged.bytes));
    expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(6, true) & 0x0008)
      .toBe(0x0008);

    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.bundle?.novel.title).toBe('Streamed backup');
  });

  it('rejects archives that exceed the entry-count hard limit', async () => {
    const { verify } = await mods();
    const files: Record<string, Uint8Array> = {};
    const payload = new TextEncoder().encode('x');
    for (let i = 0; i < 4097; i++) {
      files[`e${String(i).padStart(5, '0')}.txt`] = payload;
    }
    const { zipSync } = await import('fflate');
    const report = await verify.verifyBackupPackage(zipSync(files, { level: 0 }));
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'zip_too_many_entries' }));
    expect(report.bundle).toBeNull();
  });

  it('rejects an oversized deflate entry before attempting its invalid compressed stream', async () => {
    const { verify } = await mods();
    const bytes = craftStoredZip([{
      name: 'huge.bin',
      // Deliberately invalid DEFLATE. A post-decompression size check would
      // first hit this bad stream and return not_a_zip; the metadata filter
      // must refuse it as too large before inflate is attempted.
      data: new Uint8Array([0xff]),
      declaredUncompressedSize: 64 * 1024 * 1024 + 1,
      method: 8,
    }]);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'zip_entry_too_large',
      ref: 'huge.bin',
    }));
  });

  it('rejects archives whose total declared uncompressed size exceeds 256 MiB', async () => {
    const { verify } = await mods();
    const perEntry = 64 * 1024 * 1024;
    const bytes = craftStoredZip([
      { name: 'a.bin', data: new Uint8Array([1]), declaredUncompressedSize: perEntry, method: 8 },
      { name: 'b.bin', data: new Uint8Array([2]), declaredUncompressedSize: perEntry, method: 8 },
      { name: 'c.bin', data: new Uint8Array([3]), declaredUncompressedSize: perEntry, method: 8 },
      { name: 'd.bin', data: new Uint8Array([4]), declaredUncompressedSize: perEntry, method: 8 },
      { name: 'e.bin', data: new Uint8Array([5]), declaredUncompressedSize: 1, method: 8 },
    ]);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'zip_total_too_large' }));
  });

  it('stops when actual DEFLATE output exceeds the total cap despite legal declared metadata', async () => {
    const { verify } = await mods();
    const perEntry = 64 * 1024 * 1024;
    const full = compressedZeroPayload(perEntry);
    const oneByte = compressedZeroPayload(1);
    const bytes = craftStoredZip([
      ...['a.bin', 'b.bin', 'c.bin', 'd.bin'].map(name => ({
        name,
        data: full.data,
        declaredUncompressedSize: perEntry,
        method: 8 as const,
        crc: full.crc,
      })),
      {
        name: 'overflow.bin',
        data: oneByte.data,
        // The declared aggregate is exactly 256 MiB. Only measured output can
        // reveal this final byte crossing the archive-wide budget.
        declaredUncompressedSize: 0,
        method: 8 as const,
        crc: oneByte.crc,
      },
    ]);
    expect(bytes.byteLength).toBeLessThan(300_000);

    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'zip_total_too_large',
      ref: 'overflow.bin',
    }));
    expect(report.bundle).toBeNull();
  });

  it('rejects duplicate entry names when constructible', async () => {
    const { verify } = await mods();
    const bytes = craftStoredZip([
      { name: 'dup.txt', data: new TextEncoder().encode('one') },
      { name: 'dup.txt', data: new TextEncoder().encode('two') },
    ]);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'zip_duplicate_name',
      ref: 'dup.txt',
    }));
  });

  it('rejects unsafe archive entry names', async () => {
    const { verify } = await mods();
    const { zipSync } = await import('fflate');
    const cases: Array<{ name: string; label: string }> = [
      { name: '/abs.json', label: 'absolute' },
      { name: 'foo\\bar.json', label: 'backslash' },
      { name: 'evil\0.json', label: 'nul' },
      { name: 'a/../b.json', label: 'dot-dot' },
      { name: 'a/./b.json', label: 'dot' },
    ];
    for (const c of cases) {
      const report = await verify.verifyBackupPackage(
        zipSync({ [c.name]: new TextEncoder().encode('{}') }, { level: 0 }),
      );
      expect(report.ok, c.label).toBe(false);
      expect(report.errors, c.label).toContainEqual(expect.objectContaining({
        code: 'zip_unsafe_path',
        ref: c.name,
      }));
    }
  });
});

/** Minimal ZIP so central-directory sizes/methods can be controlled precisely. */
function craftStoredZip(
  files: Array<{
    name: string;
    data: Uint8Array;
    declaredUncompressedSize?: number;
    method?: 0 | 8;
    crc?: number;
  }>,
): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const data = file.data;
    const declared = file.declaredUncompressedSize ?? data.length;
    const method = file.method ?? 0;
    const checksum = file.crc ?? (method === 0 ? crc32(data) : 0);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, declared, true); // uncompressed size (may be lied)
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, declared, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const part of centralParts) centralSize += part.length;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let o = 0;
  for (const part of localParts) {
    out.set(part, o);
    o += part.length;
  }
  for (const part of centralParts) {
    out.set(part, o);
    o += part.length;
  }
  out.set(end, o);
  return out;
}

function compressedZeroPayload(size: number): { data: Uint8Array; crc: number } {
  const payload = Buffer.alloc(size);
  return {
    data: deflateRawSync(payload, { level: 9 }),
    crc: crc32(payload),
  };
}

function zipWithDataDescriptors(entries: Record<string, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let archiveError: Error | null = null;
  const archive = new Zip((error, chunk) => {
    if (error) {
      archiveError = error;
      return;
    }
    chunks.push(chunk);
  });
  for (const [name, bytes] of Object.entries(entries)) {
    const entry = new ZipDeflate(name, { level: 6 });
    archive.add(entry);
    entry.push(bytes, true);
  }
  archive.end();
  if (archiveError) throw archiveError;

  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
