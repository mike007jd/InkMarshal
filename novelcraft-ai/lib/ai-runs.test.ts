import { describe, expect, it } from 'vitest';

import { classifyOutcome, estimateCostUsd, type ModelPricing } from './ai-runs';

const PRICING: ModelPricing = { inputPerMTokUsd: 3, outputPerMTokUsd: 15 };

describe('estimateCostUsd', () => {
  it('local engines always cost 0, even with a (irrelevant) price on file', () => {
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, PRICING, 'local')).toBe(0);
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, null, 'local')).toBe(0);
    expect(estimateCostUsd(undefined, null, 'local')).toBe(0);
  });

  it('priced provider call charges input + output per million tokens', () => {
    // 1M input @ $3 + 1M output @ $15 = $18.
    expect(
      estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, PRICING, 'provider'),
    ).toBeCloseTo(18, 6);
    // 500k input @ $3 + 200k output @ $15 = $1.5 + $3 = $4.5.
    expect(
      estimateCostUsd({ inputTokens: 500_000, outputTokens: 200_000 }, PRICING, 'provider'),
    ).toBeCloseTo(4.5, 6);
  });

  it('a custom (BYOK) call with a price is charged too', () => {
    expect(
      estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, PRICING, 'custom'),
    ).toBeCloseTo(3, 6);
  });

  it('missing price on a non-local call returns null (unknown), NOT 0', () => {
    expect(estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, null, 'provider')).toBeNull();
    expect(
      estimateCostUsd({ inputTokens: 1000, outputTokens: 1000 }, undefined, 'custom'),
    ).toBeNull();
    // Unknown connection kind is also treated as non-local → unknown without price.
    expect(estimateCostUsd({ inputTokens: 1000 }, null, null)).toBeNull();
  });

  it('treats missing token counts as 0 — a partial usage payload is still honest', () => {
    // Only output reported: 1M output @ $15.
    expect(estimateCostUsd({ outputTokens: 1_000_000 }, PRICING, 'provider')).toBeCloseTo(15, 6);
    // Empty usage but a price → $0 (no tokens billed), not null.
    expect(estimateCostUsd({}, PRICING, 'provider')).toBe(0);
    expect(estimateCostUsd(undefined, PRICING, 'provider')).toBe(0);
  });
});

describe('classifyOutcome', () => {
  it('cancellation wins over everything (even a finishReason)', () => {
    expect(classifyOutcome({ cancelled: true })).toBe('cancelled');
    expect(classifyOutcome({ cancelled: true, error: true, finishReason: 'length' })).toBe(
      'cancelled',
    );
  });

  it('an error (not cancelled) is failed', () => {
    expect(classifyOutcome({ error: true })).toBe('failed');
    expect(classifyOutcome({ error: true, finishReason: 'stop' })).toBe('failed');
  });

  it('a length / max-token stop is truncated', () => {
    expect(classifyOutcome({ finishReason: 'length' })).toBe('truncated');
    expect(classifyOutcome({ finishReason: 'max_tokens' })).toBe('truncated');
    expect(classifyOutcome({ finishReason: 'MAX-TOKENS' })).toBe('truncated');
  });

  it('a normal stop / absent reason is success', () => {
    expect(classifyOutcome({ finishReason: 'stop' })).toBe('success');
    expect(classifyOutcome({})).toBe('success');
    expect(classifyOutcome({ finishReason: undefined })).toBe('success');
  });

  it('covers all four terminal states', () => {
    const states = new Set([
      classifyOutcome({}),
      classifyOutcome({ finishReason: 'length' }),
      classifyOutcome({ error: true }),
      classifyOutcome({ cancelled: true }),
    ]);
    expect(states).toEqual(new Set(['success', 'truncated', 'failed', 'cancelled']));
  });
});
