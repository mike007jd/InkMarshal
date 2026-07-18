import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('UnificationPanel parent refresh contract', () => {
  it('refreshes the parent novel after persisted scan and apply mutations', () => {
    const panel = source('components/UnificationPanel.tsx');

    const doneIndex = panel.indexOf("if (evt.type === 'done' && evt.report)");
    const setReportIndex = panel.indexOf('setReport(nextReport);', doneIndex);
    const completeAfterScanIndex = panel.indexOf('onComplete?.();', setReportIndex);
    const applyIndex = panel.indexOf("const r = await fetch(`/api/novels/${requestNovelId}/unify/apply`");
    const appliedIndex = panel.indexOf('onApplied?.();', applyIndex);
    const completeAfterApplyIndex = panel.indexOf('onComplete?.();', appliedIndex);

    expect(doneIndex).toBeGreaterThan(-1);
    expect(setReportIndex).toBeGreaterThan(doneIndex);
    expect(completeAfterScanIndex).toBeGreaterThan(setReportIndex);
    expect(applyIndex).toBeGreaterThan(-1);
    expect(appliedIndex).toBeGreaterThan(applyIndex);
    expect(completeAfterApplyIndex).toBeGreaterThan(appliedIndex);
    expect(panel).not.toContain('if (nextReport.edits.every(e => e.applied || e.skipped)) onComplete?.();');
    expect(panel).not.toContain('if (data.allDone) onComplete?.();');
  });
});
