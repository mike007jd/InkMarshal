import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const readComponent = (name: string) => readFileSync(join(process.cwd(), 'components', name), 'utf8');

describe('autonomous writing start preview', () => {
  it('opens before the greenlight action starts writing', () => {
    const pill = readComponent('StageActionPill.tsx');
    expect(pill).toContain('onClick={() => setStartPreviewOpen(true)}');
    expect(pill).toContain('<WritingStartPreviewDialog');
    expect(pill).toContain('onStart={onStartWriting}');
  });

  it('shows exact planning/drafting bindings and honest time/cost states', () => {
    const preview = readComponent('WritingStartPreviewDialog.tsx');
    expect(preview).toContain("useCapabilityBinding('outline')");
    expect(preview).toContain("useCapabilityBinding('chapter')");
    expect(preview).toContain('resolved.binding.modelId');
    expect(preview).toContain('isOnDeviceRuntimeConnection');
    expect(preview).toContain('resolvePricing');
    expect(preview).toContain('writingPreviewCostUnknown');
    expect(preview).toContain('writingPreviewCostLocal');
    expect(preview).toContain('writingPreviewScope.replace');
  });
});
