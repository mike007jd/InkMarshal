import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseBlueprintFromChapter } from './route';

describe('blueprint regenerate query parsing', () => {
  it('accepts absent or strict fromChapter values only', () => {
    expect(parseBlueprintFromChapter(new URLSearchParams(''))).toBeNull();
    expect(parseBlueprintFromChapter(new URLSearchParams('fromChapter=2'))).toBe(2);
    expect(parseBlueprintFromChapter(new URLSearchParams('fromChapter=02'))).toBe(2);
    expect(parseBlueprintFromChapter(new URLSearchParams('fromChapter=1'))).toEqual({
      error: 'fromChapter must be an integer >= 2. For a full rewrite, omit the parameter (only allowed when no chapters exist yet).',
    });
    expect(parseBlueprintFromChapter(new URLSearchParams('fromChapter=2abc'))).toEqual({
      error: 'fromChapter must be an integer >= 2. For a full rewrite, omit the parameter (only allowed when no chapters exist yet).',
    });
  });

  it('sizes blueprint context with the selected outline runtime window', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/blueprint/regenerate/route.ts'), 'utf8');

    expect(source).toContain("createAIUsageSession(request, { userId: user.id, operation: 'outline' })");
    expect(source).toContain("modelCtxTokens: usage.runtimeModel.contextWindow");
    expect(source).toContain("embeddingHint: resolveEmbeddingEndpointFromRequest(request)");
    expect(source).toContain("await usage.fail();\n        return NextResponse.json({ error: 'Novel not found' }, { status: 404 });");
    expect(source).toContain('let usageSettled = false;');
    expect(source.indexOf('await usage.recordUsage(result.usage);')).toBeGreaterThan(
      source.indexOf('await setNovelBlueprint(id, blueprint);'),
    );
    expect(source.indexOf('await usage.recordUsage(result.usage);')).toBeGreaterThan(
      source.indexOf('await setNovelBlueprintAfterDeletingChaptersFrom(id, blueprint, fromChapter);'),
    );
    expect(source).not.toContain('await deleteChaptersFrom(id, fromChapter);');
    expect(source).not.toContain('clearNovelBlueprint');
    expect(source).toContain('await failUsageOnce();\n      throw err;');
  });

  it('rechecks mutable novel stage and chapter state after acquiring the writing lock', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/blueprint/regenerate/route.ts'), 'utf8');
    const lockIndex = source.indexOf('const lock = await acquireWritingLock(id, LOCK_TTL_SEC);');
    const refetchNovelIndex = source.indexOf('const currentNovel = await getNovel(id);');
    const stageCheckIndex = source.indexOf('if (!isInStages(currentNovel.stage, STAGES_THAT_CAN_REGENERATE_BLUEPRINT))');
    const chaptersIndex = source.indexOf('const chapters = await getChaptersLite(id);');
    const existingBlueprintIndex = source.indexOf('existingBlueprint = await getNovelBlueprint(id);');
    const promptIndex = source.indexOf('buildNovelSystemPromptFromDB(\n        id,\n        locale,\n        currentNovel,');

    expect(refetchNovelIndex).toBeGreaterThan(lockIndex);
    expect(stageCheckIndex).toBeGreaterThan(refetchNovelIndex);
    expect(chaptersIndex).toBeGreaterThan(stageCheckIndex);
    expect(existingBlueprintIndex).toBeGreaterThan(chaptersIndex);
    expect(promptIndex).toBeGreaterThan(chaptersIndex);
    expect(source).toContain('novelContext: currentNovel');
  });
});
