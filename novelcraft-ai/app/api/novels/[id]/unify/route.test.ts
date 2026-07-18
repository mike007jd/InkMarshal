import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('unify route model context budgeting', () => {
  it('sizes unification context with the selected unify runtime window', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/unify/route.ts'), 'utf8');

    expect(source).toContain("operation: 'unify'");
    expect(source).toContain('unifyContextWindow = unifyPreflightUsage.runtimeModel.contextWindow');
    expect(source).not.toContain('await unifyPreflightUsage.settle()');
    expect(source).toContain('modelCtxTokens: unifyContextWindow');
    expect(source).toContain('embeddingHint: resolveEmbeddingEndpointFromRequest(request)');
  });

  it('settles each unification batch usage at most once', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/unify/route.ts'), 'utf8');
    const persistIndex = source.indexOf('await persistUnificationReportWithMessage(id, report, finalMsg);');
    const recordPendingIndex = source.indexOf('await pendingUsage.recordUsage();');

    expect(source).toContain('const failUsageOnce = async () => {');
    expect(source).toContain('const failPendingBatchUsages = async () => {');
    expect(source).toContain('const cancelPendingBatchUsages = async () => {');
    expect(source).toContain('pendingBatchUsages.push({');
    expect(source).toContain('await failPendingBatchUsages();\n          throw error;');
    expect(source).not.toContain("await addMessage(id, 'assistant', finalMsg);");
    expect(source).not.toContain('await updateNovel(id, { unificationReport: report });');
    expect(persistIndex).toBeGreaterThan(-1);
    expect(recordPendingIndex).toBeGreaterThan(persistIndex);
    expect(source).toContain('await cancelUsageOnce();\n              await cancelPendingBatchUsages();');
    expect(source).toContain('if (lockLost) await failPendingBatchUsages();\n          else await cancelPendingBatchUsages();');
  });

  it('acquires the writing lock before reading chapters and building the scan context', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/unify/route.ts'), 'utf8');
    const lockIndex = source.indexOf('const lock = await acquireWritingLock(id, LOCK_TTL_SEC);');
    const refetchIndex = source.indexOf('const currentNovel = await getNovel(id);');
    const chaptersIndex = source.indexOf('const chapters = await getChapters(id);');
    const promptIndex = source.indexOf('const promptResult = await buildNovelSystemPromptFromDB(');
    const transferIndex = source.indexOf('lockTransferredToStream = true;');
    const earlyReleaseIndex = source.indexOf('if (!lockTransferredToStream) {');

    expect(lockIndex).toBeGreaterThan(-1);
    expect(refetchIndex).toBeGreaterThan(lockIndex);
    expect(chaptersIndex).toBeGreaterThan(refetchIndex);
    expect(promptIndex).toBeGreaterThan(chaptersIndex);
    expect(source).toContain('currentNovel.userId !== user.id');
    expect(source).toContain('novelContext: currentNovel');
    expect(transferIndex).toBeGreaterThan(promptIndex);
    expect(earlyReleaseIndex).toBeGreaterThan(transferIndex);
  });

  it('renews the writing lock during the long-running scan and before persisting the report', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/unify/route.ts'), 'utf8');
    const renewImport = source.indexOf('renewWritingLock,');
    const renewHelper = source.indexOf('const renewLock = async (): Promise<boolean> => {');
    const intervalIndex = source.indexOf('const lockRenewal = setInterval(() => {');
    const batchLoop = source.indexOf('for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {');
    const batchRenew = source.indexOf('if (!(await renewLock())) {', batchLoop);
    const reportIndex = source.indexOf('const report = createUnificationReport({ edits: mergedEdits, summaries, modelId });');
    const persistRenew = source.indexOf('if (!(await renewLock())) {', reportIndex);
    const persistIndex = source.indexOf('await persistUnificationReportWithMessage(id, report, finalMsg);');
    const clearIntervalIndex = source.indexOf('clearInterval(lockRenewal);');

    expect(renewImport).toBeGreaterThan(-1);
    expect(renewHelper).toBeGreaterThan(-1);
    expect(source).toContain('const newExpiry = await renewWritingLock(id, lock.token, LOCK_TTL_SEC);');
    expect(source).toContain("reason: 'lock_lost_during_unification'");
    expect(intervalIndex).toBeGreaterThan(renewHelper);
    expect(batchRenew).toBeGreaterThan(batchLoop);
    expect(persistRenew).toBeGreaterThan(reportIndex);
    expect(persistIndex).toBeGreaterThan(persistRenew);
    expect(clearIntervalIndex).toBeGreaterThan(intervalIndex);
  });

  it('awaits writing lock release when the unification stream is cancelled', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/novels/[id]/unify/route.ts'), 'utf8');
    const helperIndex = source.indexOf('const releaseStreamLockOnce = () => {');
    const finallyIndex = source.indexOf('await releaseStreamLockOnce().catch(() => undefined);', helperIndex);
    const cancelIndex = source.indexOf('async cancel() {');
    const cancelReleaseIndex = source.indexOf('await releaseStreamLockOnce();', cancelIndex);

    expect(helperIndex).toBeGreaterThan(-1);
    expect(source).toContain('streamLockReleasePromise ??= releaseWritingLock(id, lock.token);');
    expect(finallyIndex).toBeGreaterThan(helperIndex);
    expect(cancelIndex).toBeGreaterThan(finallyIndex);
    expect(cancelReleaseIndex).toBeGreaterThan(cancelIndex);
    expect(source).not.toContain('cancel() {\n        lifecycle.cancel();\n      }');
  });
});
