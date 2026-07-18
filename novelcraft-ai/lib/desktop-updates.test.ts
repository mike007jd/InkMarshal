import { describe, expect, it } from 'vitest';

import { isCriticalDesktopUpdate, updateProgressPercent } from './desktop-updates';

describe('desktop update metadata', () => {
  it('escalates only a literal critical boolean', () => {
    expect(isCriticalDesktopUpdate({ rawJson: { critical: true } })).toBe(true);
    expect(isCriticalDesktopUpdate({ rawJson: { critical: 'true' } })).toBe(false);
    expect(isCriticalDesktopUpdate({ rawJson: {} })).toBe(false);
  });

  it('reports bounded download progress and tolerates unknown totals', () => {
    expect(updateProgressPercent(50, 200)).toBe(25);
    expect(updateProgressPercent(300, 200)).toBe(100);
    expect(updateProgressPercent(10)).toBeNull();
  });
});
