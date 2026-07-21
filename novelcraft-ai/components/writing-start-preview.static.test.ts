import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readComponent = (name: string) => readFileSync(join(process.cwd(), 'components', name), 'utf8');

describe('autonomous writing start preview', () => {
  it('starts writing directly from the greenlight action — no hidden popover, no second confirmation', () => {
    const bar = readComponent('StageBar.tsx');
    const workspace = readComponent('NovelWorkspace.tsx');
    expect(bar).toContain('onClick={onApprove}');
    expect(bar).not.toContain('Popover');
    expect(bar).not.toContain('WritingStartPreviewDialog');
    expect(workspace).toContain('onApprove={handleStartWriting}');
  });

  it('keeps the shared run-details preview honest about models and cost', () => {
    const preview = readComponent('ProposalReviewPanel.tsx');
    expect(preview).toContain("useCapabilityBinding('outline')");
    expect(preview).toContain("useCapabilityBinding('chapter')");
    expect(preview).toContain('resolved.binding.modelId');
    expect(preview).toContain('isOnDeviceRuntimeConnection');
    expect(preview).toContain('resolvePricing');
    expect(preview).toContain('writingPreviewCostUnknown');
    expect(preview).toContain('writingPreviewCostLocal');
    expect(preview).toContain('targetWords: novel.targetWords');
  });
});
